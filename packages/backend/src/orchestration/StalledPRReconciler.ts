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
} from '../db/queries';
import { parsePauseReason } from '../db/pauseReason';
import { getProjectByGithubRepo } from '../config';
import { recordEvent } from '../audit/AuditLog';
import type { ServerMessage } from '../ws/types';
import type { PullRequestRow } from '../db/types';
import { classifyStalledPR } from '../github/pollUtils';
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
 *  - gate_failed: autofix_failed/verify_failed with no pending push → relaunch the
 *    coding fixer on the PR's existing branch (re-reviewing is futile when the
 *    implementing session is dead — nobody receives the gate-failure feedback)
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

      const stalled = classifyStalledPR(
        pr,
        reviewSessionStatus,
        implementingSessionStatus,
      );
      if (!stalled) continue;

      const count = pr.stalled_pr_retry_count ?? 0;
      if (count >= retryCap) {
        this.escalate(pr.pr_number, pr.repo, stalled.kind, count);
        itemsProcessed++;
        continue;
      }

      const drove = await this.reDrive(pr, stalled.kind, count);
      if (drove) itemsProcessed++;
    }

    if (itemsProcessed > 0) {
      logger.info(
        `[StalledPRReconciler] processed ${itemsProcessed} stalled PR(s)`,
      );
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

    this.reviewOrchestrator.enqueueReview({
      prNumber,
      repo,
      taskId: taskId ?? '',
      taskUrl: session?.task_url ?? '',
      contextUrl: project?.contextUrl ?? '',
    });

    return true;
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
