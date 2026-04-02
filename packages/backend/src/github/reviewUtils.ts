import type { PRReviewResult } from './PRReviewService';

/**
 * Pure function — determines whether an auto-review should be triggered.
 * Returns false when the review iteration cap is reached or when no new
 * commits have landed since the last review.
 */
export function shouldAutoReview(
  pr: {
    reviewIteration: number;
    headSha: string | null;
    lastReviewedSha: string | null;
  },
  maxIterations: number,
): boolean {
  if (pr.reviewIteration >= maxIterations) return false;
  if (!pr.headSha || pr.headSha === pr.lastReviewedSha) return false;
  return true;
}

/**
 * Format failing review dimensions into a human-readable message
 * suitable for sending to the coding session as a fix prompt.
 */
export function formatReviewFeedback(prNumber: number, result: PRReviewResult): string {
  const failingDimensions = result.dimensions.filter((d) => !d.passed);
  const lines = failingDimensions.map((d) => `❌ ${d.name}: ${d.notes}`).join('\n');
  return `PR #${prNumber} review findings — please address the following:\n\n${lines}\n\nOverall: ${result.summary}`;
}
