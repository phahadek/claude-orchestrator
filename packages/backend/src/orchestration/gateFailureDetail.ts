/**
 * Extracts the gate-failure fields PreReviewPipeline.handleGateFailure
 * persists into pull_requests.review_result on a verify/autofix/analyze
 * gate failure — never the prose `summary` field, which for a verify
 * failure reads `verify failed: <command>` and would render as a doubled,
 * nonsensical "Failed command" line if echoed back into the failedCommand
 * slot (see PreReviewPipeline.buildVerifyStage, which writes both fields
 * alongside summary for exactly this reason).
 *
 * failedHeadSha is the worktree HEAD handleGateFailure read at the moment
 * the gate failed — used by PreReviewPipeline's no-diff-autofix guard to
 * tell a true retry of that exact tree apart from a push that landed in
 * between (see PreReviewPipeline.run).
 */
export function parseGateFailureDetail(reviewResult: string | null): {
  failedCommand: string | undefined;
  truncatedOutput: string | undefined;
  failedHeadSha: string | undefined;
} {
  if (!reviewResult)
    return {
      failedCommand: undefined,
      truncatedOutput: undefined,
      failedHeadSha: undefined,
    };
  try {
    const parsed = JSON.parse(reviewResult) as {
      failedCommand?: string;
      truncatedOutput?: string;
      failedHeadSha?: string;
    };
    return {
      failedCommand: parsed.failedCommand,
      truncatedOutput: parsed.truncatedOutput,
      failedHeadSha: parsed.failedHeadSha,
    };
  } catch {
    return {
      failedCommand: undefined,
      truncatedOutput: undefined,
      failedHeadSha: undefined,
    };
  }
}
