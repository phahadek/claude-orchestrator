import { config } from '../config';
import { setPRReviewResult, getSetting, getPRByNumber, getPRBySessionId, incrementReviewIteration, setLastReviewedSha, updatePRDraftStatus } from '../db/queries';
import type { PRReviewService, PRReviewResult } from './PRReviewService';
import type { SessionManager } from '../session/SessionManager';
import type { ReviewJob } from './types';
import { shouldAutoReview } from './reviewUtils';
import type { GitHubClient } from './GitHubClient';

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
  /** Coding session IDs currently undergoing a re-review, to prevent duplicate triggers. */
  private pendingReReviews = new Set<string>();

  constructor(
    private reviewService: PRReviewService,
    private sessionManager: SessionManager,
    private githubClient: GitHubClient,
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

    // Transition draft PR to ready for review if verdict is approved
    let draftTransitioned = false;
    if (result.verdict === 'approved') {
      const pr = getPRByNumber(job.prNumber, job.repo);
      if (pr?.draft === 1) {
        try {
          await this.githubClient.markPRReady(job.repo, job.prNumber);
          updatePRDraftStatus(job.prNumber, job.repo, 0);
          draftTransitioned = true;
        } catch (e) {
          console.error(`[ReviewOrchestrator] markPRReady failed for PR #${job.prNumber}:`, e);
        }
      }
    }

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
        this.sendFeedbackToCodingSession(prRow.session_id, result, 0);
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

  private async onPushDetected(codingSessionId: string): Promise<void> {
    if (!this.enabled) return;
    if (this.pendingReReviews.has(codingSessionId)) return;

    const prRow = getPRBySessionId(codingSessionId);
    if (!prRow || prRow.state !== 'open') return;
    if (!prRow.review_session_id) return;

    const maxIter = getMaxReviewIterations();
    if (!shouldAutoReview(
      { reviewIteration: prRow.review_iteration, headSha: prRow.head_sha, lastReviewedSha: prRow.last_reviewed_sha },
      maxIter,
    )) return;

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
        setPRReviewResult(prRow.pr_number, prRow.repo, JSON.stringify({ verdict: 'error', summary, dimensions: [] }));
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

      // Mark this SHA as reviewed so duplicate pushes don't re-trigger the same review
      setLastReviewedSha(prRow.pr_number, prRow.repo, prRow.head_sha);

      this.sessionManager.emit('message', {
        type: 'review_verdict',
        prNumber: prRow.pr_number,
        repo: prRow.repo,
        verdict: result.verdict,
        summary: result.summary,
        iteration,
      });

      if (result.verdict === 'needs_changes') {
        this.sendFeedbackToCodingSession(codingSessionId, result, iteration);
      } else if (result.verdict === 'incomplete') {
        const message = `Review for PR #${prRow.pr_number} returned an incomplete verdict — the reviewer could not assess the PR. Manual intervention needed.`;
        console.warn(`[ReviewOrchestrator] ${message}`);
        this.sessionManager.emit('message', {
          type: 'review_incomplete',
          prNumber: prRow.pr_number,
          repo: prRow.repo,
          message,
        });
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
    const failingDimensions = (result.dimensions ?? []).filter((d) => !d.passed);
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
