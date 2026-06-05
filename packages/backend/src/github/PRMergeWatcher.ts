import type { GitHubClient } from './GitHubClient';
import type { MergeabilityCategory } from './types';
import { GitHubRateLimitError } from './types';
import type { SessionManager } from '../session/SessionManager';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import { getProjectByGithubRepo } from '../config';
import { AUTO_REVIEW_ENABLED } from '../config';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import { loadAutofixCommands, runAutofix } from '../session/autofix-runner';
import { recordEvent } from '../audit/AuditLog';
import type { ServerMessage } from '../ws/types';
import type { PullRequestRow } from '../db/types';
import type { AutoMerger } from './AutoMerger';
import type { PRReviewService, PRReviewResult } from './PRReviewService';
import type { ReviewOrchestrator } from './ReviewOrchestrator';
import {
  formatCIFailureFeedback,
  shouldAutoReview,
  formatReviewFeedback,
} from './reviewUtils';
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
  getSetting,
  getTestResult,
  markSessionDone,
} from '../db/queries';
import { emitTaskUpdated } from '../routes/tasks';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PUSH_REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

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
]);

export class PRMergeWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
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
  private readonly pendingReReviews = new Set<string>();

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
  ) {}

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
    const raw = getSetting('max_review_iterations');
    if (!raw) return DEFAULT_MAX_REVIEW_ITERATIONS;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_MAX_REVIEW_ITERATIONS;
  }

  private resolveBackendForRepo(repo: string): TaskBackend | undefined {
    if (this.taskBackendOverride) return this.taskBackendOverride;
    const project = getProjectByGithubRepo(repo);
    if (!project) {
      console.warn(
        `[PRMergeWatcher] no project found for repo ${repo} — skipping task backend update`,
      );
      return undefined;
    }
    return getTaskBackend(project.id);
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch((err: unknown) =>
        console.warn('[PRMergeWatcher] poll error:', (err as Error).message),
      );
    }, intervalMs);
    console.log(`[PRMergeWatcher] started (interval=${intervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private handleRateLimit(err: GitHubRateLimitError): void {
    this.pausedUntil = err.resetAt;
    if (!this.rateLimitBroadcasted) {
      this.rateLimitBroadcasted = true;
      console.warn(
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
    const silentMerges = this.firstPollPending;
    const openPRs = getAllOpenPRs();

    // Group PRs by repo, skipping orphan repos that have no project mapping.
    // Orphan PRs produce 404s on every getPRState call and can never be actioned.
    const byRepo = new Map<string, PullRequestRow[]>();
    for (const pr of openPRs) {
      if (!getProjectByGithubRepo(pr.repo)) {
        console.warn(
          `[PRMergeWatcher] PR #${pr.pr_number}: no project for repo ${pr.repo} — skipping poll`,
        );
        continue;
      }
      if (isTerminalStalePR(pr)) {
        console.log(
          `[PRMergeWatcher] PR #${pr.pr_number}: verdict=incomplete with no new push — skipping poll`,
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
        console.warn(
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
      console.warn(
        `[PRMergeWatcher] getPRState failed for PR #${pr.pr_number}:`,
        (err as Error).message,
      );
      return;
    }

    const { state, headSha: githubHeadSha } = prStateResult;

    if (state === 'merged') {
      await this.handleMerged(pr, null, { silent: silentMerges });
    } else if (state === 'closed') {
      updatePRState(pr.pr_number, pr.repo, 'closed');
      deleteAllAutofixShasForPR(pr.pr_number, pr.repo);
      // Transition coding session idle → error on close-without-merge
      if (pr.session_id) {
        this.sessions.markSessionErrored(pr.session_id, 'error', 'pr_closed');
      }
      // End review session gracefully
      if (pr.review_session_id) {
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

  private async processOpenPR(
    pr: PullRequestRow,
    githubHeadSha: string | null,
  ): Promise<void> {
    // Detect out-of-band pushes for any open PR
    if (githubHeadSha && githubHeadSha !== pr.head_sha) {
      console.log(
        `[PRMergeWatcher] PR #${pr.pr_number} head_sha changed: ${pr.head_sha?.slice(0, 7) ?? 'null'} → ${githubHeadSha.slice(0, 7)} — triggering push pipeline`,
      );
      setHeadSha(pr.pr_number, pr.repo, githubHeadSha);
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
    // Skip PRs paused for terminal reasons — AutoMerger has given up or human
    // intervention is needed. Polling GitHub's merge state can't change the outcome.
    if (
      pr.pause_reason !== null &&
      TERMINAL_MERGE_PAUSE_REASONS.has(pr.pause_reason)
    )
      return;

    const project = getProjectByGithubRepo(pr.repo);
    const config = project ? loadOrchestratorConfig(project.projectDir) : null;

    // ── Orchestrator-run test gate (F2) ──────────────────────────────────────
    // When test: commands are configured, the per-SHA test result is the
    // authoritative CI signal — GitHub CI is disabled on private repos so
    // GitHub reports the PR mergeable; we gate on F1's result instead.
    if (config && config.test.length > 0 && pr.head_sha && pr.session_id) {
      const testResult = getTestResult(pr.pr_number, pr.repo, pr.head_sha);
      if (testResult && !testResult.passed) {
        if (pr.ci_remediation_attempted_sha !== pr.head_sha) {
          setCiRemediationAttemptedSha(pr.pr_number, pr.repo, pr.head_sha);
          setPauseReason(pr.pr_number, pr.repo, 'ci_failing');
          await this.runCIFailureRemediation(pr, [], testResult.output);
        }
        return; // Gated on failing tests — skip GitHub mergeability evaluation
      }
      // No result yet (test hasn't run) or test passed → fall through
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
      console.warn(
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
    if (category.category === 'ci_failed' && pr.session_id) {
      if (pr.ci_remediation_attempted_sha !== pr.head_sha) {
        // Reserve this SHA atomically before running remediation so a restart
        // can't re-fire for the same SHA.
        setCiRemediationAttemptedSha(pr.pr_number, pr.repo, pr.head_sha);

        // Check for billing/spending-limit block before sending the investigate prompt.
        if (pr.head_sha) {
          const billingBlock = await this.github
            .detectBillingBlock(pr.head_sha, pr.repo)
            .catch((err: unknown) => {
              console.warn(
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
            console.log(
              `[PRMergeWatcher] PR #${pr.pr_number}: billing/spending limit blocked — paused as ci_billing_blocked`,
            );
            return;
          }
        }

        await this.runCIFailureRemediation(pr, failingNames);
      }
    }

    // Only update + broadcast if something actually changed.
    if (!stateChanged && !failingChecksChanged) {
      this.tryCIFailingRecovery(pr, category);
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

    this.tryCIFailingRecovery(pr, category);

    // Conflict and blocked messages are still gated on state transition.
    if (!stateChanged) return;

    if (category.category === 'conflict') {
      console.log(
        `[PRMergeWatcher] PR #${pr.pr_number} in ${pr.repo} has merge conflicts`,
      );
      if (pr.session_id) {
        const baseBranch = pr.base_branch ?? 'dev';
        const msg = `PR #${pr.pr_number} has merge conflicts with the base branch. Rebase onto \`${baseBranch}\`, resolve the conflicts, and push the fixed branch.`;
        this.sessions
          .sendOrResume(pr.session_id, msg)
          .catch((err: unknown) =>
            console.warn(
              `[PRMergeWatcher] sendOrResume failed for session ${pr.session_id}:`,
              (err as Error).message,
            ),
          );
      }
    } else if (category.category === 'blocked') {
      console.log(
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
    failingNames: string[],
    logExcerpt?: string | null,
  ): Promise<void> {
    console.log(
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
        try {
          const result = await runAutofix(
            worktreePath,
            project!.projectDir,
            autofixCommands,
            (msg) =>
              console.log(
                `[PRMergeWatcher] autofix PR #${pr.pr_number}: ${msg}`,
              ),
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
          console.warn(
            `[PRMergeWatcher] autofix error for PR #${pr.pr_number}:`,
            (err as Error).message,
          );
        }
      }
    }

    const runUrl = `https://github.com/${pr.repo}/pull/${pr.pr_number}/checks`;
    const msg = formatCIFailureFeedback({
      prNumber: pr.pr_number,
      failingCheckNames: failingNames,
      runUrl,
      logExcerpt: logExcerpt ?? null,
    });
    this.sessions
      .sendOrResume(pr.session_id!, msg)
      .catch((err: unknown) =>
        console.warn(
          `[PRMergeWatcher] sendOrResume failed for session ${pr.session_id}:`,
          (err as Error).message,
        ),
      );
  }

  private tryCIFailingRecovery(
    pr: PullRequestRow,
    category: MergeabilityCategory,
  ): void {
    if (
      pr.pause_reason !== 'ci_failing' &&
      pr.pause_reason !== 'ci_billing_blocked'
    )
      return;
    // Trigger recovery for any non-CI-failing, non-conflict category.
    // AutoMerger will re-categorize and bounce back if not actually mergeable.
    if (category.category === 'ci_failed' || category.category === 'conflict')
      return;
    setPauseReason(pr.pr_number, pr.repo, null);
    console.log(
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
   * Handle a push event for the given PR — either triggered by a coding session's
   * push_detected WS event (via the thin server.ts wrapper) or by PRMergeWatcher
   * detecting an out-of-band head_sha change during polling.
   *
   * The prRow should be freshly loaded from the DB before calling so that
   * head_sha and other fields reflect the current state.
   */
  async handlePushDetected(prRow: PullRequestRow): Promise<void> {
    if (!AUTO_REVIEW_ENABLED) {
      console.log('[PRMergeWatcher] handlePushDetected: auto-review disabled');
      return;
    }

    const sessionId = prRow.session_id;
    if (!sessionId) return;

    if (this.pendingReReviews.has(sessionId)) {
      console.log(
        `[PRMergeWatcher] handlePushDetected: already pending for session ${sessionId.slice(0, 8)}`,
      );
      return;
    }

    if (prRow.pause_reason === 'human_changes_requested') {
      // Session addressed human review feedback and pushed — clear the pause so
      // AutoMerger can re-check the review state (re-approve or request more changes).
      setPauseReason(prRow.pr_number, prRow.repo, null);
      this.autoMerger?.attempt(prRow.pr_number, prRow.repo);
      console.log(
        `[PRMergeWatcher] handlePushDetected: human_changes_requested cleared for PR #${prRow.pr_number} — AutoMerger restarted`,
      );
      return;
    }

    if (!prRow.review_session_id) {
      // Initial review hasn't started yet — queue the push so it triggers
      // re-review after the initial review session is established.
      setPendingPush(prRow.pr_number, prRow.repo, 1);
      console.log(
        `[PRMergeWatcher] handlePushDetected for PR #${prRow.pr_number} before review session established — queued as pending_push`,
      );
      return;
    }

    if (!this.prReviewService || !this.reviewOrchestrator) {
      console.warn(
        `[PRMergeWatcher] handlePushDetected: prReviewService or reviewOrchestrator not set — skipping re-review for PR #${prRow.pr_number}`,
      );
      return;
    }

    // Add to pendingReReviews synchronously (before first await) to prevent
    // concurrent re-reviews for the same session.
    this.pendingReReviews.add(sessionId);

    void (async () => {
      let headSha = prRow.head_sha;
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
          }
          break;
        } catch (e) {
          fetchError = e;
          if (attempt === 0) {
            console.warn(
              `[PRMergeWatcher] fetch PR #${prRow.pr_number} failed (attempt 1), retrying...`,
            );
            await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          }
        }
      }
      if (fetchError) {
        console.warn(
          `[PRMergeWatcher] failed to fetch latest PR state for #${prRow.pr_number} after retry:`,
          fetchError,
        );
      }

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
        console.log(
          `[PRMergeWatcher] handlePushDetected: autofix-only push for PR #${prRow.pr_number} — skipping re-review`,
        );
        this.pendingReReviews.delete(sessionId);
        return;
      }

      const maxIter = this.getMaxReviewIterations();

      // Escalation cap reached — emit review_escalated before bailing out.
      if (prRow.review_iteration >= maxIter) {
        const message = `Review loop for PR #${prRow.pr_number} reached ${maxIter} iterations without approval. Manual intervention needed.`;
        console.warn(`[PRMergeWatcher] ${message}`);
        setPauseReason(prRow.pr_number, prRow.repo, 'max_reviews');
        this.broadcast({
          type: 'review_escalated',
          prNumber: prRow.pr_number,
          repo: prRow.repo,
          message,
        });
        this.pendingReReviews.delete(sessionId);
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
      console.log(
        `[PRMergeWatcher] shouldAutoReview: iter=${prRow.review_iteration}/${maxIter} head=${headSha?.slice(0, 7)} lastReviewed=${prRow.last_reviewed_sha?.slice(0, 7)} → ${autoReviewOk}`,
      );
      if (!autoReviewOk) {
        this.pendingReReviews.delete(sessionId);
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
                  console.log(
                    `[PRMergeWatcher] review session ${reviewSessionId.slice(0, 8)} escalated to 1M model — resetting re-review timeout`,
                  );
                  arm();
                }
              };
              this.sessions.on('message', escalationListener);
            }
          });

          try {
            result = await Promise.race([
              this.prReviewService!.reReviewPR(prRow.pr_number, prRow.repo),
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
          console.error(
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
        if (result.verdict === 'approved' && prRow.pause_reason !== null) {
          setPauseReason(prRow.pr_number, prRow.repo, null);
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
              formatReviewFeedback(result, iteration),
            );
          } catch (e) {
            console.warn(
              `[PRMergeWatcher] Failed to deliver review feedback to session ${sessionId}:`,
              e,
            );
          }
        } else if (result.verdict === 'incomplete') {
          const message = `Review for PR #${prRow.pr_number} returned an incomplete verdict — the reviewer could not assess the PR. Manual intervention needed.`;
          console.warn(`[PRMergeWatcher] ${message}`);
          this.broadcast({
            type: 'review_incomplete',
            prNumber: prRow.pr_number,
            repo: prRow.repo,
            message,
          });
        }
      } finally {
        this.pendingReReviews.delete(sessionId);
      }
    })();
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
    deleteAllAutofixShasForPR(pr.pr_number, pr.repo);

    // Delete the origin branch for feature/* branches.
    if (pr.head_branch?.startsWith('feature/')) {
      await this.github
        .deleteBranch(pr.repo, pr.head_branch)
        .catch((err: unknown) =>
          console.warn(
            `[PRMergeWatcher] deleteBranch origin ${pr.head_branch} failed:`,
            (err as Error).message,
          ),
        );
    }

    // Mark the code session done — it was idle (process exited, PR open) and
    // the PR just merged, so this is the terminal done transition.
    if (pr.session_id) {
      markSessionDone(pr.session_id, Date.now(), pr.pr_url ?? null);
    }

    // End coding session gracefully (stdin close → clean CLI exit).
    // Mark it for local branch deletion so cleanupWorktree removes the branch
    // even though a prUrl is set.
    if (pr.session_id) {
      if (pr.head_branch?.startsWith('feature/')) {
        this.sessions.markForBranchDeletion(pr.session_id);
      }
      this.sessions.endSession(pr.session_id);
    }

    // End review session gracefully (stdin close → clean CLI exit)
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
            console.warn(
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
        sha: sha ?? '',
      });
    }
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
