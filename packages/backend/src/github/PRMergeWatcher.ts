import { EventEmitter } from 'events';
import type { GitHubClient } from './GitHubClient';
import type {
  MergeabilityCategory,
  FailingCheck,
  VerifiedFlakyDispositionPayload,
  FlakeRecoveryOutcome,
} from './types';
import { GitHubRateLimitError } from './types';
import type { SessionManager } from '../session/SessionManager';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import { getProjectByGithubRepo, AUTO_REVIEW_ENABLED } from '../config';
import type { ProjectConfig } from '../config';
import type { Scheduler } from '../orchestration/Scheduler';
import { typedGetSetting } from '../config/settings';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import {
  loadAutofixCommands,
  runAutofix,
  getChangedFiles,
} from '../session/autofix-runner';
import { computeWholeTreeContentHash } from '../session/analyzeGating';
import { evaluateF2LaneFlakyDisposition } from '../orchestration/testRequestLane';
import { recordEvent } from '../audit/AuditLog';
import type { ServerMessage } from '../ws/types';
import type { PullRequestRow, TestRequestRunRow } from '../db/types';
import { parsePauseReason } from '../db/pauseReason';
import type { AutoMerger } from './AutoMerger';
import type { PRReviewService, PRReviewResult } from './PRReviewService';
import type { ReviewOrchestrator } from './ReviewOrchestrator';
import {
  formatCIFailureFeedback,
  shouldAutoReview,
  formatReviewFeedback,
  truncateLog,
  CI_LOG_EXCERPT_CAP,
} from './reviewUtils';
import { sendConflictNudge } from './conflictNudge';
import { isTerminalStalePR } from './pollUtils';
import {
  getAllOpenPRs,
  updatePRState,
  updateMergeState,
  getPRByNumber,
  setPauseReason,
  setCiRemediationAttemptedSha,
  getSession,
  addAutofixSha,
  consumeAutofixSha,
  deleteAllAutofixShasForPR,
  setHeadSha,
  setLastReviewedSha,
  setPRReviewResult,
  setPendingPush,
  getLatestTestRequestRun,
  markSessionDone,
  updateSessionStatus,
  recordPrAnchoredCompletingSignal,
  clearTerminalPRFlags,
  setHeadBranch,
  clearSessionInitiatedPRClose,
  incrementFlakeRecoveryAttempts,
  resetFlakeRecoveryAttempts,
  recordMergeCommitForSession,
} from '../db/queries';
import { emitTaskUpdated } from '../routes/tasks';
import { logger } from '../logger';
import { buildTestResultDigest } from '../session/testResultDigest';

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
const PUSH_REVIEW_TIMEOUT_MS = 240_000;
const PENDING_REREVIEW_TTL_MS = 5 * 60 * 1000;
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
 */
