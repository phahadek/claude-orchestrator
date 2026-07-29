import { logger } from '../logger';
import type { Scheduler } from './Scheduler';
import type { ReviewOrchestrator } from '../github/ReviewOrchestrator';
import type { SessionManager } from '../session/SessionManager';
import type { GitHubClient } from '../github/GitHubClient';
import {
  getAllOpenPRs,
  setPauseReason,
  getSession,
  incrementStalledPRRetryCount,
  clearReviewSessionId,
  deleteAnalyzeResult,
  setHeadSha,
  clearTerminalPRFlags,
  countUndeliveredInboxItems,
  updateMergeState,
  lookupSessionByBranch,
  linkPRTaskAndSession,
  setPendingPush,
} from '../db/queries';
import { parsePauseReason } from '../db/pauseReason';
import { getProjectByGithubRepo } from '../config';
import { typedGetSetting } from '../config/settings';
import { recordEvent } from '../audit/AuditLog';
import type { ServerMessage } from '../ws/types';
import type { PullRequestRow } from '../db/types';
import { classifyStalledPR, parseVerdict } from '../github/pollUtils';
import type { StalledPRKind } from '../github/pollUtils';
import {
  formatCIFailureFeedback,
  formatMergeConflictFeedback,
} from '../github/reviewUtils';

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_RETRY_CAP = 2;

/**
 * Periodic sweeper that detects PRs parked with no incoming push and re-drives
 * them based on their stalled state:
 *
 *  - incomplete_verdict: verdict=incomplete with head_sha unchanged → re-enqueue review
 *  - errored_review_session: review session is error/killed → clear stale session ID and
 *    spawn a fresh review (sidesteps SessionManager's terminal-session refuse)
 *  - gate_failed: autofix_failed/verify_failed → relaunch the coding fixer on
 *    the PR's existing branch (re-reviewing is futile when the implementing
 *    session is dead — nobody receives the gate-failure feedback). If a
 *    pending push is stuck on the PR, consume it and re-drive a fresh review
 *    instead — that push is new content the failed gate never evaluated.
 *  - conflict_dead_session: merge conflict/blocked with a dead implementing
 *    session → relaunch the coding fixer with a rebase prompt
 *
 * Retry bound: after DEFAULT_RETRY_CAP attempts per head_sha the PR is escalated
 * to pause_reason='stalled_reconcile_cap' and left for human intervention.
 * The counter resets automatically when setHeadSha() records a new push.
 *
 * Runs periodically via Scheduler and also at boot via reconcileOnce().
 */
export class StalledPRReconciler {
  private reviewOrchestrator: ReviewOrchestrator | undefined;
  private sessionManager: SessionManager | undefined;
  private githubClient: GitHubClient | undefined;

  constructor(
    private readonly broadcast: (msg: ServerMessage) => void,
    private readonly options: {
      intervalMs?: number;
      retryCap?: number;
    } = {},
  ) {}

  setReviewOrchestrator(ro: ReviewOrchestrator): void {
    this.reviewOrchestrator = ro;
  }

  setSessionManager(sm: SessionManager): void {
    this.sessionManager = sm;
  }

