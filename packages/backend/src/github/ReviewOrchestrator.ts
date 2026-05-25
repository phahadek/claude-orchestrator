import { getProjectByGithubRepo, getProjectById } from '../config';
import {
  setPRReviewResult,
  getSetting,
  getPRByNumber,
  setPendingPush,
  setPauseReason,
  getLocalBranchBySession,
  setLocalBranchPauseReason,
  getSession,
} from '../db/queries';
import type {
  PRReviewService,
  PRReviewResult,
  WorkItem,
} from './PRReviewService';
import type { SessionManager } from '../session/SessionManager';
import type { GitHubClient } from './GitHubClient';
import type { ReviewJob } from './types';
import { GitHubDiffSource, LocalDiffSource } from './DiffSource';
import { formatReviewFeedback, formatCIFailureFeedback } from './reviewUtils';
import { runVerifyAsGate } from '../orchestration/verifyRunner';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import type { ServerMessage } from '../ws/types';

const REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ITERATIONS = 3;

function getMaxReviewIterations(): number {
  const raw = getSetting('max_review_iterations');
  if (!raw) return DEFAULT_MAX_ITERATIONS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_ITERATIONS;
}

interface LocalBranchJob {
  type: 'local_branch';
  localBranchId: number;
  projectId: string;
  sessionId: string;
  branchName: string;
  baseBranch: string;
  worktreePath: string;
  taskId: string | null;
  contextUrl: string;
}

type QueuedJob = (ReviewJob & { type?: 'pr' }) | LocalBranchJob;

export class ReviewOrchestrator {
  private queue: QueuedJob[] = [];
  private running = 0;

  constructor(
    private reviewService: PRReviewService,
    private sessionManager: SessionManager,
    private maxConcurrency: number = 1,
    private enabled: boolean = true,
    private github?: GitHubClient,
  ) {
    sessionManager.on('pr_opened', (job: ReviewJob) => this.onPrOpened(job));
    sessionManager.on('message', (msg: ServerMessage) => this.onMessage(msg));
  }

  private onPrOpened(job: ReviewJob): void {
    if (!this.enabled) return;
    if (!job.taskId) {
      console.warn(
        `[ReviewOrchestrator] PR #${job.prNumber} has no Notion task — skipping`,
      );
      return;
    }
    this.queue.push(job);
    void this.drain();
  }

