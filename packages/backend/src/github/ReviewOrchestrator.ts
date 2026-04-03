import { config } from '../config';
import { setPRReviewResult, getSetting, getPRByNumber, incrementReviewIteration } from '../db/queries';
import type { PRReviewService, PRReviewResult } from './PRReviewService';
import type { SessionManager } from '../session/SessionManager';
import type { ReviewJob } from './types';
import type { GitHubClient } from './GitHubClient';
import type { NotionClient } from '../notion/NotionClient';
import { formatReviewFeedback } from './reviewUtils';

const REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ITERATIONS = 3;

function getMaxReviewIterations(): number {
  const raw = getSetting('max_review_iterations');
  if (!raw) return DEFAULT_MAX_ITERATIONS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ITERATIONS;
}

export class ReviewOrchestrator {
  private queue: ReviewJob[] = [];
  private running = 0;

  constructor(
    private reviewService: PRReviewService,
    private sessionManager: SessionManager,
    private githubClient: GitHubClient,
    private notionClient: NotionClient,
    private maxConcurrency: number = 1,
    private enabled: boolean = true,
    private maxIterations: number = DEFAULT_MAX_ITERATIONS,
  ) {
    sessionManager.on('pr_opened', (job: ReviewJob) => this.onPrOpened(job));
  }

  private onPrOpened(job: ReviewJob): void {
    if (!this.enabled) return;
    if (!job.taskId) {
      console.warn(`[ReviewOrchestrator] PR #${job.prNumber} has no Notion task — skipping`);
      return;
    }
    this.queue.push(job);
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      this.running++;
      const job = this.queue.shift()!;
      try {
        await this.executeReview(job);
      } catch (e) {
        console.error(`[ReviewOrchestrator] review failed for PR #${job.prNumber}:`, e);
      } finally {
        this.running--;
        void this.drain();
      }
    }
  }

  private async executeReview(job: ReviewJob): Promise<void> {
    const project = config.projects.find((p) => p.githubRepo === job.repo);
    if (!project) {
      console.warn(`[ReviewOrchestrator] PR #${job.prNumber}: no project found for repo ${job.repo} — skipping`);
      return;
    }

    // Check iteration cap before starting a review
    const prRow = getPRByNumber(job.prNumber, job.repo);
    const maxIterations = getMaxReviewIterations();
    if (prRow && prRow.review_iteration >= maxIterations) {
      const message = `Review loop for PR #${job.prNumber} reached ${maxIterations} iterations without approval. Manual intervention needed.`;
      console.warn(`[ReviewOrchestrator] ${message}`);
      this.sessionManager.emit('message', {
        type: 'review_escalated',
        prNumber: job.prNumber,
        repo: job.repo,
        message,
      });
      return;
    }

    // Increment iteration counter before starting the review
    incrementReviewIteration(job.prNumber, job.repo);

    let result: PRReviewResult;
    try {
      result = await Promise.race([
        this.reviewService.reviewPR(job.prNumber, job.repo, project.id, job.contextUrl),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Review timed out')), REVIEW_TIMEOUT_MS),
        ),
      ]);
    } catch (e) {
      const summary = e instanceof Error && e.message === 'Review timed out'
        ? 'Review timed out'
        : String(e);
      setPRReviewResult(job.prNumber, job.repo, JSON.stringify({ verdict: 'error', summary, dimensions: [] }));
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
    const draftTransitioned = result.verdict === 'approved' && prRow?.draft === 1;

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
        this.sessionManager.send(prRow.session_id, formatReviewFeedback(result, 0));
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
  }

}
