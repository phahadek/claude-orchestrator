export class GitHubApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PullRequest {
  nodeId: string; // GitHub GraphQL global ID
  id: number; // GitHub PR number
  title: string;
  body: string | null; // PR description
  url: string; // html_url
  apiUrl: string; // url (REST API base)
  headBranch: string; // head.ref
  headSha: string | null; // head.sha — current tip commit of the PR branch
  baseBranch: string; // base.ref
  state: 'open' | 'closed' | 'merged';
  createdAt: string; // ISO-8601
  updatedAt: string;
  mergeableState: string | null; // from GET /pulls/:id — 'clean' | 'dirty' | 'blocked' | 'unknown' | null
  draft: boolean;
}

export interface PRDiff {
  prId: number;
  diff: string; // raw unified diff text
  filesChanged: string[]; // list of file paths from the diff
}

export interface MergeResult {
  merged: boolean;
  message: string;
  sha: string | null;
}

export interface FailingCheck {
  name: string;
  conclusion: string;
}

/**
 * Why a PR is currently not mergeable. Derived from GitHub's `mergeable_state`
 * combined with check-run conclusions for blocked/unstable PRs.
 *
 * - `clean`     — PR is mergeable.
 * - `conflict`  — merge conflicts (mergeable_state 'dirty' or 'behind'); needs rebase.
 * - `ci_failed` — required CI checks are failing (mergeable_state 'unstable', or
 *                 'blocked' with failing check-runs).
 * - `blocked`   — blocked by branch protection (missing required reviews, etc.)
 *                 with no failing checks.
 * - `unknown`   — GitHub is still computing, or returned a state we don't recognize.
 */
export type MergeCategory =
  | 'clean'
  | 'conflict'
  | 'ci_failed'
  | 'blocked'
  | 'unknown';

export interface MergeabilityCategory {
  category: MergeCategory;
  /** Value persisted in pull_requests.merge_state ('clean' | 'dirty' | 'ci_failed' | 'blocked' | 'unknown'). */
  mergeState: string;
  /** Raw mergeable_state from GitHub (null when GitHub is still computing). */
  rawMergeableState: string | null;
  /** Names + conclusions of failing check-runs. Empty unless category is 'ci_failed'. */
  failingChecks: FailingCheck[];
  /** Current head commit SHA from GitHub. null when not available. */
  headSha: string | null;
}

export interface Issue {
  id: number;           // GitHub issue number
  nodeId: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];     // label names
  milestone: number | null; // milestone number, null if unset
  createdAt: string;
  updatedAt: string;
  url: string;          // html_url
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;          // html_url
}

export interface Milestone {
  id: number;           // milestone number
  nodeId: string;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  openIssues: number;
  closedIssues: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewJob {
  prNumber: number;
  repo: string;
  taskId: string;
  taskUrl: string;
  contextUrl: string;
  /** True when the triggering push was the autofix commit (not a coding-session push). */
  autofixOnly?: boolean;
  /** Populated for local-only mode; absent for GitHub mode. */
  sessionId?: string;
  worktreePath?: string;
  projectId?: string;
}
