import { config } from '../config';
import { setPRReviewResult, getPRByNumber, getPRBySessionId, incrementReviewIteration } from '../db/queries';
import type { PRReviewService, PRReviewResult } from './PRReviewService';
import type { SessionManager } from '../session/SessionManager';
import type { ReviewJob } from './types';

const REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ITERATIONS = 3;

export class ReviewOrchestrator {
  private queue: ReviewJob[] = [];
  private running = 0;
  /** Coding session IDs currently undergoing a re-review, to prevent duplicate triggers. */
  private pendingReReviews = new Set<string>();

  constructor(
    private reviewService: PRReviewService,
    private sessionManager: SessionManager,
    private maxConcurrency: number = 1,
    private enabled: boolean = true,
    private maxIterations: number = DEFAULT_MAX_ITERATIONS,
  ) {
    sessionManager.on('pr_opened', (job: ReviewJob) => this.onPrOpened(job));
    sessionManager.on('push_detected', ({ sessionId }: { sessionId: string }) =>
      this.onPushDetected(sessionId),
    );
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
      setPRReviewResult(job.prNumber, job.repo, JSON.stringify({ verdict: 'error', summary }));
      this.sessionManager.emit('message', {
        type: 'pr_review_complete',
        prNumber: job.prNumber,
        repo: job.repo,
        verdict: 'error',
        summary,
      });
      return;
    }

    this.sessionManager.emit('message', {
      type: 'pr_review_complete',
      prNumber: job.prNumber,
      repo: job.repo,
      verdict: result.verdict,
      summary: result.summary,
    });

    // Route feedback to coding session if verdict requires changes
    if (result.verdict === 'needs_changes' || result.verdict === 'incomplete') {
      const prRow = getPRByNumber(job.prNumber, job.repo);
      if (prRow?.session_id) {
        this.sendFeedbackToCodingSession(prRow.session_id, result, 0);
      }
    }
  }

  private async onPushDetected(codingSessionId: string): Promise<void> {
    if (!this.enabled) return;
    if (this.pendingReReviews.has(codingSessionId)) return;

    const prRow = getPRBySessionId(codingSessionId);
    if (!prRow || prRow.state !== 'open') return;
    if (!prRow.review_session_id) return;

    this.pendingReReviews.add(codingSessionId);
    try {
      const iteration = incrementReviewIteration(prRow.pr_number, prRow.repo);

      let result: PRReviewResult;
      try {
        result = await Promise.race([
          this.reviewService.sendReReview(
            prRow.review_session_id,
            prRow.pr_number,
            prRow.repo,
            iteration,
            this.maxIterations,
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Re-review timed out')), REVIEW_TIMEOUT_MS),
          ),
        ]);
      } catch (e) {
        const summary = e instanceof Error ? e.message : String(e);
        console.error(`[ReviewOrchestrator] re-review failed for PR #${prRow.pr_number}:`, e);
        setPRReviewResult(prRow.pr_number, prRow.repo, JSON.stringify({ verdict: 'error', summary }));
        this.sessionManager.emit('message', {
          type: 'review_verdict',
          prNumber: prRow.pr_number,
          repo: prRow.repo,
          verdict: 'error',
          summary,
          iteration,
        });
        return;
      }

      this.sessionManager.emit('message', {
        type: 'review_verdict',
        prNumber: prRow.pr_number,
        repo: prRow.repo,
        verdict: result.verdict,
        summary: result.summary,
        iteration,
      });

      if (result.verdict === 'needs_changes' || result.verdict === 'incomplete') {
        this.sendFeedbackToCodingSession(codingSessionId, result, iteration);
      }
    } finally {
      this.pendingReReviews.delete(codingSessionId);
    }
  }

  private sendFeedbackToCodingSession(
    codingSessionId: string,
    result: PRReviewResult,
    iteration: number,
  ): void {
    const failingDimensions = result.dimensions.filter((d) => !d.passed);
    const dimensionLines = failingDimensions.length > 0
      ? failingDimensions.map((d) => `- **${d.name}**: ${d.notes}`).join('\n')
      : '(no specific dimension failures recorded)';

    const message =
      `## Review Feedback — Iteration ${iteration}\n\n` +
      `**Verdict:** ${result.verdict === 'needs_changes' ? 'Needs changes' : 'Incomplete'}\n\n` +
      `### Issues found:\n${dimensionLines}\n\n` +
      `**Overall:** ${result.summary}\n\n` +
      `Please address these issues and push your changes. ` +
      `The orchestrator will automatically re-review.`;

    this.sessionManager.send(codingSessionId, message);
  }
}
