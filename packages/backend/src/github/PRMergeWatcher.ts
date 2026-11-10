import { EventEmitter } from 'events';
import type { GitHubClient } from './GitHubClient';
import type { MergeabilityCategory, FailingCheck } from './types';
import { GitHubRateLimitError } from './types';
import {
  isGitHubRateLimitActive,
  recordGitHubRateLimit,
} from './rateLimitBackoff';
import type { SessionManager } from '../session/SessionManager';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import { getProjectByGithubRepo, AUTO_REVIEW_ENABLED } from '../config';
import type { Scheduler } from '../orchestration/Scheduler';
import { typedGetSetting } from '../config/settings';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import { loadAutofixCommands, runAutofix } from '../session/autofix-runner';
import { withdrawQueuedRunsForWorktree } from '../orchestration/testRequestLane';
import { filterBaseAttributableFailuresForF2Gate } from '../orchestration/baseAttributableFilter';
import { recordEvent } from '../audit/AuditLog';
import { yieldToEventLoop } from '../utils/concurrency';
import { closeFlakyRemediationTaskIfLinked } from '../audit/flakyRemediationFiling';
import type { ServerMessage } from '../ws/types';
import type { PullRequestRow } from '../db/types';
import {
  parsePauseReason,
  parsePauseReasonSet,
  findAutomaticGateRecoveryEntry,
} from '../db/pauseReason';
import type { AutoMerger } from './AutoMerger';
import type { ReviewOrchestrator } from './ReviewOrchestrator';
import { formatCIFailureFeedback, shouldAutoReview } from './reviewUtils';
import { sendConflictNudge } from './conflictNudge';
import { isTerminalStalePR } from './pollUtils';
import {
  getAllOpenPRs,
  updatePRState,
  updateMergeState,
  getPRByNumber,
  getApprovedDraftPRs,
  updatePRDraftStatus,
  setPauseReason,
  setCiRemediationAttemptedSha,
  getSession,
  addAutofixSha,
  consumeAutofixSha,
  deleteAllAutofixShasForPR,
  setHeadSha,
  setPendingPush,
  markSessionDone,
  updateSessionStatus,
  setSessionTerminalCompletionReason,
  recordPrAnchoredCompletingSignal,
  clearTerminalPRFlags,
  setHeadBranch,
  clearSessionInitiatedPRClose,
  resetFlakeRecoveryAttempts,
  recordMergeCommitForSession,
  getLatestTestRequestRunForSession,
  updateTestRequestRunState,
  clearTaskExecuteNow,
} from '../db/queries';
import { emitTaskUpdated } from '../routes/tasks';
import { logger } from '../logger';

/**
 * Emitted by PRMergeWatcher.handleMerged once a merge commit has been
 * resolved and persisted — the orchestrator-internal "task X merged (commit
 * Y)" signal. Consumer-agnostic: subscribe via `.on('merge_completed', ...)`.
 * Delivery is fire-and-forget; a missed event must be caught up by the
 * consumer reconciling against local_branches/pull_requests state.
 */
export interface MergeCompletedPayload {
  notion_task_id: string;
  merge_commit: string;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BEHIND_RECHECK_DELAY_MS = 60_000;
/**
 * Cadence for the escalated-open stale sweep — deliberately slower than the
 * 5-minute merge poll, since a stale escalated row is cosmetic-but-misleading
 * (dashboard "needs attention" noise), not urgent.
 */
const STALE_OPEN_SWEEP_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Pause reasons where mergeability polling is pointless — AutoMerger has given
 * up or the PR is blocked on human intervention. Checking GitHub's merge state
 * every cycle wastes quota without any possibility of changing the outcome.
 *
 * Deliberately excludes the reconcile_exhausted flag (the retired
 * stalled_reconcile_cap reason's replacement): that flag is scoped to
 * StalledPRReconciler's own re-drive decision and PRMergeWatcher's
 * GitHub-quota-conserving polling skip (see pollUtils.isTerminalStalePR) —
 * it must never suppress this function's own F2-gate CI-failure detection
 * in runMergeabilityCheck, which is the mechanism that previously discarded
 * a live cause (e.g. verify_failed) for an already-escalated PR.
 */
const TERMINAL_MERGE_PAUSE_REASONS: ReadonlySet<string> = new Set([
  'auto_merge_failed',
  'max_reviews',
  'review_failed',
  'pr_body_invalid',
  'attribution_missing',
  'merge_conflict',
]);

function isTerminalMergePause(pauseReasonRaw: string | null): boolean {
  if (pauseReasonRaw === null) return false;
  const parsed = parsePauseReason(pauseReasonRaw);
  return parsed !== null && TERMINAL_MERGE_PAUSE_REASONS.has(parsed.reason);
}

/**
 * Session statuses that mean the coding session is done for good — it can
 * never itself reopen the PR. Anything else (running, starting, idle) is
 * "non-terminal" for the purpose of deferring a session-initiated PR close.
 */
const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'error',
  'killed',
  'superseded',
]);

function isSessionTerminal(status: string | null | undefined): boolean {
  return status != null && TERMINAL_SESSION_STATUSES.has(status);
}

export class PRMergeWatcher extends EventEmitter {
  /**
   * True until the first poll after boot completes. On that first poll, PRs
   * that GitHub reports as already merged are state-transitioned in SQLite
   * without emitting pr_merged — otherwise a backend restart re-fires merge
   * notifications for every PR that closed while the backend was down.
   */
  private firstPollPending = true;
  private autoMerger: AutoMerger | undefined;
  private reviewOrchestrator: ReviewOrchestrator | undefined;
  constructor(
    private github: GitHubClient,
    private sessions: SessionManager,
    /**
     * Optional fixed task backend. When provided (typically by tests), all status
     * updates go through it. In production this is left undefined and the backend
     * is resolved per-call via getTaskBackend(project.id).
     */
    private taskBackendOverride: TaskBackend | undefined,
    private broadcast: (msg: ServerMessage) => void,
  ) {
    super();
  }

  setAutoMerger(autoMerger: AutoMerger): void {
    this.autoMerger = autoMerger;
  }

  setReviewOrchestrator(ro: ReviewOrchestrator): void {
    this.reviewOrchestrator = ro;
  }

  private getMaxReviewIterations(): number {
    return typedGetSetting('max_review_iterations');
  }

