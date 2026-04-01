import { GITHUB_TOKEN, GITHUB_REPO } from '../config.js';
import { GitHubApiError, PullRequest, PRDiff, MergeResult } from './types.js';

export class GitHubClient {
  private readonly base = 'https://api.github.com';
  private readonly headers: HeadersInit;

  constructor() {
    this.headers = {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async listOpenPRs(): Promise<PullRequest[]> {
    const data = await this.request<GitHubRawPR[]>(
      `/repos/${GITHUB_REPO}/pulls?state=open&per_page=100`
    );
    return data
      .filter(pr => !pr.draft)
      .map(pr => mapPR(pr));
  }

  async fetchDiff(prId: number): Promise<PRDiff> {
    const diff = await this.request<string>(
      `/repos/${GITHUB_REPO}/pulls/${prId}`,
      { headers: { ...this.headers, 'Accept': 'application/vnd.github.diff' } }
    );
    const filesChanged = parseDiffFiles(diff);
    return { prId, diff, filesChanged };
  }

  async mergePR(prId: number, commitTitle: string): Promise<MergeResult> {
    const data = await this.request<{ merged: boolean; message: string; sha: string | null }>(
      `/repos/${GITHUB_REPO}/pulls/${prId}/merge`,
      {
        method: 'PUT',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ merge_method: 'squash', commit_title: commitTitle }),
      }
    );
    return { merged: data.merged, message: data.message, sha: data.sha };
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    const res = await fetch(url, { headers: this.headers, ...options });

    if (!res.ok) {
      const text = await res.text();
      // 405 = not mergeable, 409 = merge conflict — include descriptive messages
      throw new GitHubApiError(res.status, text);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return res.json() as Promise<T>;
    }
    return res.text() as unknown as Promise<T>;
  }
}

// ---- helpers ----------------------------------------------------------------

interface GitHubRawPR {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  url: string;
  head: { ref: string };
  base: { ref: string };
  state: string;
  created_at: string;
  updated_at: string;
  mergeable_state?: string | null;
  draft: boolean;
}

function mapPR(pr: GitHubRawPR): PullRequest {
  return {
    id: pr.number,
    title: pr.title,
    body: pr.body,
    url: pr.html_url,
    apiUrl: pr.url,
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    state: pr.state as PullRequest['state'],
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    mergeableState: pr.mergeable_state ?? null,
    draft: pr.draft,
  };
}

function parseDiffFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git a/')) {
      // format: "diff --git a/<path> b/<path>" — take the b/ path
      const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
      if (match) files.push(match[1]);
    }
  }
  return files;
}
