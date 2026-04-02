import { GITHUB_TOKEN, GITHUB_REPO } from '../config';
import { GitHubApiError, PullRequest, PRDiff, MergeResult } from './types';
import { getPRByNumber } from '../db/queries';

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

  async listOpenPRs(repo?: string): Promise<PullRequest[]> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<GitHubRawPR[]>(
      `/repos/${r}/pulls?state=open&per_page=100`
    );
    return data.map(pr => mapPR(pr));
  }

  async getPRState(prNumber: number, repo?: string): Promise<'open' | 'merged' | 'closed'> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<{ state: string; merged: boolean }>(
      `/repos/${r}/pulls/${prNumber}`,
    );
    if (data.merged) return 'merged';
    if (data.state === 'closed') return 'closed';
    return 'open';
  }

  async fetchPR(repo: string, prNumber: number): Promise<PullRequest> {
    const data = await this.request<GitHubRawPR>(`/repos/${repo}/pulls/${prNumber}`);
    return mapPR(data);
  }

  async getMergeability(prNumber: number, repo?: string): Promise<{ mergeable: boolean | null; mergeableState: string | null }> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<GitHubRawPR>(`/repos/${r}/pulls/${prNumber}`);
    return {
      mergeable: data.mergeable ?? null,
      mergeableState: data.mergeable_state ?? null,
    };
  }

  async fetchDiff(prId: number, repo?: string): Promise<PRDiff> {
    const r = repo ?? GITHUB_REPO;
    const diff = await this.request<string>(
      `/repos/${r}/pulls/${prId}`,
      { headers: { ...this.headers, 'Accept': 'application/vnd.github.diff' } }
    );
    const filesChanged = parseDiffFiles(diff);
    return { prId, diff, filesChanged };
  }

  async markPRReady(repo: string, prNumber: number): Promise<void> {
    const prRow = getPRByNumber(prNumber, repo);
    if (!prRow?.node_id) {
      const pr = await this.fetchPR(repo, prNumber);
      await this.markPRReadyByNodeId(pr.nodeId);
      return;
    }
    await this.markPRReadyByNodeId(prRow.node_id);
  }

  private async markPRReadyByNodeId(nodeId: string): Promise<void> {
    const query = `mutation($pullRequestId: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
        pullRequest { isDraft }
      }
    }`;
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables: { pullRequestId: nodeId } }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new GitHubApiError(res.status, text);
    }
    const body = await res.json() as { errors?: Array<{ message: string }> };
    if (body.errors?.length) {
      throw new GitHubApiError(422, body.errors.map(e => e.message).join('; '));
    }
  }

  async mergePR(prId: number, commitTitle: string, repo?: string): Promise<MergeResult> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<{ merged: boolean; message: string; sha: string | null }>(
      `/repos/${r}/pulls/${prId}/merge`,
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
  node_id: string;
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
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  draft: boolean;
}

function mapPR(pr: GitHubRawPR): PullRequest {
  return {
    nodeId: pr.node_id,
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