  private resolveBackendForRepo(repo: string): TaskBackend | undefined {
    if (this.taskBackendOverride) return this.taskBackendOverride;
    const project = getProjectByGithubRepo(repo);
    if (!project) {
      logger.warn(
        `[PRMergeWatcher] no project found for repo ${repo} — skipping task backend update`,
      );
      return undefined;
    }
    return getTaskBackend(project.id);
  }

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'pr_merge_watcher',
      intervalMs: () => DEFAULT_INTERVAL_MS,
      runOnBoot: true,
      concurrency: 'skip-if-running',
      // poll() is a pure reader of settled test verdicts now — it never
      // awaits a test execution (see runMergeabilityCheck) — so a real
      // overrun is a genuine fault again. Sized to the poll interval
      // rather than DEFAULT_JOB_TIMEOUT_MS.
      timeoutMs: DEFAULT_INTERVAL_MS,
      run: async ({ signal }) => {
        await this.poll(signal);
      },
      onError: (err: unknown) =>
        logger.warn('[PRMergeWatcher] poll error:', (err as Error).message),
    });
    scheduler.register({
      name: 'pr_merge_watcher_stale_open_sweep',
      intervalMs: () => STALE_OPEN_SWEEP_INTERVAL_MS,
      runOnBoot: true,
      concurrency: 'skip-if-running',
      run: async () => {
        const items_processed = await this.sweepEscalatedStalePRs();
        return { items_processed };
      },
      onError: (err: unknown) =>
        logger.warn(
          '[PRMergeWatcher] stale-open sweep error:',
          (err as Error).message,
        ),
    });
    scheduler.register({
      name: 'pr_merge_watcher_draft_ready_sweep',
      intervalMs: () => STALE_OPEN_SWEEP_INTERVAL_MS,
      runOnBoot: true,
      concurrency: 'skip-if-running',
      run: async () => {
        const items_processed = await this.sweepStuckDraftApprovedPRs();
        return { items_processed };
      },
      onError: (err: unknown) =>
        logger.warn(
          '[PRMergeWatcher] draft-ready sweep error:',
          (err as Error).message,
        ),
    });
  }

  /**
   * Retries the markPRReady GitHub call for PRs whose review verdict is
   * approved but that are still marked draft in our DB — the recovery path
   * for PRReviewService.handleApprovedVerdict's markPRReady call failing
   * (most commonly a quota 403). Without this sweep such a PR is stranded as
   * a draft forever even after its task has already moved on to review.
   */
  async sweepStuckDraftApprovedPRs(): Promise<number> {
    if (isGitHubRateLimitActive(this.broadcast)) return 0;
    const stuck = getApprovedDraftPRs();
    let items_processed = 0;
    for (const pr of stuck) {
      if (isGitHubRateLimitActive(this.broadcast)) break;
      try {
        await this.github.markPRReady(pr.repo, pr.pr_number);
        updatePRDraftStatus(pr.pr_number, pr.repo, 0);
        items_processed++;
        logger.info(
          `[PRMergeWatcher] draft-ready sweep: PR #${pr.pr_number} in ${pr.repo} transitioned out of draft`,
        );
      } catch (err) {
        if (err instanceof GitHubRateLimitError) {
          this.handleRateLimit(err);
          break;
        }
        logger.warn(
          `[PRMergeWatcher] draft-ready sweep: markPRReady failed for PR #${pr.pr_number}:`,
          (err as Error).message,
        );
      }
    }
    return items_processed;
  }

  /**
   * Targeted sweep over rows every scheduled loop otherwise skips forever:
   * every state='open' row for which isTerminalStalePR is true — not just
   * reconcile_exhausted rows, but also rows parked on an incomplete verdict
   * (unchanged head) or a verify_failed/autofix_failed verdict with no push
   * pending. Both poll() (via isTerminalStalePR) and StalledPRReconciler
   * deliberately skip these rows to stop per-PR GitHub churn on parked PRs,
   * but that means nothing ever re-queries GitHub for them — so a PR that
   * reaches merged or closed on GitHub while parked stays stuck at
   * state='open' forever, showing as a false "needs attention" entry.
   *
   * Filters the parked set in-code from getAllOpenPRs() rather than a
   * dedicated query, and calls getPRState() per-row — O(this orchestrator's
   * parked-open rows), never listOpenPRs(repo) (O(the repo's total open
   * PRs), which would paginate thousands of unrelated PRs on a busy repo).
   * A row still open on GitHub (e.g. a PR that's genuinely stuck) is left
   * untouched by reconcileTerminalState.
   *
   * A row still open is also run through runMergeabilityCheck, but only when
   * it's reconcile_exhausted: this is the only place anything ever
   * re-categorizes mergeability for an escalated row (poll() skips it via
   * isTerminalStalePR), so without this a PR that became mergeable while
   * escalated (e.g. #1449) would sit at a stale merge_state/mergeable
   * forever. runMergeabilityCheck no longer treats reconcile_exhausted as a
   * terminal pause at all (see TERMINAL_MERGE_PAUSE_REASONS), so this
   * refreshes observability columns and can re-drive AutoMerger.attempt() to
   * "consider" the row without clearing reconcile_exhausted itself. The
   * other two isTerminalStalePR anchors (incomplete/gate-failed verdicts)
   * are not run through runMergeabilityCheck here — they're parked on a
   * review verdict, not a merge-side reconciler cap, so mergeability
   * re-categorization isn't this sweep's job for them.
   */
  async sweepEscalatedStalePRs(): Promise<number> {
    const parked = getAllOpenPRs().filter((pr) => isTerminalStalePR(pr));
    let items_processed = 0;
    for (const pr of parked) {
      if (!getProjectByGithubRepo(pr.repo)) {
        logger.warn(
          `[PRMergeWatcher] stale-open sweep: PR #${pr.pr_number}: no project for repo ${pr.repo} — skipping`,
        );
        continue;
      }
      const state = await this.reconcileTerminalState(pr);
      if (state === 'open' && pr.reconcile_exhausted) {
        await this.runMergeabilityCheck(pr);
      }
      items_processed++;
    }
    return items_processed;
  }

  /**
   * Shared terminal-transition handler: queries GitHub for a PR's live state
   * and, if it has reached merged or closed, applies the transition
   * (handleMerged / updatePRState + clearTerminalPRFlags). Used by both the
   * escalated-open sweep above and the /api/prs panel-load reconciliation so
   * the two paths can't drift. A GitHub error is logged and the row is left
   * unchanged — never silently swallowed. Returns the observed state, or
   * null on error.
   */
  async reconcileTerminalState(pr: PullRequestRow): Promise<string | null> {
    let prStateResult: { state: string; headSha: string | null };
    try {
      prStateResult = await this.github.getPRState(pr.pr_number, pr.repo);
    } catch (err) {
      if (err instanceof GitHubRateLimitError) {
        this.handleRateLimit(err);
        return null;
      }
      logger.warn(
        `[PRMergeWatcher] reconcileTerminalState: getPRState failed for PR #${pr.pr_number}:`,
        (err as Error).message,
      );
      return null;
    }

    const { state } = prStateResult;
    if (state === 'merged') {
      await this.handleMerged(pr, null);
    } else if (state === 'closed') {
      updatePRState(pr.pr_number, pr.repo, 'closed');
      clearTerminalPRFlags(pr.pr_number, pr.repo, 'closed');
    }
    return state;
  }

  private handleRateLimit(err: GitHubRateLimitError): void {
    recordGitHubRateLimit(err, '[PRMergeWatcher]', this.broadcast);
  }

  async poll(signal?: AbortSignal): Promise<void> {
    if (isGitHubRateLimitActive(this.broadcast)) return;
    await this.sweepPendingPushDeadLetters();
    this.autoMerger?.clearStalePauses();
    const silentMerges = this.firstPollPending;
    const openPRs = getAllOpenPRs();

    // Group PRs by repo, skipping orphan repos that have no project mapping.
    // Orphan PRs produce 404s on every getPRState call and can never be actioned.
    const byRepo = new Map<string, PullRequestRow[]>();
    for (const pr of openPRs) {
      if (!getProjectByGithubRepo(pr.repo)) {
        logger.warn(
          `[PRMergeWatcher] PR #${pr.pr_number}: no project for repo ${pr.repo} — skipping poll`,
        );
        continue;
      }
      if (isTerminalStalePR(pr)) {
        logger.info(
          `[PRMergeWatcher] PR #${pr.pr_number}: parked with no incoming push — skipping poll (StalledPRReconciler handles re-drive)`,
        );
        continue;
      }
      const list = byRepo.get(pr.repo) ?? [];
      list.push(pr);
      byRepo.set(pr.repo, list);
    }

    for (const [repo, prs] of byRepo) {
      if (signal?.aborted) return;
      if (prs.length < 2) {
        // Single PR for this repo — individual fetch
        await this.checkPR(prs[0], silentMerges);
        continue;
      }

      // Multiple PRs for this repo — one batch list call replaces N getPRState calls.
      // PRs found in the batch are still open; absent PRs need individual confirmation.
      let batchStates: Map<number, { headSha: string | null }>;
      try {
        batchStates = await this.github.listOpenPRStates(repo);
      } catch (err) {
        if (err instanceof GitHubRateLimitError) {
          // A quota 403 on the batch call means the quota is exhausted, not
          // that this one call failed — fanning out into N individual calls
          // is the worst possible response. Back off and skip the repo.
          this.handleRateLimit(err);
          continue;
        }
        logger.warn(
          `[PRMergeWatcher] listOpenPRStates failed for ${repo}, falling back to individual:`,
          (err as Error).message,
        );
        for (const pr of prs) {
          if (isGitHubRateLimitActive(this.broadcast)) break;
          await this.checkPR(pr, silentMerges);
        }
        continue;
      }

      for (const pr of prs) {
        if (signal?.aborted) return;
        const batchEntry = batchStates.get(pr.pr_number);
        if (batchEntry) {
          // Still open — use batch headSha for push detection, skip getPRState
          await this.processOpenPR(pr, batchEntry.headSha);
        } else {
          // Absent from open list — closed or merged; individual call to confirm
          await this.checkPR(pr, silentMerges);
        }
      }
    }

    this.firstPollPending = false;
  }

  private async checkPR(
    pr: PullRequestRow,
    silentMerges: boolean,
  ): Promise<void> {
    let prStateResult: { state: string; headSha: string | null };
    try {
      prStateResult = await this.github.getPRState(pr.pr_number, pr.repo);
    } catch (err) {
      if (err instanceof GitHubRateLimitError) {
        this.handleRateLimit(err);
        return;
      }
      logger.warn(
        `[PRMergeWatcher] getPRState failed for PR #${pr.pr_number}:`,
        (err as Error).message,
      );
      return;
    }

    const { state, headSha: githubHeadSha } = prStateResult;

    if (state === 'merged') {
      await this.handleMerged(pr, null, { silent: silentMerges });
    } else if (state === 'closed') {
      if (this.shouldDeferSessionInitiatedClose(pr)) {
        logger.info(
          `[PRMergeWatcher] PR #${pr.pr_number}: session-initiated close detected, coding session ${pr.session_id} still active — deferring terminalization`,
        );
        return;
      }
      updatePRState(pr.pr_number, pr.repo, 'closed');
      clearTerminalPRFlags(pr.pr_number, pr.repo, 'closed');
      clearSessionInitiatedPRClose(pr.pr_number, pr.repo);
      deleteAllAutofixShasForPR(pr.pr_number, pr.repo);
      this.withdrawQueuedRunsForPR(pr, 'pr_closed');
      // Transition coding session idle → error on close-without-merge
      if (pr.session_id) {
        this.sessions.markSessionErrored(pr.session_id, 'error', 'pr_closed');
      }
      // Transition review session to error (terminal) then end it gracefully
      if (pr.review_session_id) {
        const now = Date.now();
        updateSessionStatus(pr.review_session_id, 'error', now);
        setSessionTerminalCompletionReason(pr.review_session_id, 'pr_closed');
        recordPrAnchoredCompletingSignal(
          pr.review_session_id,
          'pr_closed_without_merge',
          now,
        );
        this.sessions.endSession(pr.review_session_id);
      }
      this.broadcast({
        type: 'pr_closed',
        prNumber: pr.pr_number,
        repo: pr.repo,
      });
    } else {
      await this.processOpenPR(pr, githubHeadSha);
    }
  }

  /**
   * True when this PR's close was live-detected as coming from the session's
   * own `gh pr close` and the coding session hasn't reached a terminal status
   * yet, and the ~5-min (configurable) grace window hasn't expired. Defers
   * PRMergeWatcher from terminalizing on the first poll that sees state='closed',
   * giving the session a chance to reopen it (churn recovery) before the PR
   * and its session are stranded or duplicated.
   */
  private shouldDeferSessionInitiatedClose(pr: PullRequestRow): boolean {
    if (!pr.session_initiated_close_at) return false;
    const codingSessionStatus = pr.session_id
      ? (getSession(pr.session_id)?.status ?? null)
      : null;
    if (isSessionTerminal(codingSessionStatus)) return false;
    const graceMs = typedGetSetting('session_pr_close_grace_minutes') * 60_000;
    const elapsedMs = Date.now() - pr.session_initiated_close_at;
    if (elapsedMs >= graceMs) {
      logger.info(
        `[PRMergeWatcher] PR #${pr.pr_number}: session-initiated close grace period (${graceMs / 60_000}m) expired — terminalizing`,
      );
      return false;
    }
    return true;
  }

  /**
   * Reconcile a PR that was deferred as a session-initiated close and has now
   * been reopened (or was closed and reopened between polls). Restores
   * head_branch/head_sha from GitHub, clears the pr_closed pause/error and the
   * session-initiated-close marker, and resumes normal polling. If the coding
   * session has since died, the PR is simply left open with pause cleared —
   * the stalled-PR reconciliation path picks up dead-session PRs independently.
   */
  private async reconcileSessionInitiatedClose(
    pr: PullRequestRow,
    githubHeadSha: string | null,
  ): Promise<PullRequestRow> {
    logger.info(
      `[PRMergeWatcher] PR #${pr.pr_number}: reconciling after session-initiated close/reopen churn`,
    );
    let headBranch = pr.head_branch;
    let headSha = githubHeadSha ?? pr.head_sha;
    try {
      const fresh = await this.github.fetchPR(pr.repo, pr.pr_number);
      headBranch = fresh.headBranch;
      headSha = fresh.headSha ?? headSha;
    } catch (err) {
      if (err instanceof GitHubRateLimitError) {
        this.handleRateLimit(err);
      } else {
        logger.warn(
          `[PRMergeWatcher] PR #${pr.pr_number}: fetchPR failed during reconcile:`,
          (err as Error).message,
        );
      }
    }

    updatePRState(pr.pr_number, pr.repo, 'open');
    setHeadBranch(pr.pr_number, pr.repo, headBranch);
    setHeadSha(pr.pr_number, pr.repo, headSha);
    clearTerminalPRFlags(pr.pr_number, pr.repo, 'session_reconciled');
    clearSessionInitiatedPRClose(pr.pr_number, pr.repo);

    const codingSessionStatus = pr.session_id
      ? (getSession(pr.session_id)?.status ?? null)
      : null;
    if (pr.session_id && isSessionTerminal(codingSessionStatus)) {
      logger.info(
        `[PRMergeWatcher] PR #${pr.pr_number}: reconciled but coding session ${pr.session_id} is dead (${codingSessionStatus}) — leaving for stalled-PR reconciliation`,
      );
    }

    this.broadcast({
      type: 'pr_reconciled',
      prNumber: pr.pr_number,
      repo: pr.repo,
    });

    return getPRByNumber(pr.pr_number, pr.repo) ?? pr;
  }

  private async processOpenPR(
    pr: PullRequestRow,
    githubHeadSha: string | null,
  ): Promise<void> {
    if (pr.session_initiated_close_at) {
      pr = await this.reconcileSessionInitiatedClose(pr, githubHeadSha);
    }
    // Detect out-of-band pushes for any open PR
    if (githubHeadSha && githubHeadSha !== pr.head_sha) {
      logger.info(
        `[PRMergeWatcher] PR #${pr.pr_number} head_sha changed: ${pr.head_sha?.slice(0, 7) ?? 'null'} → ${githubHeadSha.slice(0, 7)} — triggering push pipeline`,
      );
      setHeadSha(pr.pr_number, pr.repo, githubHeadSha);
      // A fix was actually pushed — the load-bearing signal that un-sticks a
      // reconcile_exhausted escalation. No-op when the flag isn't set.
      if (pr.reconcile_exhausted) {
        clearTerminalPRFlags(pr.pr_number, pr.repo, 'head_sha_advance');
      }
      const refreshedPr = getPRByNumber(pr.pr_number, pr.repo);
      if (refreshedPr) {
        void this.handlePushDetected(refreshedPr);
      }
    }
    // Check mergeability for approved PRs
    await this.checkMergeability(pr);
  }

  private async checkMergeability(pr: PullRequestRow): Promise<void> {
    // Only poll mergeability for PRs that have an approved verdict
    if (!pr.review_result) return;
    let verdict: string | undefined;
    try {
      const parsed = JSON.parse(pr.review_result) as { verdict?: string };
      verdict = parsed.verdict;
    } catch {
      return;
    }
    if (verdict !== 'approved') return;
    await this.runMergeabilityCheck(pr);
  }

  /**
   * Run an immediate mergeability check for the given PR, regardless of verdict.
   * Called after a review completes with verdict 'approved' so the DB merge_state
   * and Merge button reflect current state without waiting for the next 5-min poll.
   */
  async checkMergeabilityNow(prNumber: number, repo: string): Promise<void> {
    const pr = getPRByNumber(prNumber, repo);
    if (!pr) return;
    await this.runMergeabilityCheck(pr);
  }

  private prKey(pr: Pick<PullRequestRow, 'pr_number' | 'repo'>): string {
    return `${pr.pr_number}:${pr.repo}`;
  }

  private readonly behindRechecks = new Set<string>();

  private scheduleBehindRecheck(
    pr: PullRequestRow,
    ciCheckNames: string[],
  ): void {
    const key = this.prKey(pr);
    if (this.behindRechecks.has(key)) return;
    this.behindRechecks.add(key);
    const timer = setTimeout(() => {
      this.behindRechecks.delete(key);
      void this.runBehindRecheck(pr.pr_number, pr.repo, ciCheckNames).catch(
        (err: unknown) =>
          logger.warn(
            `[PRMergeWatcher] behind re-check failed for PR #${pr.pr_number}: ${(err as Error).message}`,
          ),
      );
    }, BEHIND_RECHECK_DELAY_MS);
    timer.unref?.();
  }

  private async runBehindRecheck(
    prNumber: number,
    repo: string,
    ciCheckNames: string[],
  ): Promise<void> {
    const before = getPRByNumber(prNumber, repo);
    if (!before || before.state !== 'open') return;
    let category: MergeabilityCategory;
    try {
      category = await this.github.categorizeMergeability(
        prNumber,
        repo,
        ciCheckNames,
      );
    } catch (err) {
      if (err instanceof GitHubRateLimitError) {
        this.handleRateLimit(err);
        return;
      }
      throw err;
    }
    const fresh = getPRByNumber(prNumber, repo);
    if (!fresh || fresh.state !== 'open') return;
    if (category.category === 'clean') {
      this.autoMerger?.attempt(prNumber, repo);
    } else if (category.category === 'conflict') {
      if (!isTerminalMergePause(fresh.pause_reason)) {
        await sendConflictNudge(this.sessions, fresh, 'conflict');
      }
    }
  }

  private async runMergeabilityCheck(pr: PullRequestRow): Promise<void> {
    if (pr.state === 'merged' || pr.state === 'closed') return;
    // PRs paused for terminal reasons (AutoMerger given up / human intervention
    // needed) still get their observability columns (merge_state/failing_checks)
    // refreshed below — otherwise the CI-failing pill freezes at whatever GitHub
    // state existed the instant the pause fired. Only the remediation side
    // effects (autofix, conflict nudges, pause clearing, AutoMerger retries) are
    // skipped, since polling can't change a terminal outcome.
    const terminalPause = isTerminalMergePause(pr.pause_reason);

    const project = getProjectByGithubRepo(pr.repo);
    const config = project ? loadOrchestratorConfig(project.projectDir) : null;

    const ciCheckNames = config?.ci_check_name ?? [];

    let category: MergeabilityCategory;
    try {
      category = await this.github.categorizeMergeability(
        pr.pr_number,
        pr.repo,
        ciCheckNames,
      );
    } catch (err) {
      if (err instanceof GitHubRateLimitError) {
        this.handleRateLimit(err);
        return;
      }
      logger.warn(
        `[PRMergeWatcher] categorizeMergeability failed for PR #${pr.pr_number}:`,
        (err as Error).message,
      );
      return;
    }

    // Re-read DB after the network round-trip. If the PR merged or closed while
    // we were waiting on GitHub, suppress all downstream side effects — the
    // session was endSession()'d on merge and we must not sendOrResume it back to life.
    const fresh = getPRByNumber(pr.pr_number, pr.repo);
    if (fresh?.state === 'merged' || fresh?.state === 'closed') return;

    // Skip if GitHub hasn't computed mergeability yet
    if (category.category === 'unknown' && category.rawMergeableState === null)
      return;

    const failingNames = category.failingChecks.map((c) => c.name);
    const prevFailingNames = parseFailingChecksRaw(pr.failing_checks);
    const stateChanged = pr.merge_state !== category.mergeState;
    const failingChecksChanged = !arraysShallowEqual(
      prevFailingNames,
      failingNames,
    );

    // CI-failure remediation: decoupled from stateChanged via per-SHA dedup.
    // Fires whenever we observe ci_failed for a SHA we haven't remediated yet,
    // regardless of whether AutoMerger already wrote merge_state='ci_failed'.
    if (!terminalPause && category.category === 'ci_failed' && pr.session_id) {
      if (pr.ci_remediation_attempted_sha !== pr.head_sha) {
        // Reserve this SHA atomically before running remediation so a restart
        // can't re-fire for the same SHA.
        setCiRemediationAttemptedSha(pr.pr_number, pr.repo, pr.head_sha);

        // Check for billing/spending-limit block before sending the investigate prompt.
        if (pr.head_sha) {
          const billingBlock = await this.github
            .detectBillingBlock(pr.head_sha, pr.repo)
            .catch((err: unknown) => {
              logger.warn(
                `[PRMergeWatcher] detectBillingBlock failed for PR #${pr.pr_number}:`,
                (err as Error).message,
              );
              return { blocked: false, message: null };
            });
          if (billingBlock.blocked) {
            setPauseReason(pr.pr_number, pr.repo, 'ci_billing_blocked');
            this.broadcast({
              type: 'ci_billing_blocked',
              prNumber: pr.pr_number,
              repo: pr.repo,
              message: billingBlock.message ?? '',
            });
            if (pr.task_id) {
              emitTaskUpdated(pr.task_id);
            }
            logger.info(
              `[PRMergeWatcher] PR #${pr.pr_number}: billing/spending limit blocked — paused as ci_billing_blocked`,
            );
            return;
          }
        }

        await this.runCIFailureRemediation(pr, category.failingChecks);
      }
    }

    // Conflict path: SHA-deduped nudge runs regardless of stateChanged.
    // PRs already conflicted at first poll (or whose transition happened during
    // a backend restart) are correctly nudged because dedup is state-based.
    if (!terminalPause && category.category === 'conflict') {
      logger.info(
        `[PRMergeWatcher] PR #${pr.pr_number} in ${pr.repo} has merge conflicts`,
      );
      await sendConflictNudge(this.sessions, pr, 'conflict');
    }

    // Behind is not a conflict: notify once per transition, re-check shortly.
    if (
      !terminalPause &&
      category.category === 'behind' &&
      pr.merge_state !== 'behind'
    ) {
      logger.info(
        `[PRMergeWatcher] PR #${pr.pr_number} in ${pr.repo} is behind base`,
      );
      await sendConflictNudge(this.sessions, pr, 'behind', {
        replaceConflictNudge: true,
      });
      this.scheduleBehindRecheck(pr, ciCheckNames);
    }

    // Only update + broadcast if something actually changed.
    if (!stateChanged && !failingChecksChanged) {
      if (!terminalPause) this.tryCIFailingRecovery(pr, category);
      return;
    }

    const mergeableInt = category.category === 'clean' ? 1 : 0;
    const failingNamesOrNull = failingNames.length > 0 ? failingNames : null;
    updateMergeState(
      pr.pr_number,
      pr.repo,
      mergeableInt,
      category.mergeState,
      failingNamesOrNull,
    );
    this.broadcast({
      type: 'pr_mergeability_changed',
      prNumber: pr.pr_number,
      repo: pr.repo,
      mergeable: category.category === 'clean',
      mergeState: category.mergeState,
      failingChecks: failingNamesOrNull,
    });
    if (pr.task_id) {
      emitTaskUpdated(pr.task_id);
    }

    if (!terminalPause) this.tryCIFailingRecovery(pr, category);

    // Becomes-clean re-drive: the only other consumer of a clean transition
    // (tryCIFailingRecovery) fires solely for CI-sourced pauses, so an
    // approval that lands while CI is still in flight (pause_reason === null,
    // category was 'unknown') never gets re-driven once GitHub settles to
    // clean. Fire unconditionally on the transition — including for PRs
    // carrying a non-CI pause — so those rows are considered too. This never
    // clears pause_reason itself; run()'s isMergeBlockingPause() guard still
    // blocks the merge for a merge-blocking pause until an already-trusted
    // channel clears it (a non-blocking pause, e.g.
    // test_report_acquisition_failed, does not hold the merge back at all).
    // Keyed off the transition (merge_state changing into 'clean'), not the
    // level, so an already-clean PR isn't re-driven on every poll.
    if (category.category === 'clean' && pr.merge_state !== 'clean') {
      logger.info(
        `[PRMergeWatcher] PR #${pr.pr_number} in ${pr.repo} became mergeable (clean) — re-driving AutoMerger`,
      );
      this.autoMerger?.attempt(pr.pr_number, pr.repo);
    }

    if (stateChanged && category.category === 'blocked') {
      logger.info(
        `[PRMergeWatcher] PR #${pr.pr_number} in ${pr.repo} is blocked by branch protection`,
      );
    }
  }

  /**
   * Run autofix-then-session-feedback remediation for a CI-failing PR.
   * The caller is responsible for the per-SHA dedup check and recording
   * ci_remediation_attempted_sha before calling this method.
   * logExcerpt: captured test output to include in the feedback (F2 orchestrator tests).
   */
  private async runCIFailureRemediation(
    pr: PullRequestRow,
    failingChecks: FailingCheck[],
    logExcerpt?: string | null,
  ): Promise<void> {
    const failingNames = failingChecks.map((c) => c.name);
    logger.info(
      `[PRMergeWatcher] PR #${pr.pr_number} in ${pr.repo} has failing CI checks: ${failingNames.join(', ') || '(unknown)'}`,
    );

    const alreadyAutofixed = pr.head_sha
      ? consumeAutofixSha(pr.pr_number, pr.repo, pr.head_sha)
      : false;

    if (!alreadyAutofixed) {
      const session = getSession(pr.session_id!);
      const worktreePath = session?.worktree_path ?? '';
      const project = getProjectByGithubRepo(pr.repo);
      const autofixCommands = project
        ? loadAutofixCommands(project.projectDir)
        : [];

      if (worktreePath && autofixCommands.length > 0) {
        const mergeWatcherConfig = project
          ? loadOrchestratorConfig(project.projectDir)
          : null;
        try {
          const result = await runAutofix(
            worktreePath,
            project!.projectDir,
            autofixCommands,
            (msg) =>
              logger.info(
                `[PRMergeWatcher] autofix PR #${pr.pr_number}: ${msg}`,
              ),
            pr.base_branch ?? project!.baseBranch,
            mergeWatcherConfig?.autofix_skip_ci ?? false,
          );
          if (result.commitSha) {
            addAutofixSha(pr.pr_number, pr.repo, result.commitSha);
            recordEvent({
              event_type: 'autofix_for_ci_failure',
              actor_type: 'system',
              task_id: pr.task_id ?? null,
              payload: {
                pr_number: pr.pr_number,
                commit_sha: result.commitSha,
                failing_checks: failingNames,
                source: 'ci',
              },
            });
            return; // CI will re-run on the new SHA
          }
        } catch (err) {
          logger.warn(
            `[PRMergeWatcher] autofix error for PR #${pr.pr_number}:`,
            (err as Error).message,
          );
        }
      }
    }

    const runUrl = failingChecks[0]?.detailsUrl ?? null;
    const msg = formatCIFailureFeedback({
      prNumber: pr.pr_number,
      failingCheckNames: failingNames,
      runUrl,
      logExcerpt: logExcerpt ?? null,
    });
    this.sessions
      .sendOrResume(pr.session_id!, msg)
      .catch((err: unknown) =>
        logger.warn(
          `[PRMergeWatcher] sendOrResume failed for session ${pr.session_id}:`,
          (err as Error).message,
        ),
      );
  }

  private tryCIFailingRecovery(
    pr: PullRequestRow,
    category: MergeabilityCategory,
  ): void {
    // source:'ci' alone would also match ci_billing_blocked (retry_strategy:
    // 'manual_action') — a mergeability-category change never discharges
    // that one, only a genuinely automatic ci pause like ci_failing.
    if (
      !findAutomaticGateRecoveryEntry(
        parsePauseReasonSet(pr.pause_reason),
        'ci',
      )
    )
      return;
    // Trigger recovery for any non-CI-failing, non-conflict category.
    // AutoMerger will re-categorize and bounce back if not actually mergeable.
    if (
      category.category === 'ci_failed' ||
      category.category === 'conflict' ||
      category.category === 'behind'
    )
      return;
    setPauseReason(pr.pr_number, pr.repo, null);
    logger.info(
      `[PRMergeWatcher] PR #${pr.pr_number} CI recovered (mergeState=${category.mergeState}) — clearing ${pr.pause_reason} pause and retrying AutoMerger`,
    );
    this.broadcast({
      type: 'pr_pause_cleared',
      prNumber: pr.pr_number,
      repo: pr.repo,
    });
    this.autoMerger?.attempt(pr.pr_number, pr.repo);
  }

  /**
   * Resets the flake-recovery budget, clears the pause, broadcasts, and
   * re-drives the merge loop (see reattributePausedPR).
   */
  private async applyPassedOutcomeTail(
    pr: Pick<PullRequestRow, 'pr_number' | 'repo'>,
    cause: string,
  ): Promise<void> {
    resetFlakeRecoveryAttempts(pr.pr_number, pr.repo);
    setPauseReason(pr.pr_number, pr.repo, null);
    this.broadcast({
      type: 'pr_pause_cleared',
      prNumber: pr.pr_number,
      repo: pr.repo,
    });
    logger.info(
      `[PRMergeWatcher] PR #${pr.pr_number}: ${cause} — pause cleared, re-driving merge loop`,
    );
    // checkMergeabilityNow bypasses the approved-verdict gate that
    // checkMergeability enforces, so a not-yet-approved PR is re-driven too.
    await this.checkMergeabilityNow(pr.pr_number, pr.repo);
    this.autoMerger?.attempt(pr.pr_number, pr.repo);
  }

  /**
   * Re-attributes one already-paused PR against fresh cross-tree evidence,
   * with no rerun and no flake_recovery_attempts increment. Only acts on a PR
   * holding a live automatic ci/analyze pause (the lane's one rerun-based
   * attempt per SHA has already run); never re-triggers that mechanism. A full
   * excuse flips the cached failed run to passed and runs the shared
   * passed-outcome tail. Partial/no excuse, or an unknown diff, leaves the PR
   * untouched.
   */
  async reattributePausedPR(
    prNumber: number,
    repo: string,
  ): Promise<'redriven' | 'not_excused' | 'skipped'> {
    const pr = getPRByNumber(prNumber, repo);
    if (!pr || pr.state !== 'open' || !pr.session_id) return 'skipped';
    const entries = parsePauseReasonSet(pr.pause_reason ?? null);
    if (
      !findAutomaticGateRecoveryEntry(entries, 'ci') &&
      !findAutomaticGateRecoveryEntry(entries, 'analyze')
    ) {
      return 'skipped';
    }
    const project = getProjectByGithubRepo(pr.repo);
    if (!project) return 'skipped';
    const run = getLatestTestRequestRunForSession(project.id, pr.session_id);
    if (!run || run.state !== 'failed') return 'skipped';

    let gate: Awaited<
      ReturnType<typeof filterBaseAttributableFailuresForF2Gate>
    >;
    try {
      gate = await filterBaseAttributableFailuresForF2Gate(
        project,
        run,
        pr.task_id ?? null,
      );
    } catch (err) {
      logger.warn(
        `[PRMergeWatcher] PR #${pr.pr_number}: re-attribution filter failed: ${(err as Error).message}`,
      );
      return 'skipped';
    }
    if (gate.result.outcome !== 'filtered_pass') return 'not_excused';

    updateTestRequestRunState(run.id, 'passed');
    await this.applyPassedOutcomeTail(
      pr,
      're-attribution fully excused failures',
    );
    return 'redriven';
  }

  /** Re-attributes every open PR holding a live automatic ci/analyze pause. */
  async reattributePausedPRs(): Promise<number> {
    let redriven = 0;
    for (const pr of getAllOpenPRs()) {
      try {
        if (
          (await this.reattributePausedPR(pr.pr_number, pr.repo)) === 'redriven'
        ) {
          redriven++;
        }
      } catch (err) {
        logger.warn(
          `[PRMergeWatcher] PR #${pr.pr_number}: re-attribution failed: ${(err as Error).message}`,
        );
      }
    }
    return redriven;
  }

  /**
   * Handle a push event for the given PR — either triggered by a coding session's
   * push_detected WS event (via the thin server.ts wrapper) or by PRMergeWatcher
   * detecting an out-of-band head_sha change during polling.
   *
   * The prRow should be freshly loaded from the DB before calling so that
   * head_sha and other fields reflect the current state.
   */
  async handlePushDetected(
    prRow: PullRequestRow,
    opts?: { expectedHeadSha?: string | null },
  ): Promise<void> {
    if (!AUTO_REVIEW_ENABLED) {
      logger.info('[PRMergeWatcher] handlePushDetected: auto-review disabled');
      return;
    }

    const sessionId = prRow.session_id;
    if (!sessionId) return;

    // Refresh head_sha from GitHub before any branch decision below — several
    // paths (pending re-review guard, no review session yet) return early and
    // must not leave pull_requests.head_sha stale for a push that already landed.
    let headSha = prRow.head_sha;
    {
      let fetchError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const freshPR = await this.github.fetchPR(
            prRow.repo,
            prRow.pr_number,
          );
          headSha = freshPR.headSha;
          fetchError = undefined;
          const expected = opts?.expectedHeadSha ?? null;
          if (expected && headSha === prRow.head_sha && headSha !== expected) {
            // GitHub's PR head lags a push by more than the 1-3 s between the
            // push and this read — wait for it to catch up before trusting it.
            for (let lag = 0; lag < 5 && headSha === prRow.head_sha; lag++) {
              await new Promise<void>((resolve) => setTimeout(resolve, 2000));
              headSha = (await this.github.fetchPR(prRow.repo, prRow.pr_number))
                .headSha;
            }
            if (headSha === prRow.head_sha) {
              logger.warn(
                `[PRMergeWatcher] PR #${prRow.pr_number} head still ${prRow.head_sha?.slice(0, 7)} on GitHub after push of ${expected.slice(0, 7)} — using pushed head`,
              );
              headSha = expected;
            }
          }
          if (headSha !== prRow.head_sha) {
            setHeadSha(prRow.pr_number, prRow.repo, headSha);
            // The tree every queued run against this worktree was staged
            // against is now behind the new head — withdraw them rather
            // than let them execute to completion against a stale push.
            this.withdrawQueuedRunsForPR(prRow, 'head_moved');
            // A fix was actually pushed — the load-bearing signal that
            // un-sticks a reconcile_exhausted escalation, independent of
            // whatever verdict the re-review below produces.
            if (prRow.reconcile_exhausted) {
              clearTerminalPRFlags(
                prRow.pr_number,
                prRow.repo,
                'head_sha_advance',
              );
            }
            prRow = { ...prRow, head_sha: headSha };
          }
          break;
        } catch (e) {
          fetchError = e;
          if (attempt === 0) {
            logger.warn(
              `[PRMergeWatcher] fetch PR #${prRow.pr_number} failed (attempt 1), retrying...`,
            );
            await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          }
        }
      }
      if (fetchError) {
        logger.warn(
          `[PRMergeWatcher] failed to fetch latest PR state for #${prRow.pr_number} after retry:`,
          fetchError,
        );
      }
    }

    if (
      parsePauseReason(prRow.pause_reason)?.reason === 'human_changes_requested'
    ) {
      // Session addressed human review feedback and pushed — clear the pause so
      // AutoMerger can re-check the review state (re-approve or request more changes).
      setPauseReason(prRow.pr_number, prRow.repo, null);
      this.autoMerger?.attempt(prRow.pr_number, prRow.repo);
      logger.info(
        `[PRMergeWatcher] handlePushDetected: human_changes_requested cleared for PR #${prRow.pr_number} — AutoMerger restarted`,
      );
      return;
    }

    // Gate-failure verdicts (autofix_failed / verify_failed) used to set
    // review_session_id=NULL unconditionally, on the premise that the gate
    // always runs before any review session is spawned. That premise breaks
    // from iteration 1 on: a PR can carry a gate-failure verdict while still
    // holding the review_session_id from an earlier iteration. Both cases —
    // with or without an established review session — take the same
    // enqueue path below; only a PR with neither a review session nor a
    // gate-failure verdict (the true "no review established yet" case)
    // queues as pending_push instead.
    const currentVerdict = parseVerdictFromResult(prRow.review_result);
    const isAfterGateFailure =
      currentVerdict === 'autofix_failed' || currentVerdict === 'verify_failed';

    if (!prRow.review_session_id && !isAfterGateFailure) {
      // Initial review hasn't started yet — queue the push so it triggers
      // re-review after the initial review is established.
      setPendingPush(prRow.pr_number, prRow.repo, 1);
      logger.info(
        `[PRMergeWatcher] handlePushDetected for PR #${prRow.pr_number} before review session established — queued as pending_push`,
      );
      return;
    }

    if (!this.reviewOrchestrator) {
      if (!prRow.review_session_id) {
        // Gate-failure retry with no established review session and no
        // orchestrator wired — queue as pending_push so a later poll (once
        // the orchestrator is available) or sweepPendingPushDeadLetters can
        // still pick this push up, rather than dropping it.
        setPendingPush(prRow.pr_number, prRow.repo, 1);
        logger.warn(
          `[PRMergeWatcher] handlePushDetected: reviewOrchestrator not set — queued PR #${prRow.pr_number} as pending_push`,
        );
        return;
      }
      logger.warn(
        `[PRMergeWatcher] handlePushDetected: reviewOrchestrator not set — skipping re-review for PR #${prRow.pr_number}`,
      );
      return;
    }

    // Skip re-review when the only push since the last review was the autofix
    // commit — the code at that SHA was already reviewed via the pipeline.
    if (
      headSha &&
      this.reviewOrchestrator.consumeAutofixSha(
        prRow.pr_number,
        prRow.repo,
        headSha,
      )
    ) {
      logger.info(
        `[PRMergeWatcher] handlePushDetected: autofix-only push for PR #${prRow.pr_number} — skipping re-review`,
      );
      return;
    }

    const maxIter = this.getMaxReviewIterations();

    // Escalation cap reached — emit review_escalated before bailing out.
    if (prRow.review_iteration >= maxIter) {
      const message = `Review loop for PR #${prRow.pr_number} reached ${maxIter} iterations without approval. Manual intervention needed.`;
      logger.warn(`[PRMergeWatcher] ${message}`);
      setPauseReason(prRow.pr_number, prRow.repo, 'max_reviews');
      this.broadcast({
        type: 'review_escalated',
        prNumber: prRow.pr_number,
        repo: prRow.repo,
        message,
      });
      return;
    }

    // Gate-failure retries don't have an established review session, so the
    // head≠last_reviewed_sha guard is meaningless for them (they were never
    // "reviewed" at any SHA) — skip shouldAutoReview in that case and go
    // straight to enqueueing against the new head.
    if (!isAfterGateFailure) {
      const autoReviewOk = shouldAutoReview(
        {
          reviewIteration: prRow.review_iteration,
          headSha,
          lastReviewedSha: prRow.last_reviewed_sha,
        },
        maxIter,
      );
      logger.info(
        `[PRMergeWatcher] shouldAutoReview: iter=${prRow.review_iteration}/${maxIter} head=${headSha?.slice(0, 7)} lastReviewed=${prRow.last_reviewed_sha?.slice(0, 7)} → ${autoReviewOk}`,
      );
      if (!autoReviewOk) {
        return;
      }
    }

    const project = getProjectByGithubRepo(prRow.repo);
    const session = prRow.session_id ? getSession(prRow.session_id) : undefined;

    // Mirrors StalledPRReconciler.reDriveIfPushDetected: a push lands on a
    // tree the no-diff-autofix guard must not mistake for a retry of a tree
    // that already failed — clear the stale pre_review_stage (and any
    // terminal pause) before enqueueing so the gate actually re-runs against
    // the new head.
    clearTerminalPRFlags(prRow.pr_number, prRow.repo, 'head_sha_advance');
    this.reviewOrchestrator.enqueueReview({
      prNumber: prRow.pr_number,
      repo: prRow.repo,
      taskId: prRow.task_id ?? '',
      taskUrl: session?.task_url ?? '',
      contextUrl: project?.contextUrl ?? '',
      headSha,
      pushTriggered: true,
    });
    logger.info(
      `[PRMergeWatcher] handlePushDetected for PR #${prRow.pr_number}: enqueued review for head ${headSha?.slice(0, 7)}`,
    );
  }

  /**
   * Heals dead-letter pending_push rows: PRs that have pending_push=1 but no
   * review in flight (e.g. pushed after gate-failure, or after a backend restart
   * interrupted the consumption path). Consumes the flag and enqueues a review.
   */
  private async sweepPendingPushDeadLetters(): Promise<void> {
    if (!AUTO_REVIEW_ENABLED || !this.reviewOrchestrator) return;
    const prs = getAllOpenPRs();
    for (const pr of prs) {
      // Every open PR fleet-wide is checked here with no I/O await inside —
      // purely synchronous sqlite/Map lookups and shouldAutoReview's pure
      // computation. Same fix pattern as TaskCacheRefresher's per-milestone
      // loop.
      await yieldToEventLoop();

      if (!pr.pending_push) continue;
      if (this.reviewOrchestrator.isReviewInFlight(pr.pr_number, pr.repo))
        continue;

      const maxIter = this.getMaxReviewIterations();
      const autoReviewOk = shouldAutoReview(
        {
          reviewIteration: pr.review_iteration,
          headSha: pr.head_sha,
          lastReviewedSha: pr.last_reviewed_sha,
        },
        maxIter,
      );
      if (!autoReviewOk) continue;

      setPendingPush(pr.pr_number, pr.repo, 0);

      const project = getProjectByGithubRepo(pr.repo);
      const session = pr.session_id ? getSession(pr.session_id) : undefined;
      this.reviewOrchestrator.enqueueReview({
        prNumber: pr.pr_number,
        repo: pr.repo,
        taskId: pr.task_id ?? '',
        taskUrl: session?.task_url ?? '',
        contextUrl: project?.contextUrl ?? '',
        headSha: pr.head_sha,
        pushTriggered: true,
      });
      logger.info(
        `[PRMergeWatcher] sweepPendingPushDeadLetters: consumed pending_push for PR #${pr.pr_number} — review enqueued`,
      );
    }
  }

  /**
   * Withdraws every still-queued test.request lane run against this PR's
   * session worktree — called on pr_merged/pr_closed and on push_detected
   * with a new head, the three ways a queued run's tree stops being current
   * before it ever executes. A no-op when the PR has no coding session (no
   * worktree to key the withdrawal on) or the project can't be resolved from
   * pr.repo.
   */
  private withdrawQueuedRunsForPR(
    pr: PullRequestRow,
    reason: 'pr_merged' | 'pr_closed' | 'head_moved',
  ): void {
    if (reason !== 'head_moved') {
      const taskId =
        pr.task_id ??
        (pr.session_id ? getSession(pr.session_id)?.task_id : null);
      if (taskId) clearTaskExecuteNow(taskId, reason);
    }
    const worktreePath = pr.session_id
      ? getSession(pr.session_id)?.worktree_path
      : null;
    if (!worktreePath) return;
    const project = getProjectByGithubRepo(pr.repo);
    if (!project) return;
    const withdrawn = withdrawQueuedRunsForWorktree(
      project.id,
      worktreePath,
      reason,
      { prNumber: pr.pr_number, repo: pr.repo },
    );
    if (withdrawn > 0) {
      logger.info(
        `[PRMergeWatcher] withdrew ${withdrawn} queued test.request run(s) for PR #${pr.pr_number} (${reason})`,
      );
    }
  }

  /**
   * @param options.silent When true, the SQLite state transition still happens
   *   (and sessions/Notion updates run) but the pr_merged broadcast is
   *   suppressed. Used by poll() on the first cycle after boot to avoid
   *   re-firing notifications for PRs that merged while the backend was down.
   */
  async handleMerged(
    pr: PullRequestRow,
    sha: string | null,
    options: { silent?: boolean } = {},
  ): Promise<void> {
    updatePRState(pr.pr_number, pr.repo, 'merged');
    clearTerminalPRFlags(pr.pr_number, pr.repo, 'merged');
    deleteAllAutofixShasForPR(pr.pr_number, pr.repo);
    this.withdrawQueuedRunsForPR(pr, 'pr_merged');

    const mergeCommit = await this.completeMerge(pr, sha);

    // Delete the origin branch for feature/* branches.
    if (pr.head_branch?.startsWith('feature/')) {
      await this.github
        .deleteBranch(pr.repo, pr.head_branch)
        .catch((err: unknown) =>
          logger.warn(
            `[PRMergeWatcher] deleteBranch origin ${pr.head_branch} failed:`,
            (err as Error).message,
          ),
        );
    }

    // Mark the code session done — it was idle (parked, PR open, subprocess
    // still alive and waiting) and the PR just merged, so this is the
    // terminal done transition. Idle never implies the process exited;
    // endSession() below is what actually closes stdin and, if the process
    // doesn't honor that, forcefully reaps it.
    if (pr.session_id) {
      const codeSessionDoneAt = Date.now();
      markSessionDone(
        pr.session_id,
        codeSessionDoneAt,
        pr.pr_url ?? null,
        'pr_merge_watcher',
      );
      recordPrAnchoredCompletingSignal(
        pr.session_id,
        'pr_merged',
        codeSessionDoneAt,
      );
    }

    // End coding session (stdin close, verified, escalates to a forceful
    // kill if the process doesn't exit on its own).
    // Mark it for local branch deletion so cleanupWorktree removes the branch
    // even though a prUrl is set.
    if (pr.session_id) {
      if (pr.head_branch?.startsWith('feature/')) {
        this.sessions.markForBranchDeletion(pr.session_id);
      }
      this.sessions.endSession(pr.session_id);
    }

    // Mark the review session done — same terminal transition as the code session.
    if (pr.review_session_id) {
      const reviewSessionDoneAt = Date.now();
      markSessionDone(
        pr.review_session_id,
        reviewSessionDoneAt,
        pr.pr_url ?? null,
        'pr_merge_watcher',
      );
      recordPrAnchoredCompletingSignal(
        pr.review_session_id,
        'pr_merged',
        reviewSessionDoneAt,
      );
    }

    // End review session (stdin close, verified, escalates to a forceful
    // kill if the process doesn't exit on its own).
    if (pr.review_session_id) {
      this.sessions.endSession(pr.review_session_id);
    }

    // Update task to Done via the project-scoped task backend
    if (pr.task_id) {
      const backend = this.resolveBackendForRepo(pr.repo);
      if (backend) {
        await backend
          .updateStatus(pr.task_id, '✅ Done')
          .then(() => {
            closeFlakyRemediationTaskIfLinked(
              pr.task_id!,
              new Date().toISOString(),
            );
            this.broadcast({
              type: 'task_status_changed',
              notionTaskId: pr.task_id!,
              newStatus: '✅ Done',
            });
            emitTaskUpdated(pr.task_id!);
          })
          .catch((err: unknown) =>
            logger.warn(
              `[PRMergeWatcher] task backend updateStatus failed:`,
              (err as Error).message,
            ),
          );
      }
    }

    if (!options.silent) {
      this.broadcast({
        type: 'pr_merged',
        prNumber: pr.pr_number,
        repo: pr.repo,
        sha: mergeCommit ?? sha ?? '',
      });
    }
  }

  /**
   * Single merge-completion convergence point: resolves the merge commit
   * (from the caller-supplied sha where present, else fetched from GitHub for
   * the poll/ingest paths that only know the PR merged), persists it to
   * local_branches.merge_commit_sha uniformly across every merge path, and
   * emits merge_completed for internal consumers (e.g. the gate's
   * min_deployed_commit fill). Emission is fire-and-forget and synchronous —
   * a missed event is expected to be caught up by the consumer's own
   * reconciliation against persisted state.
   */
  private async completeMerge(
    pr: PullRequestRow,
    sha: string | null,
  ): Promise<string | null> {
    let mergeCommit = sha;
    if (!mergeCommit) {
      try {
        mergeCommit = await this.github.getMergeCommitSha(
          pr.pr_number,
          pr.repo,
        );
      } catch (err) {
        logger.warn(
          `[PRMergeWatcher] getMergeCommitSha failed for PR #${pr.pr_number}:`,
          (err as Error).message,
        );
        mergeCommit = null;
      }
    }

    if (pr.session_id) {
      const project = getProjectByGithubRepo(pr.repo);
      if (project) {
        recordMergeCommitForSession({
          sessionId: pr.session_id,
          projectId: project.id,
          branchName: pr.head_branch ?? '',
          baseBranch: pr.base_branch ?? 'dev',
          commitSha: mergeCommit,
        });
      }
    }

    if (pr.task_id && mergeCommit) {
      const payload: MergeCompletedPayload = {
        notion_task_id: pr.task_id,
        merge_commit: mergeCommit,
      };
      this.emit('merge_completed', payload);
    }

    return mergeCommit;
  }
}

function parseVerdictFromResult(
  reviewResult: string | null,
): string | undefined {
  if (!reviewResult) return undefined;
  try {
    return (JSON.parse(reviewResult) as { verdict?: string }).verdict;
  } catch {
    return undefined;
  }
}

function parseFailingChecksRaw(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function arraysShallowEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
