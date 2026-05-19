import type { PRReviewResult } from "./PRReviewService";

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
    // headSha is null — the caller must attempt to fetch it from GitHub before
    // calling this function. If it is still null (fetch failed), skip the review
    // so we don't store null as last_reviewed_sha and break future comparisons.
    console.warn(
      "[reviewUtils] shouldAutoReview: headSha is null after GitHub fetch — skipping re-review to avoid storing null SHA",
    );
    return false;
  }
  // null lastReviewedSha means the PR was never reviewed — allow re-review.
  if (pr.lastReviewedSha !== null && pr.headSha === pr.lastReviewedSha)
    return false;
  return true;
}

/**
 * Format failing review dimensions into a human-readable message
 * suitable for sending to the coding session as a fix prompt.
 */
export function formatReviewFeedback(
  result: PRReviewResult,
  iteration: number,
): string {
  const failingDimensions = (result.dimensions ?? []).filter((d) => !d.passed);
  const dimensionLines =
    failingDimensions.length > 0
      ? failingDimensions.map((d) => `- **${d.name}**: ${d.notes}`).join("\n")
      : "(no specific dimension failures recorded)";
  return (
    `## Review Feedback — Iteration ${iteration}\n\n` +
    `**Verdict:** ${result.verdict === "needs_changes" ? "Needs changes" : "Incomplete"}\n\n` +
    `### Issues found:\n${dimensionLines}\n\n` +
    `**Overall:** ${result.summary}\n\n` +
    `Please address these issues and push your changes. ` +
    `The orchestrator will automatically re-review.\n\n` +
    `**Important:** Do NOT rebase onto dev or merge dev into your branch. ` +
    `Just commit your fixes and push directly to your feature branch. ` +
    `Rebasing or merging would pull in unrelated changes from other merged PRs ` +
    `and pollute the PR diff.`
  );
}
