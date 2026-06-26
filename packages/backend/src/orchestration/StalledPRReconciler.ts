import { logger } from '../logger';
import type { Scheduler } from './Scheduler';
import type { ReviewOrchestrator } from '../github/ReviewOrchestrator';
import {
  getAllOpenPRs,
  setPauseReason,
  getSession,
  incrementStalledPRRetryCount,
  clearReviewSessionId,
  deleteAnalyzeResult,
} from '../db/queries';
import { parsePauseReason } from '../db/pauseReason';
import { getProjectByGithubRepo } from '../config';
import { recordEvent } from '../audit/AuditLog';
import type { ServerMessage } from '../ws/types';
import { classifyStalledPR } from '../github/pollUtils';
import type { StalledPRKind } from '../github/pollUtils';

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_RETRY_CAP = 2;

/**
 * Periodic sweeper that detects PRs parked with no incoming push and re-drives
 * them based on their stalled state:
 *
 *  - incomplete_verdict: verdict=incomplete with head_sha unchanged → re-enqueue review
 *  - errored_review_session: review session is error/killed → clear stale session ID and
 *    spawn a fresh review (sidesteps SessionManager's terminal-session refuse)
 *  - gate_failed: autofix_failed/verify_failed with no pending push → re-run gate via enqueueReview
 *
 * Retry bound: after DEFAULT_RETRY_CAP attempts per head_sha the PR is escalated
 * to pause_reason='stalled_reconcile_cap' and left for human intervention.
 * The counter resets automatically when setHeadSha() records a new push.
 *
 * Runs periodically via Scheduler and also at boot via reconcileOnce().
 */
export class StalledPRReconciler {
  private reviewOrchestrator: ReviewOrchestrator | undefined;

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
      // Skip PRs already escalated to the human-attention queue
      const existing = parsePauseReason(pr.pause_reason);
      if (existing?.reason === 'stalled_reconcile_cap') continue;

      // Resolve review session status for the errored-session check
      const reviewSessionStatus = pr.review_session_id
        ? (getSession(pr.review_session_id)?.status ?? null)
        : null;

      const stalled = classifyStalledPR(pr, reviewSessionStatus);
      if (!stalled) continue;

      const count = pr.stalled_pr_retry_count ?? 0;
      if (count >= retryCap) {
        this.escalate(pr.pr_number, pr.repo, stalled.kind, count);
        itemsProcessed++;
        continue;
      }

      const drove = await this.reDrive(
        pr.pr_number,
        pr.repo,
        pr.task_id,
        pr.session_id,
        stalled.kind,
        count,
        pr.head_sha ?? null,
      );
      if (drove) itemsProcessed++;
    }

    if (itemsProcessed > 0) {
      logger.info(
        `[StalledPRReconciler] processed ${itemsProcessed} stalled PR(s)`,
      );
    }
  }

  private async reDrive(
    prNumber: number,
    repo: string,
    taskId: string | null,
    sessionId: string | null,
    kind: StalledPRKind,
    _currentCount: number,
    headSha: string | null,
  ): Promise<boolean> {
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

    const newCount = incrementStalledPRRetryCount(prNumber, repo);
    const project = getProjectByGithubRepo(repo);
    const session = sessionId ? getSession(sessionId) : null;

    logger.info(
      `[StalledPRReconciler] PR #${prNumber} (${repo}): re-driving kind=${kind} (attempt ${newCount}/${this.options.retryCap ?? DEFAULT_RETRY_CAP})`,
    );

    recordEvent({
      event_type: 'stalled_pr_reconcile_attempt',
      actor_type: 'system',
      actor_id: null,
      project_id: project?.id ?? null,
      task_id: taskId ?? null,
      payload: { pr_number: prNumber, repo, kind, attempt: newCount },
    });

    if (kind === 'errored_review_session') {
      // Clear the terminal review_session_id so PRReviewService spawns a fresh
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

    this.reviewOrchestrator.enqueueReview({
      prNumber,
      repo,
      taskId: taskId ?? '',
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

    setPauseReason(prNumber, repo, 'stalled_reconcile_cap');

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