  private onMessage(msg: ServerMessage): void {
    if (!this.enabled) return;
    if (msg.type !== 'local_branch_submitted') return;

    const { projectId, sessionId, branchName, baseBranch } = msg;

    const sessionRow = getSession(sessionId);
    if (!sessionRow?.worktree_path) {
      console.warn(
        `[ReviewOrchestrator] local_branch_submitted for session ${sessionId} — no worktree_path, skipping`,
      );
      return;
    }

    const localBranchRow = getLocalBranchBySession(sessionId);
    if (!localBranchRow) {
      console.warn(
        `[ReviewOrchestrator] local_branch_submitted for session ${sessionId} — no local_branch row found, skipping`,
      );
      return;
    }

    const project = getProjectById(projectId);
    const contextUrl = project?.contextUrl ?? '';

    this.queue.push({
      type: 'local_branch',
      localBranchId: localBranchRow.id,
      projectId,
      sessionId,
      branchName,
      baseBranch,
      worktreePath: sessionRow.worktree_path,
      taskId: sessionRow.notion_task_id,
      contextUrl,
    });
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      this.running++;
      const job = this.queue.shift()!;
      try {
        if (job.type === 'local_branch') {
          await this.executeLocalBranchReview(job);
        } else {
          await this.executeReview(job as ReviewJob);
        }
      } catch (e) {
        if (job.type === 'local_branch') {
          console.error(
            `[ReviewOrchestrator] review failed for local branch ${job.branchName}:`,
            e,
          );
        } else {
          const prJob = job as ReviewJob;
          console.error(
            `[ReviewOrchestrator] review failed for PR #${prJob.prNumber}:`,
            e,
          );
        }
      } finally {
        this.running--;
        void this.drain();
      }
    }
  }

  private async executeLocalBranchReview(job: LocalBranchJob): Promise<void> {
    const project = getProjectById(job.projectId);
    if (project) {
      const config = loadOrchestratorConfig(project.projectDir);
      const verifyResult = await runVerifyAsGate(
        job.worktreePath,
        config.verify,
      );
      if (!verifyResult.passed) {
        setLocalBranchPauseReason(job.localBranchId, 'ci_failing');
        this.sessionManager.send(
          job.sessionId,
          formatCIFailureFeedback({
            source: 'verify',
            failedCommand: verifyResult.failedCommand,
            truncatedOutput: verifyResult.truncatedOutput,
          }),
        );
        return;
      }
    }

    const diffSource = new LocalDiffSource(
      job.worktreePath,
      job.baseBranch,
      job.branchName,
    );

    const workItem: WorkItem = {
      type: 'local_branch',
      localBranchId: job.localBranchId,
      branchName: job.branchName,
      baseBranch: job.baseBranch,
      sessionId: job.sessionId,
      taskId: job.taskId,
    };

    let result: PRReviewResult;
    try {
      result = await Promise.race([
        this.reviewService.reviewPR(
          workItem,
          diffSource,
          job.projectId,
          job.contextUrl,
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Review timed out')),
            REVIEW_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (e) {
      const summary =
        e instanceof Error && e.message === 'Review timed out'
          ? 'Review timed out'
          : String(e);
      this.sessionManager.emit('message', {
        type: 'pr_review_complete',
        prNumber: job.localBranchId,
        repo: `local/${job.branchName}`,
        verdict: 'error',
        summary,
      });
      return;
    }

    this.sessionManager.emit('message', {
      type: 'pr_review_complete',
      prNumber: job.localBranchId,
      repo: `local/${job.branchName}`,
      verdict: result.verdict,
      summary: result.summary,
    });

    if (result.verdict === 'needs_changes') {
      this.sessionManager.send(job.sessionId, formatReviewFeedback(result, 0));
    }
  }

  private async executeReview(job: ReviewJob): Promise<void> {
    const project = getProjectByGithubRepo(job.repo);
    if (!project) {
      console.warn(
        `[ReviewOrchestrator] PR #${job.prNumber}: no project found for repo ${job.repo} — skipping`,
      );
      return;
    }

    // Check iteration cap before starting a review
    const prRow = getPRByNumber(job.prNumber, job.repo);
    const maxIterations = getMaxReviewIterations();
    if (prRow && prRow.review_iteration >= maxIterations) {
      const message = `Review loop for PR #${job.prNumber} reached ${maxIterations} iterations without approval. Manual intervention needed.`;
      console.warn(`[ReviewOrchestrator] ${message}`);
      setPauseReason(job.prNumber, job.repo, 'max_reviews');
      this.sessionManager.emit('message', {
        type: 'review_escalated',
        prNumber: job.prNumber,
        repo: job.repo,
        message,
      });
      return;
    }

    const diffSource = this.github
      ? new GitHubDiffSource(this.github, job.repo, job.prNumber)
      : {
          fetchDiff: async () => {
            throw new Error('No GitHub client available for diff');
          },
        };

    const workItem: WorkItem = {
      type: 'pr',
      prNumber: job.prNumber,
      repo: job.repo,
    };

    let result: PRReviewResult;
    try {
      result = await Promise.race([
        this.reviewService.reviewPR(
          workItem,
          diffSource,
          project.id,
          job.contextUrl,
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Review timed out')),
            REVIEW_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (e) {
      const summary =
        e instanceof Error && e.message === 'Review timed out'
          ? 'Review timed out'
          : String(e);
      setPRReviewResult(
        job.prNumber,
        job.repo,
        JSON.stringify({ verdict: 'error', summary, dimensions: [] }),
      );
      this.sessionManager.emit('message', {
        type: 'pr_review_complete',
        prNumber: job.prNumber,
        repo: job.repo,
        verdict: 'error',
        summary,
      });
      return;
    }

    // Draft transition and Notion update are handled inside reviewService.reviewPR()
    // via handleApprovedVerdict. Derive draftTransitioned from the pre-review row so
    // we can include draft: false in the broadcast when applicable.
    const draftTransitioned =
      result.verdict === 'approved' && prRow?.draft === 1;

    this.sessionManager.emit('message', {
      type: 'pr_review_complete',
      prNumber: job.prNumber,
      repo: job.repo,
      verdict: result.verdict,
      summary: result.summary,
      ...(draftTransitioned && { draft: false }),
    });

    // Route feedback to coding session if verdict requires changes
    if (result.verdict === 'needs_changes') {
      const prRow = getPRByNumber(job.prNumber, job.repo);
      if (prRow?.session_id) {
        this.sessionManager.send(
          prRow.session_id,
          formatReviewFeedback(result, 0),
        );
      }
    } else if (result.verdict === 'incomplete') {
      const message = `Review for PR #${job.prNumber} returned an incomplete verdict — the reviewer could not assess the PR. Manual intervention needed.`;
      console.warn(`[ReviewOrchestrator] ${message}`);
      this.sessionManager.emit('message', {
        type: 'review_incomplete',
        prNumber: job.prNumber,
        repo: job.repo,
        message,
      });
    }

    // After the initial review, check if a push arrived during the review window.
    // If so, clear the flag and trigger re-review via push_detected so the
    // standard re-review path (server.ts push_detected handler) handles it,
    // now that review_session_id is populated.
    const postReviewRow = getPRByNumber(job.prNumber, job.repo);
    if (postReviewRow?.pending_push && postReviewRow.session_id) {
      setPendingPush(job.prNumber, job.repo, 0);
      console.log(
        `[ReviewOrchestrator] pending_push detected for PR #${job.prNumber} — triggering re-review`,
      );
      this.sessionManager.emit('push_detected', {
        sessionId: postReviewRow.session_id,
      });
    }
  }
}