const TERMINAL_MERGE_PAUSE_REASONS: ReadonlySet<string> = new Set([
  'auto_merge_failed',
  'max_reviews',
  'review_failed',
  'pr_body_invalid',
  'attribution_missing',
  'merge_conflict',
  'stalled_reconcile_cap',
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
  private pausedUntil: Date | null = null;
  private rateLimitBroadcasted = false;
  private prReviewService: PRReviewService | undefined;
  private reviewOrchestrator: ReviewOrchestrator | undefined;
  private readonly pendingReReviews = new Map<string, number>();

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
    this.sessions.on(
      'verified_flaky_disposition',
      (payload: unknown) =>
        void this.handleVerifiedFlakyDisposition(
          payload as VerifiedFlakyDispositionPayload,
        ),
    );
  }

  setAutoMerger(autoMerger: AutoMerger): void {
    this.autoMerger = autoMerger;
  }

  setPRReviewService(svc: PRReviewService): void {
    this.prReviewService = svc;
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
      run: async () => {
        await this.poll();
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
  }

  /**
   * Targeted sweep over rows every scheduled loop otherwise skips forever:
   * state='open' with pause_reason.reason='stalled_reconcile_cap'. Both
   * poll() (via isTerminalStalePR) and StalledPRReconciler deliberately skip
   * these rows to stop per-PR GitHub churn on parked PRs, but that means
   * nothing ever re-queries GitHub for them — so a PR that reaches merged or
   * closed on GitHub after escalation stays stuck at state='open' with a
   * stale pause_reason forever, showing as a false "needs attention" entry.
   *
   * Filters the escalated set in-code from getAllOpenPRs() rather than a
   * dedicated query, and calls getPRState() per-row — O(this orchestrator's
   * escalated-open rows), never listOpenPRs(repo) (O(the repo's total open
   * PRs), which would paginate thousands of unrelated PRs on a busy repo).
   * A row still open on GitHub (e.g. a PR that's genuinely stuck) is left
   * untouched by reconcileTerminalState.
   *
   * A row still open is also run through runMergeabilityCheck: this is the
   * only place anything ever re-categorizes mergeability for an escalated
   * row (poll() skips it via isTerminalStalePR), so without this a PR that
   * became mergeable while escalated (e.g. #1449) would sit at a stale
   * merge_state/mergeable forever. runMergeabilityCheck's own terminalPause
   * handling still refreshes the observability columns without clearing the
   * pause; the becomes-clean transition hook re-drives AutoMerger.attempt()
   * to "consider" the row without clearing stalled_reconcile_cap itself.
   */
  async sweepEscalatedStalePRs(): Promise<number> {
    const escalated = getAllOpenPRs().filter(
      (pr) =>
        parsePauseReason(pr.pause_reason)?.reason === 'stalled_reconcile_cap',
    );
    let items_processed = 0;
    for (const pr of escalated) {
      if (!getProjectByGithubRepo(pr.repo)) {
        logger.warn(
          `[PRMergeWatcher] stale-open sweep: PR #${pr.pr_number}: no project for repo ${pr.repo} — skipping`,
        );
        continue;
      }
      const state = await this.reconcileTerminalState(pr);
      if (state === 'open') {
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
    this.pausedUntil = err.resetAt;
    if (!this.rateLimitBroadcasted) {
      this.rateLimitBroadcasted = true;
      logger.warn(
        `[PRMergeWatcher] GitHub rate-limited; backing off until ${err.resetAt.toISOString()}`,
      );
      this.broadcast({
        type: 'github_rate_limit_hit',
        resetAt: err.resetAt.toISOString(),
        limit: err.limit,
        used: err.used,
      });
    }
  }

  async poll(): Promise<void> {
    if (this.pausedUntil !== null) {
      if (Date.now() < this.pausedUntil.getTime()) return;
      this.pausedUntil = null;
      this.rateLimitBroadcasted = false;
      this.broadcast({ type: 'github_rate_limit_cleared' });
    }
    this.sweepStalePendingReReviews();
    this.sweepPendingPushDeadLetters();
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
        logger.warn(
          `[PRMergeWatcher] listOpenPRStates failed for ${repo}, falling back to individual:`,
          (err as Error).message,
        );
        for (const pr of prs) {
          await this.checkPR(pr, silentMerges);
        }
        continue;
      }

      for (const pr of prs) {
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
      // Transition coding session idle → error on close-without-merge
      if (pr.session_id) {
        this.sessions.markSessionErrored(pr.session_id, 'error', 'pr_closed');
      }
      // Transition review session to error (terminal) then end it gracefully
      if (pr.review_session_id) {
        const now = Date.now();
        updateSessionStatus(pr.review_session_id, 'error', now);
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
      // stalled_reconcile_cap escalation. No-op for any other pause reason.
      if (
        parsePauseReason(pr.pause_reason)?.reason === 'stalled_reconcile_cap'
      ) {
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

    // ── Orchestrator-run test gate (F2) ──────────────────────────────────────
    // When test: commands are configured, the shared content-hash cache
    // (test_request_runs, keyed by (project_id, whole-tree content hash) —
    // the same table buildTestsStage/runTestPipeline/the test.request lane
    // write into) is the authoritative CI signal — GitHub CI is disabled on
    // private repos so GitHub reports the PR mergeable; we gate on that
    // cached verdict instead. Skipped for terminally-paused PRs so we fall
    // through to the read-only GitHub merge-state refresh below instead of
    // remediating.
    if (
      !terminalPause &&
      config &&
      config.test.length > 0 &&
      pr.head_sha &&
      pr.session_id &&
      project
    ) {
      const worktreePath = getSession(pr.session_id)?.worktree_path;
      const contentHash = worktreePath
        ? await computeWholeTreeContentHash(worktreePath)
        : null;
      const testResult = contentHash
        ? getLatestTestRequestRun(project.id, contentHash)
        : undefined;
      if (testResult && testResult.state === 'failed') {
        if (pr.ci_remediation_attempted_sha !== pr.head_sha) {
          const recovered = worktreePath
            ? await this.tryF2LaneAutoDisposition(
                pr,
                project,
                testResult,
                worktreePath,
              )
            : false;
          if (!recovered) {
            setCiRemediationAttemptedSha(pr.pr_number, pr.repo, pr.head_sha);
            setPauseReason(
              pr.pr_number,
              pr.repo,
              'ci_failing',
              testResult.output ? testResult.output.slice(0, 1000) : undefined,
            );
            const digest = testResult.structured_result
              ? buildTestResultDigest(testResult.structured_result)
              : null;
            const verifyMsg = formatCIFailureFeedback({
              source: 'verify',
              failedCommand: config.test.join(' && '),
              truncatedOutput:
                digest ??
                (testResult.output
                  ? truncateLog(testResult.output, CI_LOG_EXCERPT_CAP)
                  : undefined),
              conflicted: pr.merge_state === 'dirty',
              baseBranch: pr.base_branch ?? undefined,
            });
            this.sessions
              .sendOrResume(pr.session_id!, verifyMsg)
              .catch((err: unknown) =>
                logger.warn(
                  `[PRMergeWatcher] sendOrResume failed for session ${pr.session_id}:`,
                  (err as Error).message,
                ),
              );
          }
        }
        return; // Gated on failing tests — skip GitHub mergeability evaluation
      }
      // No result yet (test hasn't run) or test passed → fall through

      // ── Test-report acquisition failure (non-blocking) ────────────────────
      // Independent of the ci_failing branch above: a declared
      // test_report_glob whose run left structured_result null (missing/
      // malformed report, or the run was killed before teardown) is a
      // manifest/config problem for a human to look at — but it must never
      // block mergeability for a PR whose underlying test exit code passed,
      // so this never returns early.
      if (
        testResult &&
        config.test_report_glob &&
        testResult.structured_result === null &&
        testResult.state !== 'failed'
      ) {
        setPauseReason(
          pr.pr_number,
          pr.repo,
          'test_report_acquisition_failed',
          testResult.output ? testResult.output.slice(0, 1000) : undefined,
        );
      } else if (
        testResult &&
        testResult.structured_result !== null &&
        parsePauseReason(pr.pause_reason)?.reason ===
          'test_report_acquisition_failed'
      ) {
        // A subsequent run successfully acquired a report — clear the stale
        // pause, mirroring tryCIFailingRecovery's clear-on-recovery for
        // ci_failing.
        setPauseReason(pr.pr_number, pr.repo, null);
        this.broadcast({
          type: 'pr_pause_cleared',
          prNumber: pr.pr_number,
          repo: pr.repo,
        });
      }
      // ─────────────────────────────────────────────────────────────────────
    }
    // ─────────────────────────────────────────────────────────────────────────

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
    // clears pause_reason itself; run()'s pause_reason !== null guard still
    // blocks the merge until an already-trusted channel clears the pause.
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
            'dev',
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
    if (parsePauseReason(pr.pause_reason)?.source !== 'ci') return;
    // Trigger recovery for any non-CI-failing, non-conflict category.
    // AutoMerger will re-categorize and bounce back if not actually mergeable.
    if (category.category === 'ci_failed' || category.category === 'conflict')
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
   * Actuate a session's verified-flaky disposition: re-run the same gate on the
   * same commit (no new push) and, on pass, clear the ci_failing pause and
   * re-drive the merge loop — including for a PR that hasn't been approved yet,
   * which the approval-gated poll path (checkMergeability) never reaches.
   * Bounded by flake_recovery_max_retries; exhaustion leaves the PR paused with
   * a flake-recovery-exhausted detail instead of retrying forever.
   */
  async handleVerifiedFlakyDisposition(
    payload: VerifiedFlakyDispositionPayload,
  ): Promise<void> {
    const pr = getPRByNumber(payload.prNumber, payload.repo);
    if (!pr) return;

    // Stale disposition — a new push landed since the session diagnosed the
    // failure. The gate for the new SHA hasn't even run yet; nothing to re-run.
    if (payload.headSha && pr.head_sha !== payload.headSha) {
      logger.info(
        `[PRMergeWatcher] verified-flaky disposition for PR #${pr.pr_number} is stale (sha mismatch) — ignoring`,
      );
      return;
    }

    const pauseStruct = parsePauseReason(pr.pause_reason);
    // Each gate fails under its own distinct pause reason — a disposition
    // must match the reason the PR is actually paused on, otherwise an
    // 'analyze' confirmation would silently no-op against a ci_failing pause
    // (or vice versa) instead of actuating the right same-commit re-run.
    const expectedPauseReason =
      payload.disposition.gate === 'analyze' ? 'analyze_failing' : 'ci_failing';
    if (pauseStruct?.reason !== expectedPauseReason) return;

    const project = getProjectByGithubRepo(pr.repo);
    const projectId = project?.id ?? null;

    const maxRetries = typedGetSetting('flake_recovery_max_retries');
    if (pr.flake_recovery_attempts >= maxRetries) {
      setPauseReason(
        pr.pr_number,
        pr.repo,
        expectedPauseReason,
        'flake-recovery-exhausted',
      );
      recordEvent({
        event_type: 'flake_recovery_exhausted',
        actor_type: 'system',
        project_id: projectId,
        task_id: pr.task_id ?? null,
        payload: {
          pr_number: pr.pr_number,
          repo: pr.repo,
          attempts: pr.flake_recovery_attempts,
          max_retries: maxRetries,
        },
      });
      this.broadcast({
        type: 'pr_flake_recovery_exhausted',
        prNumber: pr.pr_number,
        repo: pr.repo,
        attempts: pr.flake_recovery_attempts,
        maxRetries,
      });
      logger.warn(
        `[PRMergeWatcher] PR #${pr.pr_number}: flake recovery exhausted (${pr.flake_recovery_attempts}/${maxRetries}) — staying paused`,
      );
      return;
    }

    recordEvent({
      event_type: 'flake_recovery_attempted',
      actor_type: 'system',
      project_id: projectId,
      task_id: pr.task_id ?? null,
      payload: {
        pr_number: pr.pr_number,
        repo: pr.repo,
        sha: pr.head_sha,
        gate: payload.disposition.gate,
        reason: payload.disposition.reason,
        attempt: pr.flake_recovery_attempts + 1,
      },
    });

    if (!pr.head_sha) return;
    let outcome: FlakeRecoveryOutcome;

    if (payload.disposition.gate === 'f2') {
      const result = await this.actuateF2Rerun(pr, project);
      if (result === null) return;
      outcome = result;
    } else if (payload.disposition.gate === 'analyze') {
      if (!project || !pr.session_id || !this.reviewOrchestrator) return;
      const session = getSession(pr.session_id);
      const worktreePath = session?.worktree_path ?? '';
      if (!worktreePath) return;
      const result = await this.reviewOrchestrator.rerunFlakyAnalyze(
        pr.pr_number,
        pr.repo,
        pr.head_sha,
        worktreePath,
        project,
      );
      if (!result) return;
      outcome = result.outcome;
    } else {
      let rerequestedIds: number[];
      try {
        rerequestedIds = await this.github.rerunFailedJobs(
          pr.head_sha,
          pr.repo,
        );
      } catch (err) {
        logger.warn(
          `[PRMergeWatcher] rerunFailedJobs failed for PR #${pr.pr_number}:`,
          (err as Error).message,
        );
        return;
      }
      // Wait for the rerequested checks to reach a terminal state — reading
      // categorizeMergeability right after rerequest would observe the
      // freshly-queued check run's transient state, not its real outcome.
      await this.github.waitForCheckRunsCompletion(
        pr.head_sha,
        pr.repo,
        rerequestedIds,
      );

      // Re-verify head_sha immediately before recording the outcome — a push
      // that landed mid-rerun means this result no longer speaks to the SHA
      // the disposition was diagnosed against.
      const current = await this.github.getPRState(pr.pr_number, pr.repo);
      if (current.headSha !== pr.head_sha) {
        outcome = 'inconclusive';
      } else {
        const ciCheckNames = project
          ? loadOrchestratorConfig(project.projectDir).ci_check_name
          : [];
        const category = await this.github.categorizeMergeability(
          pr.pr_number,
          pr.repo,
          ciCheckNames,
        );
        outcome = category.category !== 'ci_failed' ? 'passed' : 'failed';
      }

      recordEvent({
        event_type: 'flake_recovery_ci_rerun',
        actor_type: 'system',
        project_id: projectId,
        task_id: pr.task_id ?? null,
        payload: {
          pr_number: pr.pr_number,
          repo: pr.repo,
          sha: pr.head_sha,
          outcome,
        },
      });
    }

    await this.applyFlakeRecoveryOutcome(pr, outcome, maxRetries);
  }

  /**
   * Actuate a re-run of the F2 (orchestrator-run test) gate against `pr`'s
   * current head_sha — the shared f2 actuation path both a session's
   * flaky.confirm disposition and the lane-side auto-disposition check
   * (tryF2LaneAutoDisposition) reuse rather than duplicate. Returns null
   * when the PR/session/project state can't support a re-run (no session
   * worktree, no reviewOrchestrator wired, etc.) — the caller treats that
   * as "nothing to actuate", not a failure outcome.
   */
  private async actuateF2Rerun(
    pr: PullRequestRow,
    project: ProjectConfig | undefined,
  ): Promise<FlakeRecoveryOutcome | null> {
    if (
      !project ||
      !pr.session_id ||
      !this.reviewOrchestrator ||
      !pr.head_sha
    ) {
      return null;
    }
    const session = getSession(pr.session_id);
    const worktreePath = session?.worktree_path ?? '';
    if (!worktreePath) return null;
    const result = await this.reviewOrchestrator.rerunFlakyTests(
      pr.pr_number,
      pr.repo,
      pr.head_sha,
      worktreePath,
      project,
    );
    return result?.outcome ?? null;
  }

  /**
   * Shared tail of a verified-flaky re-run (any gate): consumes/records the
   * retry budget and, on a passing re-run, clears the pause and re-drives
   * the merge loop. Used by both handleVerifiedFlakyDisposition (session-
   * initiated, all three gates) and tryF2LaneAutoDisposition (lane-initiated,
   * f2 only) so the two callers can't drift on outcome handling.
   */
  private async applyFlakeRecoveryOutcome(
    pr: PullRequestRow,
    outcome: FlakeRecoveryOutcome,
    maxRetries: number,
  ): Promise<void> {
    if (outcome === 'inconclusive') {
      logger.info(
        `[PRMergeWatcher] PR #${pr.pr_number}: verified-flaky re-run inconclusive (head_sha drifted) — not consuming retry budget`,
      );
      return;
    }

    incrementFlakeRecoveryAttempts(pr.pr_number, pr.repo);

    if (outcome === 'passed') {
      resetFlakeRecoveryAttempts(pr.pr_number, pr.repo);
      setPauseReason(pr.pr_number, pr.repo, null);
      this.broadcast({
        type: 'pr_pause_cleared',
        prNumber: pr.pr_number,
        repo: pr.repo,
      });
      logger.info(
        `[PRMergeWatcher] PR #${pr.pr_number}: verified-flaky re-run passed — pause cleared, re-driving merge loop`,
      );
      // checkMergeabilityNow bypasses the approved-verdict gate that
      // checkMergeability enforces, so a not-yet-approved PR is re-driven too.
      await this.checkMergeabilityNow(pr.pr_number, pr.repo);
      this.autoMerger?.attempt(pr.pr_number, pr.repo);
    } else {
      logger.info(
        `[PRMergeWatcher] PR #${pr.pr_number}: verified-flaky re-run still failing (attempt ${pr.flake_recovery_attempts + 1}/${maxRetries})`,
      );
    }
  }

  /**
   * Lane-side, f2-only auto-disposition: intercepts an F2 (orchestrator-run
   * test gate) failure right before it would otherwise pause the PR and nudge
   * the session (poll()'s "Orchestrator-run test gate (F2)" block above).
   * Per the locked design, this is per-test, not whole-run — every failing
   * test in `testResult` must clear both masking guards (flip-rate flag +
   * not-the-flagged-test's-own-file + flip-rate window predating this PR)
   * before actuation fires; a single unflagged/guard-blocked failure falls
   * through to the unmodified session pause+nudge path.
   *
   * Returns true only when the re-run this triggers actually passed (pause
   * cleared, merge loop re-driven) — the caller must still pause+nudge on
   * false, whether that's because no test qualified or because the re-run
   * (having been attempted) still failed.
   */
  private async tryF2LaneAutoDisposition(
    pr: PullRequestRow,
    project: ProjectConfig,
    testResult: TestRequestRunRow,
    worktreePath: string,
  ): Promise<boolean> {
    const maxRetries = typedGetSetting('flake_recovery_max_retries');
    if (pr.flake_recovery_attempts >= maxRetries) return false;

    // The flip-rate window's masking guard requires samples predating this
    // PR's first run — pull_requests.created_at (set once, at PR open, always
    // before any push-triggered F2 run for this PR) is the cutoff.
    const prCreatedAtMs = pr.created_at ? Date.parse(pr.created_at) : NaN;
    if (!Number.isFinite(prCreatedAtMs)) return false;

    let changedFiles: string[];
    try {
      changedFiles = await getChangedFiles(
        worktreePath,
        pr.base_branch ?? 'dev',
      );
    } catch (err) {
      logger.warn(
        `[PRMergeWatcher] PR #${pr.pr_number}: getChangedFiles failed for f2 lane auto-disposition: ${(err as Error).message}`,
      );
      return false;
    }

    const eligible = evaluateF2LaneFlakyDisposition(
      testResult.id,
      prCreatedAtMs,
      changedFiles,
      typedGetSetting('flip_rate_window_n'),
      typedGetSetting('flip_rate_threshold_k'),
    );
    if (!eligible) return false;

    recordEvent({
      event_type: 'flake_recovery_attempted',
      actor_type: 'system',
      project_id: project.id,
      task_id: pr.task_id ?? null,
      payload: {
        pr_number: pr.pr_number,
        repo: pr.repo,
        sha: pr.head_sha,
        gate: 'f2',
        reason: 'lane_auto_disposition',
        attempt: pr.flake_recovery_attempts + 1,
      },
    });

    const outcome = await this.actuateF2Rerun(pr, project);
    if (outcome === null) return false;
    await this.applyFlakeRecoveryOutcome(pr, outcome, maxRetries);
    return outcome === 'passed';
  }

  /**
   * Handle a push event for the given PR — either triggered by a coding session's
   * push_detected WS event (via the thin server.ts wrapper) or by PRMergeWatcher
   * detecting an out-of-band head_sha change during polling.
   *
   * The prRow should be freshly loaded from the DB before calling so that
   * head_sha and other fields reflect the current state.
   */
  async handlePushDetected(prRow: PullRequestRow): Promise<void> {
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
          if (headSha !== prRow.head_sha) {
            setHeadSha(prRow.pr_number, prRow.repo, headSha);
            // A fix was actually pushed — the load-bearing signal that
            // un-sticks a stalled_reconcile_cap escalation, independent of
            // whatever verdict the re-review below produces.
            if (
              parsePauseReason(prRow.pause_reason)?.reason ===
              'stalled_reconcile_cap'
            ) {
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

    if (this.pendingReReviews.has(sessionId)) {
      logger.info(
        `[PRMergeWatcher] handlePushDetected: already pending for session ${sessionId.slice(0, 8)}`,
      );
      return;
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

    if (!prRow.review_session_id) {
      // Gate-failure verdicts (autofix_failed / verify_failed) set review_session_id=NULL
      // because the gate runs before any review session is spawned. A push arriving after
      // a gate failure must trigger a fresh review directly — pending_push would be a
      // dead letter since no initial review is coming to consume it.
      const currentVerdict = parseVerdictFromResult(prRow.review_result);
      const isAfterGateFailure =
        currentVerdict === 'autofix_failed' ||
        currentVerdict === 'verify_failed';

      if (
        isAfterGateFailure &&
        this.reviewOrchestrator &&
        !this.reviewOrchestrator.isReviewInFlight(prRow.pr_number, prRow.repo)
      ) {
        const maxIter = this.getMaxReviewIterations();
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
        const project = getProjectByGithubRepo(prRow.repo);
        const session = prRow.session_id
          ? getSession(prRow.session_id)
          : undefined;
        this.reviewOrchestrator.enqueueReview({
          prNumber: prRow.pr_number,
          repo: prRow.repo,
          taskId: prRow.task_id ?? '',
          taskUrl: session?.task_url ?? '',
          contextUrl: project?.contextUrl ?? '',
        });
        logger.info(
          `[PRMergeWatcher] handlePushDetected for PR #${prRow.pr_number}: post-gate-failure push — enqueued review directly`,
        );
        return;
      }

      // Initial review hasn't started yet (or orchestrator unavailable) — queue
      // the push so it triggers re-review after the initial review is established.
      setPendingPush(prRow.pr_number, prRow.repo, 1);
      logger.info(
        `[PRMergeWatcher] handlePushDetected for PR #${prRow.pr_number} before review session established — queued as pending_push`,
      );
      return;
    }

    if (!this.prReviewService || !this.reviewOrchestrator) {
      logger.warn(
        `[PRMergeWatcher] handlePushDetected: prReviewService or reviewOrchestrator not set — skipping re-review for PR #${prRow.pr_number}`,
      );
      return;
    }

    // Add to pendingReReviews synchronously (before first await) to prevent
    // concurrent re-reviews for the same session.
    this.pendingReReviews.set(sessionId, Date.now());

    void (async () => {
      try {
        // Skip re-review when the only push since the last review was the autofix
        // commit — the code at that SHA was already reviewed in executeReview().
        if (
          headSha &&
          this.reviewOrchestrator!.consumeAutofixSha(
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

        const iteration = prRow.review_iteration + 1;

        // Run autofix + pollution-check on every push, same as first review.
        await this.reviewOrchestrator!.runAutofixPipeline(
          prRow.pr_number,
          prRow.repo,
          prRow.task_id,
        );

        // Run orchestrator tests for the new SHA so F2 can gate on the fresh result.
        {
          const pushProject = getProjectByGithubRepo(prRow.repo);
          if (pushProject && headSha) {
            const pushConfig = loadOrchestratorConfig(pushProject.projectDir);
            if (pushConfig.test.length > 0) {
              const pushSession = getSession(prRow.session_id!);
              const worktreePath = pushSession?.worktree_path ?? '';
              if (worktreePath) {
                await this.reviewOrchestrator!.runTestPipeline(
                  prRow.pr_number,
                  prRow.repo,
                  headSha,
                  worktreePath,
                  pushConfig.test,
                  pushConfig.test_timeout_sec,
                  pushConfig.test_max_rss_mb,
                  pushConfig.test_fail_fast,
                );
              }
            }
          }
        }

        try {
          let result: PRReviewResult;
          try {
            // Build a resettable timeout so a large-model escalation (which restarts
            // the review session on a 1M-context model) doesn't cause a false timeout.
            const reviewSessionId = prRow.review_session_id ?? null;
            let reviewTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
            let escalationListener: ((msg: ServerMessage) => void) | undefined;

            const timeoutPromise = new Promise<never>((_, reject) => {
              const arm = () => {
                clearTimeout(reviewTimeoutHandle);
                reviewTimeoutHandle = setTimeout(
                  () => reject(new Error('Re-review timed out')),
                  PUSH_REVIEW_TIMEOUT_MS,
                );
              };
              arm();

              if (reviewSessionId) {
                escalationListener = (msg: ServerMessage) => {
                  if (
                    msg.type === 'large_model_escalation_started' &&
                    msg.sessionId === reviewSessionId
                  ) {
                    logger.info(
                      `[PRMergeWatcher] review session ${reviewSessionId.slice(0, 8)} escalated to 1M model — resetting re-review timeout`,
                    );
                    arm();
                  }
                };
                this.sessions.on('message', escalationListener);
              }
            });

            try {
              const reviewProject = getProjectByGithubRepo(prRow.repo);
              if (!reviewProject) {
                logger.warn(
                  `[PRMergeWatcher] no project for repo ${prRow.repo} — skipping push re-review`,
                );
                return;
              }
              result = await Promise.race([
                this.prReviewService!.reReviewPR(
                  prRow.pr_number,
                  prRow.repo,
                  reviewProject.id,
                  reviewProject.contextUrl,
                ),
                timeoutPromise,
              ]);
            } finally {
              clearTimeout(reviewTimeoutHandle);
              if (escalationListener) {
                this.sessions.off('message', escalationListener);
              }
            }
          } catch (e) {
            const summary = e instanceof Error ? e.message : String(e);
            logger.error(
              `[PRMergeWatcher] re-review failed for PR #${prRow.pr_number}:`,
              e,
            );
            setPauseReason(prRow.pr_number, prRow.repo, 'review_failed');
            const failMessage = `Re-review for PR #${prRow.pr_number} failed: ${summary}`;
            this.broadcast({
              type: 'review_failed',
              prNumber: prRow.pr_number,
              repo: prRow.repo,
              message: failMessage,
            });
            setPRReviewResult(
              prRow.pr_number,
              prRow.repo,
              JSON.stringify({ verdict: 'error', summary, dimensions: [] }),
            );
            this.broadcast({
              type: 'review_verdict',
              prNumber: prRow.pr_number,
              repo: prRow.repo,
              verdict: 'error',
              summary,
              iteration,
            });
            return;
          }

          setLastReviewedSha(prRow.pr_number, prRow.repo, headSha);
          if (result.verdict === 'approved') {
            clearTerminalPRFlags(prRow.pr_number, prRow.repo, 'review_verdict');
          }
          this.broadcast({
            type: 'review_verdict',
            prNumber: prRow.pr_number,
            repo: prRow.repo,
            verdict: result.verdict,
            summary: result.summary,
            iteration,
          });

          if (result.verdict === 'needs_changes') {
            try {
              await this.sessions.sendOrResume(
                sessionId,
                formatReviewFeedback(result, iteration, {
                  conflicted: prRow.merge_state === 'dirty',
                  baseBranch: prRow.base_branch ?? undefined,
                }),
              );
            } catch (e) {
              logger.warn(
                `[PRMergeWatcher] Failed to deliver review feedback to session ${sessionId}:`,
                e,
              );
            }
          } else if (result.verdict === 'incomplete') {
            const message = `Review for PR #${prRow.pr_number} returned an incomplete verdict — the reviewer could not assess the PR. Manual intervention needed.`;
            logger.warn(`[PRMergeWatcher] ${message}`);
            this.broadcast({
              type: 'review_incomplete',
              prNumber: prRow.pr_number,
              repo: prRow.repo,
              message,
            });
            // Notify the implementing session so it knows to push a clearer version.
            try {
              await this.sessions.sendOrResume(
                sessionId,
                formatReviewFeedback(result, iteration, {
                  conflicted: prRow.merge_state === 'dirty',
                  baseBranch: prRow.base_branch ?? undefined,
                }),
              );
            } catch (e) {
              logger.warn(
                `[PRMergeWatcher] Failed to deliver incomplete review feedback to session ${sessionId}:`,
                e,
              );
            }
          }
        } finally {
          this.pendingReReviews.delete(sessionId);
        }
      } catch (e) {
        logger.error(
          `[PRMergeWatcher] handlePushDetected unexpected error for session ${sessionId.slice(0, 8)}:`,
          e,
        );
      } finally {
        this.pendingReReviews.delete(sessionId);
      }
    })();
  }

  private sweepStalePendingReReviews(): void {
    const now = Date.now();
    for (const [sid, addedAt] of this.pendingReReviews) {
      if (now - addedAt > PENDING_REREVIEW_TTL_MS) {
        logger.warn(
          `[PRMergeWatcher] sweeping stale pendingReReview for session ${sid.slice(0, 8)} (age ${Math.round((now - addedAt) / 1000)}s)`,
        );
        this.pendingReReviews.delete(sid);
      }
    }
  }

  /**
   * Heals dead-letter pending_push rows: PRs that have pending_push=1 but no
   * review in flight (e.g. pushed after gate-failure, or after a backend restart
   * interrupted the consumption path). Consumes the flag and enqueues a review.
   */
  private sweepPendingPushDeadLetters(): void {
    if (!AUTO_REVIEW_ENABLED || !this.reviewOrchestrator) return;
    const prs = getAllOpenPRs();
    for (const pr of prs) {
      if (!pr.pending_push) continue;
      if (this.reviewOrchestrator.isReviewInFlight(pr.pr_number, pr.repo))
        continue;
      if (pr.session_id && this.pendingReReviews.has(pr.session_id)) continue;

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
      });
      logger.info(
        `[PRMergeWatcher] sweepPendingPushDeadLetters: consumed pending_push for PR #${pr.pr_number} — review enqueued`,
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
