export class GitHubApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface PullRequest {
  id: number;           // GitHub PR number
  title: string;
  body: string | null;  // PR description
  url: string;          // html_url
  apiUrl: string;       // url (REST API base)
  headBranch: string;   // head.ref
  baseBranch: string;   // base.ref
  state: 'open' | 'closed' | 'merged';
  createdAt: string;    // ISO-8601
  updatedAt: string;
  mergeableState: string | null;  // from GET /pulls/:id — 'clean' | 'dirty' | 'blocked' | 'unknown' | null
  draft: boolean;
}

export interface PRDiff {
  prId: number;
  diff: string;          // raw unified diff text
  filesChanged: string[]; // list of file paths from the diff
}

export interface MergeResult {
  merged: boolean;
  message: string;
  sha: string | null;
}
