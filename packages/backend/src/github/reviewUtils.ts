import type { PRReviewResult } from './PRReviewService';

export interface GitHubCIFailureArgs {
  source?: 'github';
  prNumber: number;
  failingCheckNames: string[];
  /** URL to the failing GitHub Actions run or PR checks page. */
  runUrl: string | null;
  /** Truncated log excerpt from the failing step. */
  logExcerpt: string | null;
}

export interface VerifyCIFailureArgs {
  source: 'verify';
  failedCommand: string | undefined;
  truncatedOutput: string | undefined;
}

/** @deprecated Use GitHubCIFailureArgs directly */
export type CIFailureResult = GitHubCIFailureArgs;

const CI_LOG_EXCERPT_CAP = 800;

function truncateLog(log: string, cap: number): string {
  if (log.length <= cap) return log;
  const truncated = log.slice(0, cap);
  const remainingLines = log.slice(cap).split('\n').length - 1;
  return `${truncated}\n… [${remainingLines} more line${remainingLines !== 1 ? 's' : ''}]`;
}

const INSTRUCTION_BLOCK =
  `Please investigate the failures and push a fix. ` +
  `The orchestrator will automatically re-check once you push.\n\n` +
  `**Important:** Do NOT rebase onto dev or merge dev into your branch. ` +
  `Just commit your fixes and push directly to your feature branch. ` +
  `Rebasing or merging would pull in unrelated changes from other merged PRs ` +
  `and pollute the PR diff.`;

/**
 * Format CI failure data into a structured message suitable for sending
 * to the coding session as a fix prompt — mirrors formatReviewFeedback voice.
 *
 * Accepts either a GitHub check-run failure (source: 'github') or a local
 * verify-command failure (source: 'verify').
 */
export function formatCIFailureFeedback(
  args: GitHubCIFailureArgs | VerifyCIFailureArgs,
): string {
  if (args.source === 'verify') {
    const cmd = args.failedCommand ?? '(unknown)';
    const out = args.truncatedOutput ?? '';
    const outSection = out
      ? `### Command output:\n\`\`\`\n${out}\n\`\`\`\n\n`
      : '';
    return (
      `## CI Failure — verify gate\n\n` +
      `### Failed command:\n\`\`\`\n${cmd}\n\`\`\`\n\n` +
      outSection +
      INSTRUCTION_BLOCK
    );
  }

  const { prNumber, failingCheckNames, runUrl, logExcerpt } = args;

  const checkList =
    failingCheckNames.length > 0
      ? failingCheckNames.map((n) => `- ${n}`).join('\n')
      : '- (unknown)';

  const runSection = runUrl ? `**Run:** ${runUrl}\n\n` : '';

  const logSection = logExcerpt
    ? `### Failing step output:\n\`\`\`\n${truncateLog(logExcerpt, CI_LOG_EXCERPT_CAP)}\n\`\`\`\n\n`
    : '';

  return (
    `## CI Failure — PR #${prNumber}\n\n` +
    `### Failing checks:\n${checkList}\n\n` +
    runSection +
    logSection +
    INSTRUCTION_BLOCK
  );
}

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
      '[reviewUtils] shouldAutoReview: headSha is null after GitHub fetch — skipping re-review to avoid storing null SHA',
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
      ? failingDimensions.map((d) => `- **${d.name}**: ${d.notes}`).join('\n')
      : '(no specific dimension failures recorded)';
  return (
    `## Review Feedback — Iteration ${iteration}\n\n` +
    `**Verdict:** ${result.verdict === 'needs_changes' ? 'Needs changes' : 'Incomplete'}\n\n` +
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

/**
 * Format a merge conflict notification for a local branch coding session.
 * Asks the session to rebase onto the base branch and resolve conflicts.
 */
export function formatMergeConflictFeedback(args: {
  branchName: string;
  baseBranch: string;
}): string {
  const { branchName, baseBranch } = args;
  return (
    `## Merge Conflict — \`${branchName}\`\n\n` +
    `The auto-merger detected conflicts when attempting to squash-merge ` +
    `\`${branchName}\` into \`${baseBranch}\`.\n\n` +
    `### Action required:\n` +
    `1. Rebase your branch onto \`${baseBranch}\`: \`git rebase ${baseBranch}\`\n` +
    `2. Resolve any conflict markers in the affected files.\n` +
    `3. Complete the rebase: \`git rebase --continue\`\n\n` +
    `The orchestrator will automatically re-attempt the merge once conflicts are resolved.`
  );
}
