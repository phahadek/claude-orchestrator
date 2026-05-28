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

export interface HumanComment {
  id: string;
  author: string;
  body: string;
  path?: string | null;
  line?: number | null;
}

/**
 * Format human reviewer comments into a message for the coding session.
 * Mirrors the structure of formatReviewFeedback() so the session doesn't
 * care whether feedback originated from AI or human review.
 */
export function formatHumanReviewFeedback(
  prNumber: number,
  comments: HumanComment[],
  hasChangesRequested: boolean,
): string {
  const header = hasChangesRequested
    ? `## Human Reviewer — Changes Requested on PR #${prNumber}`
    : `## Human Reviewer Comments — PR #${prNumber}`;

  const verdict = hasChangesRequested
    ? `**The reviewer has requested changes. Please address all feedback below and push your changes.**`
    : `**The reviewer has left comments. Please review and address them as appropriate, then push your changes.**`;

  const commentBlocks = comments.map((c) => {
    const location =
      c.path != null
        ? ` (\`${c.path}${c.line != null ? `:${c.line}` : ''}\`)`
        : '';
    return `### @${c.author}${location}\n${c.body.trim()}`;
  });

  return (
    `${header}\n\n` +
    `${verdict}\n\n` +
    commentBlocks.join('\n\n') +
    `\n\nThe orchestrator will automatically resume the merge process once you push.\n\n` +
    `**Important:** Do NOT rebase onto dev or merge dev into your branch. ` +
    `Just commit your fixes and push directly to your feature branch. ` +
    `Rebasing or merging would pull in unrelated changes from other merged PRs ` +
    `and pollute the PR diff.`
  );
}

export interface NoOpInvestigationArgs {
  taskTitle: string;
  taskMarkdown: string;
  noOpSessionEvents: Array<{
    event_type: string;
    payload: string;
    timestamp: number;
  }>;
  mergedPRs: Array<{
    number: number;
    title: string;
    url: string;
    mergedAt: string;
  }>;
  recentCommits: Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
  }>;
  sessionId: string;
  taskId: string;
}

/**
 * Render the investigator prompt for a no-op coding session.
 * The investigator is asked to emit exactly one JSON NoOpVerdict object.
 */
export function renderNoOpInvestigationPrompt(
  args: NoOpInvestigationArgs,
): string {
  const {
    taskTitle,
    taskMarkdown,
    noOpSessionEvents,
    mergedPRs,
    recentCommits,
    sessionId,
    taskId,
  } = args;

  const eventsBlock = noOpSessionEvents
    .slice(-50)
    .map((e) => {
      const ts = new Date(e.timestamp).toISOString();
      let payload = e.payload;
      try {
        const parsed = JSON.parse(e.payload) as Record<string, unknown>;
        // Extract readable text from assistant/tool events
        if (parsed.type === 'assistant') {
          const content = parsed.message as
            | { content?: Array<{ type: string; text?: string }> }
            | undefined;
          const texts =
            content?.content
              ?.filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('') ?? '';
          if (texts) payload = texts.slice(0, 500);
        } else if (
          parsed.type === 'tool_result' ||
          parsed.type === 'tool_use'
        ) {
          payload = JSON.stringify(parsed).slice(0, 300);
        }
      } catch {
        // not JSON, use raw
      }
      return `[${ts}] ${e.event_type}: ${payload.slice(0, 400)}`;
    })
    .join('\n');

  const mergedPRsBlock =
    mergedPRs.length > 0
      ? mergedPRs
          .map(
            (pr) =>
              `- PR #${pr.number}: ${pr.title} (${pr.url}) merged at ${pr.mergedAt}`,
          )
          .join('\n')
      : '(none)';

  const commitsBlock =
    recentCommits.length > 0
      ? recentCommits
          .map((c) => `- ${c.sha} ${c.message} by ${c.author} at ${c.date}`)
          .join('\n')
      : '(none)';

  return `You are an investigator reviewing a no-op coding session.

## Background
A coding session for the following task exited cleanly (exit code 0) without opening a pull request and without producing any git diff. Your job is to determine what happened and emit a verdict.

## Task
Title: ${taskTitle}
Task ID: ${taskId}
Session ID: ${sessionId}

### Task Spec
${taskMarkdown.slice(0, 4000)}

## No-Op Session Events (last 50)
${eventsBlock || '(no events)'}

## Recent Merged PRs on the base branch since this task was created
${mergedPRsBlock}

## Recent Commits on the base branch since this task was created
${commitsBlock}

## Your Job
Analyze the session events and recent activity to determine one of:
1. **resolved** — The task's work was already done by a sibling/duplicate PR that was merged. You must identify the specific PR URL.
2. **retry** — The session made a reasonable attempt but was confused or hit a transient issue. A one-shot retry is warranted.
3. **human** — The situation is genuinely ambiguous, the task is blocked on something outside the session's control, or a retry would just loop. A human needs to look at this.

## Output Format
Emit ONLY a single JSON object matching this TypeScript type and nothing else:

\`\`\`
type NoOpVerdict =
  | { kind: "resolved"; resolvedByPrUrl: string; reason: string }
  | { kind: "retry"; reason: string }
  | { kind: "human"; reason: string };
\`\`\`

Example for resolved:
{"kind":"resolved","resolvedByPrUrl":"https://github.com/owner/repo/pull/42","reason":"Task was already implemented in PR #42 which merged the required changes."}

Example for retry:
{"kind":"retry","reason":"The session could not find the CLAUDE.md file and exited without attempting the task."}

Example for human:
{"kind":"human","reason":"The session reported a fatal environment error that a retry cannot fix."}

Output ONLY the JSON object. No markdown, no explanation, no preamble.`;
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