  setGitHubClient(gh: GitHubClient): void {
    this.githubClient = gh;
  }

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'stalled_pr_reconciler',
      intervalMs: () => this.options.intervalMs ?? DEFAULT_INTERVAL_MS,
      concurrency: 'skip-if-running',
      run: async () => {
        await this.reconcileOnce();
      },
      onError: (err: unknown) =>
        logger.warn(
          '[StalledPRReconciler] reconcile error:',
          (err as Error).message,
        ),
    });
  }

  async reconcileOnce(): Promise<void> {
    const openPRs = getAllOpenPRs();
    const retryCap = this.options.retryCap ?? DEFAULT_RETRY_CAP;
    let itemsProcessed = 0;

    for (const pr of openPRs) {
      // The docs execution flow's never-auto-merged gate: an open
      // human_merge_only PR is legitimately waiting for a human merge —
      // never re-drive it (classifyStalledPR also excludes it, but skip the
      // mergeability refresh/session lookups below entirely rather than
      // relying on that alone).
      if (pr.human_merge_only) continue;

      // Skip PRs already escalated to the human-attention queue
      const existing = parsePauseReason(pr.pause_reason);
      if (existing?.reason === 'stalled_reconcile_cap') continue;

      // Resolve review session status for the errored-session check
      const reviewSessionStatus = pr.review_session_id
        ? (getSession(pr.review_session_id)?.status ?? null)
        : null;
      // Resolve the implementing session status for the dead-session conflict check
      const implementingSessionStatus = pr.session_id
        ? (getSession(pr.session_id)?.status ?? null)
        : null;

      // GitHub computes mergeability asynchronously — an approved PR can be
      // recorded as mergeable=0 with a stale merge_state='unknown' from before
      // the check finished. Refresh it here (I/O) before handing the row to
      // the pure classifier.
      let effectivePr = pr;
      if (
        this.githubClient &&
        parseVerdict(pr.review_result) === 'approved' &&
        pr.mergeable === 0 &&
        pr.merge_state === 'unknown'
      ) {
        effectivePr = await this.refreshStaleMergeState(pr);
      }

      const hasUndeliveredFeedback = pr.session_id
        ? countUndeliveredInboxItems(pr.session_id) > 0
        : false;

      const stalled = classifyStalledPR(
        effectivePr,
        reviewSessionStatus,
        implementingSessionStatus,
        hasUndeliveredFeedback,
      );
      if (!stalled) continue;

      const count = effectivePr.stalled_pr_retry_count ?? 0;
      if (count >= retryCap) {
        this.escalate(
          effectivePr.pr_number,
          effectivePr.repo,
          stalled.kind,
          count,
        );
        itemsProcessed++;
        continue;
      }

      const drove = await this.reDrive(effectivePr, stalled.kind, count);
      if (drove) itemsProcessed++;
    }

    if (itemsProcessed > 0) {
      logger.info(
        `[StalledPRReconciler] processed ${itemsProcessed} stalled PR(s)`,
      );
    }
  }

  /**
   * Re-check mergeability via GitHub for a PR whose merge_state='unknown' is
   * stale relative to an already-recorded mergeable=0. Persists the refresh
   * and returns an updated row for the pure classifier to reason about — the
   * I/O happens here so classifyStalledPR stays a pure function.
   */
  private async refreshStaleMergeState(
    pr: PullRequestRow,
  ): Promise<PullRequestRow> {
    if (!this.githubClient) return pr;
    try {
      const category = await this.githubClient.categorizeMergeability(
        pr.pr_number,
        pr.repo,
      );
      // GitHub hasn't finished computing mergeability yet — nothing to refresh.
      if (
        category.category === 'unknown' &&
        category.rawMergeableState === null
      ) {
        return pr;
      }
      const mergeableInt = category.category === 'clean' ? 1 : 0;
      const failingNames = category.failingChecks.map((c) => c.name);
      updateMergeState(
        pr.pr_number,
        pr.repo,
        mergeableInt,
        category.mergeState,
        failingNames.length > 0 ? failingNames : null,
      );
      return {
        ...pr,
        mergeable: mergeableInt,
        merge_state: category.mergeState,
      };
    } catch (err) {
      logger.warn(
        `[StalledPRReconciler] PR #${pr.pr_number} (${pr.repo}): refreshStaleMergeState failed — ${(err as Error).message}`,
      );
      return pr;
    }
  }

  private async reDrive(
    pr: PullRequestRow,
    kind: StalledPRKind,
    _currentCount: number,
  ): Promise<boolean> {
    const { pr_number: prNumber, repo } = pr;
    const taskId = pr.task_id;
    const sessionId = pr.session_id;
    const headSha = pr.head_sha ?? null;

    if (kind === 'gate_failed' || kind === 'conflict_dead_session') {
      return this.reDriveViaFixerRelaunch(pr, kind);
    }

    if (kind === 'undelivered_review_feedback') {
      return this.reDriveViaFeedbackRedelivery(pr);
    }

    if (!this.reviewOrchestrator) {
      logger.warn(
        `[StalledPRReconciler] reviewOrchestrator not set — cannot re-drive PR #${prNumber}`,
      );
      return false;
    }

    if (this.reviewOrchestrator.isReviewInFlight(prNumber, repo)) {
      logger.info(
        `[StalledPRReconciler] PR #${prNumber}: review already in-flight — skipping`,
      );
      return false;
    }

    let effectiveTaskId = taskId;
    let effectiveSessionId = sessionId;
    if (!effectiveTaskId) {
      const derived = pr.head_branch
        ? lookupSessionByBranch(pr.head_branch)
        : null;
      if (derived?.task_id) {
        effectiveTaskId = derived.task_id;
        effectiveSessionId = effectiveSessionId ?? derived.session_id;
        linkPRTaskAndSession(
          prNumber,
          repo,
          derived.task_id,
          derived.session_id,
        );
        logger.info(
          `[StalledPRReconciler] PR #${prNumber} (${repo}): re-derived task_id ${derived.task_id} from head_branch "${pr.head_branch}"`,
        );
      } else {
        this.escalateOrphaned(prNumber, repo);
        return true;
      }
    }

    if (
      kind === 'errored_review_session' ||
      kind === 'pre_review_interrupted'
    ) {
      // Clear any stale review_session_id so PRReviewService spawns a fresh
      // session rather than calling sendOrResume on a terminal session.
      clearReviewSessionId(prNumber, repo);
    }

    if (kind === 'analyze_failing') {
      // Invalidate the per-SHA analyze cache so the pipeline re-runs analyze
      // rather than returning the stale cached failure.
      if (headSha) {
        deleteAnalyzeResult(prNumber, repo, headSha);
      }
      // Clear the pause so it doesn't re-trigger reconciliation after a
      // successful analyze pass. The pipeline will re-set it on next failure.
      setPauseReason(prNumber, repo, null);
    }

    const project = getProjectByGithubRepo(repo);
    const session = effectiveSessionId ? getSession(effectiveSessionId) : null;

    const queued = this.reviewOrchestrator.enqueueReview({
      prNumber,
      repo,
      taskId: effectiveTaskId,
      taskUrl: session?.task_url ?? '',
      contextUrl: project?.contextUrl ?? '',
    });

    if (!queued) {
      logger.warn(
        `[StalledPRReconciler] PR #${prNumber} (${repo}): enqueueReview declined to queue (kind=${kind}) — not counting as an attempt`,
      );
      return false;
    }

    const newCount = incrementStalledPRRetryCount(prNumber, repo);

    logger.info(
      `[StalledPRReconciler] PR #${prNumber} (${repo}): re-driving kind=${kind} (attempt ${newCount}/${this.options.retryCap ?? DEFAULT_RETRY_CAP})`,
    );

    recordEvent({
      event_type: 'stalled_pr_reconcile_attempt',
      actor_type: 'system',
      actor_id: null,
      project_id: project?.id ?? null,
      task_id: effectiveTaskId,
      payload: { pr_number: prNumber, repo, kind, attempt: newCount },
    });

    return true;
  }

  /**
   * Escalates a PR whose task_id is null and could not be re-derived from
   * head_branch. Reported immediately (never after burning retry attempts on
   * a re-drive that enqueueReview would silently no-op) with an honest
   * "orphaned" reason distinct from a retry-cap exhaustion.
   */
  private escalateOrphaned(prNumber: number, repo: string): void {
    const project = getProjectByGithubRepo(repo);

    logger.warn(
      `[StalledPRReconciler] PR #${prNumber} (${repo}): escalating as orphaned — task_id is null and could not be re-derived from head_branch`,
    );

    setPauseReason(
      prNumber,
      repo,
      'stalled_reconcile_cap',
      'orphaned — no task link (task_id null, re-derivation from head_branch failed)',
    );

    recordEvent({
      event_type: 'stalled_pr_escalated',
      actor_type: 'system',
      actor_id: null,
      project_id: project?.id ?? null,
      task_id: null,
      payload: {
        pr_number: prNumber,
        repo,
        kind: 'orphaned_no_task_link',
        retryCount: 0,
      },
    });

    this.broadcast({
      type: 'pr_stalled_escalated',
      prNumber,
      repo,
      kind: 'orphaned_no_task_link',
    });
  }

  /**
   * gate_failed / conflict_dead_session: re-reviewing is futile because the
   * implementing session already died (or is dead-conflicted) — the pre-review
   * gate delivers its fix prompt via SessionManager.send/sendOrResume to that
   * same session, so a fresh review job would just repeat the same silent
   * delivery failure. Relaunch a coding fixer bound to the PR's existing branch
   * instead.
   */
  private async reDriveViaFixerRelaunch(
    pr: PullRequestRow,
    kind: 'gate_failed' | 'conflict_dead_session',
  ): Promise<boolean> {
    const { pr_number: prNumber, repo } = pr;

    if (kind === 'gate_failed') {
      if (pr.pending_push) {
        return this.reDriveViaPendingPushConsume(pr);
      }
      const pushed = await this.reDriveIfPushDetected(pr);
      if (pushed !== null) return pushed;
    }

    if (!this.sessionManager) {
      logger.warn(
        `[StalledPRReconciler] sessionManager not set — cannot relaunch fixer for PR #${prNumber}`,
      );
      return false;
    }

    const newCount = incrementStalledPRRetryCount(prNumber, repo);
    const project = getProjectByGithubRepo(repo);

    logger.info(
      `[StalledPRReconciler] PR #${prNumber} (${repo}): re-driving kind=${kind} via fixer relaunch (attempt ${newCount}/${this.options.retryCap ?? DEFAULT_RETRY_CAP})`,
    );

    recordEvent({
      event_type: 'stalled_pr_reconcile_attempt',
      actor_type: 'system',
      actor_id: null,
      project_id: project?.id ?? null,
      task_id: pr.task_id ?? null,
      payload: { pr_number: prNumber, repo, kind, attempt: newCount },
    });

    const prompt =
      kind === 'conflict_dead_session'
        ? formatMergeConflictFeedback({
            branchName: pr.head_branch ?? `feature/pr-${prNumber}`,
            baseBranch: pr.base_branch ?? 'dev',
          })
        : formatCIFailureFeedback({
            source: 'verify',
            failedCommand: parseGateFailureSummary(pr.review_result),
            truncatedOutput: undefined,
            conflicted: pr.merge_state === 'dirty',
            baseBranch: pr.base_branch ?? 'dev',
          });

    await this.sessionManager.relaunchFixerForPR(pr, prompt);

    return true;
  }

  /**
   * undelivered_review_feedback: needs_changes feedback is sitting in the
   * implementing session's inbox but the session went idle before ever
   * picking it up. Redeliver via SessionManager rather than re-enqueuing a
   * review — the review already happened. Respects the review-iteration cap
   * (max_review_iterations) so this doesn't loop past what PRMergeWatcher's
   * own needs_changes re-review flow would allow.
   */
  private async reDriveViaFeedbackRedelivery(
    pr: PullRequestRow,
  ): Promise<boolean> {
    const { pr_number: prNumber, repo } = pr;

    const maxIter = typedGetSetting('max_review_iterations');
    if (pr.review_iteration >= maxIter) {
      logger.info(
        `[StalledPRReconciler] PR #${prNumber} (${repo}): undelivered_review_feedback at review-iteration cap (${pr.review_iteration}/${maxIter}) — not re-driving`,
      );
      return false;
    }

    if (!this.sessionManager || !pr.session_id) {
      logger.warn(
        `[StalledPRReconciler] sessionManager/session_id not set — cannot redeliver feedback for PR #${prNumber}`,
      );
      return false;
    }

    const newCount = incrementStalledPRRetryCount(prNumber, repo);
    const project = getProjectByGithubRepo(repo);

    logger.info(
      `[StalledPRReconciler] PR #${prNumber} (${repo}): re-driving undelivered_review_feedback (attempt ${newCount}/${this.options.retryCap ?? DEFAULT_RETRY_CAP})`,
    );

    recordEvent({
      event_type: 'stalled_pr_reconcile_attempt',
      actor_type: 'system',
      actor_id: null,
      project_id: project?.id ?? null,
      task_id: pr.task_id ?? null,
      payload: {
        pr_number: prNumber,
        repo,
        kind: 'undelivered_review_feedback',
        attempt: newCount,
      },
    });

    return this.sessionManager.redeliverUndeliveredFeedback(pr.session_id);
  }

  /**
   * gate_failed with pending_push=1: content arrived before the initial review
   * session was established (db.ts:278) and the gate failed without ever
   * seeing it. ReviewOrchestrator.consumePendingPushIfSet no-ops in this case
   * (it requires a live session_id to notify), so the flag is left stuck and
   * the normal push-detected path never fires. Consume it here and re-drive
   * the pipeline directly — the pending push is new content the failed gate
   * hasn't evaluated, so a fresh review (not a fixer relaunch) is the correct
   * re-drive.
   */
  private reDriveViaPendingPushConsume(pr: PullRequestRow): boolean {
    const { pr_number: prNumber, repo } = pr;

    if (!this.reviewOrchestrator) {
      logger.warn(
        `[StalledPRReconciler] reviewOrchestrator not set — cannot re-drive pending_push for PR #${prNumber}`,
      );
      return false;
    }

    const newCount = incrementStalledPRRetryCount(prNumber, repo);
    const project = getProjectByGithubRepo(repo);

    logger.info(
      `[StalledPRReconciler] PR #${prNumber} (${repo}): consuming stuck pending_push and re-driving gate_failed pipeline (attempt ${newCount}/${this.options.retryCap ?? DEFAULT_RETRY_CAP})`,
    );

    recordEvent({
      event_type: 'stalled_pr_reconcile_attempt',
      actor_type: 'system',
      actor_id: null,
      project_id: project?.id ?? null,
      task_id: pr.task_id ?? null,
      payload: {
        pr_number: prNumber,
        repo,
        kind: 'gate_failed_pending_push',
        attempt: newCount,
      },
    });

    setPendingPush(prNumber, repo, 0);

    const session = pr.session_id ? getSession(pr.session_id) : null;
    this.reviewOrchestrator.enqueueReview({
      prNumber,
      repo,
      taskId: pr.task_id ?? '',
      taskUrl: session?.task_url ?? '',
      contextUrl: project?.contextUrl ?? '',
    });

    return true;
  }

  /**
   * gate_failed only: a session can respond to a gate failure by pushing a fix
   * rather than dying, and PRMergeWatcher skips parked PRs entirely (see
   * isTerminalStalePR), so that push is never observed. Check remote HEAD
   * directly — if it has advanced past the recorded head_sha, treat it exactly
   * like PRMergeWatcher's own push detection (adopt the sha, clear terminal
   * flags, re-run the gate) instead of relaunching an already-done fixer.
   *
   * Returns null when no push was detected (caller should fall through to the
   * fixer relaunch), or a boolean when this method fully handled the PR.
   */
  private async reDriveIfPushDetected(
    pr: PullRequestRow,
  ): Promise<boolean | null> {
    const { pr_number: prNumber, repo } = pr;

    if (!this.githubClient || !pr.head_sha) return null;

    let remote: { headSha: string | null };
    try {
      remote = await this.githubClient.getPRState(prNumber, repo);
    } catch (err) {
      logger.warn(
        `[StalledPRReconciler] PR #${prNumber} (${repo}): getPRState failed — ${(err as Error).message}`,
      );
      return null;
    }

    if (!remote.headSha || remote.headSha === pr.head_sha) return null;

    logger.info(
      `[StalledPRReconciler] PR #${prNumber} (${repo}): detected push during gate_failed (${pr.head_sha.slice(0, 7)} → ${remote.headSha.slice(0, 7)}) — re-running gate instead of relaunching fixer`,
    );

    if (!this.reviewOrchestrator) {
      logger.warn(
        `[StalledPRReconciler] reviewOrchestrator not set — cannot re-run gate for PR #${prNumber}`,
      );
      return null;
    }

    setHeadSha(prNumber, repo, remote.headSha);
    clearTerminalPRFlags(prNumber, repo, 'head_sha_advance');

    const project = getProjectByGithubRepo(repo);
    const session = pr.session_id ? getSession(pr.session_id) : null;

    recordEvent({
      event_type: 'stalled_pr_reconcile_attempt',
      actor_type: 'system',
      actor_id: null,
      project_id: project?.id ?? null,
      task_id: pr.task_id ?? null,
      payload: {
        pr_number: prNumber,
        repo,
        kind: 'gate_failed_push_detected',
        head_sha: remote.headSha,
      },
    });

    this.reviewOrchestrator.enqueueReview({
      prNumber,
      repo,
      taskId: pr.task_id ?? '',
      taskUrl: session?.task_url ?? '',
      contextUrl: project?.contextUrl ?? '',
    });

    return true;
  }

  private escalate(
    prNumber: number,
    repo: string,
    kind: StalledPRKind,
    retryCount: number,
  ): void {
    const project = getProjectByGithubRepo(repo);

    logger.warn(
      `[StalledPRReconciler] PR #${prNumber} (${repo}): escalating to needs_attention (kind=${kind}, retryCount=${retryCount})`,
    );

    const detail = `${kind} — ${retryCount} fixer attempts exhausted`;
    setPauseReason(prNumber, repo, 'stalled_reconcile_cap', detail);

    recordEvent({
      event_type: 'stalled_pr_escalated',
      actor_type: 'system',
      actor_id: null,
      project_id: project?.id ?? null,
      task_id: null,
      payload: { pr_number: prNumber, repo, kind, retryCount },
    });

    this.broadcast({
      type: 'pr_stalled_escalated',
      prNumber,
      repo,
      kind,
    });
  }
}

/** Extract the gate-failure summary persisted by PreReviewPipeline, if any. */
function parseGateFailureSummary(
  reviewResult: string | null,
): string | undefined {
  if (!reviewResult) return undefined;
  try {
    return (JSON.parse(reviewResult) as { summary?: string }).summary;
  } catch {
    return undefined;
  }
}
