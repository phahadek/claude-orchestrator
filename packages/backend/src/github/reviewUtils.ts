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
  if (!pr.headSha) {
    // headSha is null even after the caller attempted to fetch it from GitHub.
    // Allow the review to proceed — push_detected was emitted so a new commit
    // definitely landed; blocking here would silently drop the re-review.
    console.warn('[reviewUtils] shouldAutoReview: headSha is null after fetch — allowing re-review anyway');
    return true;
  }
  if (pr.headSha === pr.lastReviewedSha) return false;
  return true;
}

/**
 * Format failing review dimensions into a human-readable message
 * suitable for sending to the coding session as a fix prompt.
 */
export function formatReviewFeedback(result: PRReviewResult, iteration: number): string {
  const failingDimensions = (result.dimensions ?? []).filter((d) => !d.passed);
  const dimensionLines = failingDimensions.length > 0
    ? failingDimensions.map((d) => `- **${d.name}**: ${d.notes}`).join('\n')
    : '(no specific dimension failures recorded)';
  return (
    `## Review Feedback — Iteration ${iteration}\n\n` +
    `**Verdict:** ${result.verdict === 'needs_changes' ? 'Needs changes' : 'Incomplete'}\n\n` +
    `### Issues found:\n${dimensionLines}\n\n` +
    `**Overall:** ${result.summary}\n\n` +
    `Please address these issues and push your changes. ` +
    `The orchestrator will automatically re-review.`
  );
}
