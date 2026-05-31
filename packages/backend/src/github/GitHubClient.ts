import { GITHUB_TOKEN, GITHUB_REPO } from '../config';
import {
  GitHubApiError,
  PullRequest,
  PRDiff,
  MergeResult,
  FailingCheck,
  MergeabilityCategory,
  Issue,
  IssueComment,
  Milestone,
} from './types';
import { getPRByNumber } from '../db/queries';

/** GitHub check-run conclusions that indicate the check did not pass. */
const FAILING_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'action_required',
  'cancelled',
  'stale',
  'startup_failure',
]);

export class GitHubClient {
  private readonly base = 'https://api.github.com';
  private readonly headers: HeadersInit;

  constructor() {
    this.headers = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async listOpenPRs(repo?: string): Promise<PullRequest[]> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<GitHubRawPR[]>(
      `/repos/${r}/pulls?state=open&per_page=100`,
    );
    return data.map((pr) => mapPR(pr));
  }

  async getPRState(
    prNumber: number,
    repo?: string,
  ): Promise<{ state: 'open' | 'merged' | 'closed'; headSha: string | null }> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<{
      state: string;
      merged?: boolean;
      head?: { sha: string };
    }>(`/repos/${r}/pulls/${prNumber}`);
    const state: 'open' | 'merged' | 'closed' = data.merged
      ? 'merged'
      : data.state === 'closed'
        ? 'closed'
        : 'open';
    return { state, headSha: data.head?.sha ?? null };
  }

  async fetchPR(repo: string, prNumber: number): Promise<PullRequest> {
    const data = await this.request<GitHubRawPR>(
      `/repos/${repo}/pulls/${prNumber}`,
    );
    return mapPR(data);
  }

  async getMergeability(
    prNumber: number,
    repo?: string,
  ): Promise<{ mergeable: boolean | null; mergeableState: string | null }> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<GitHubRawPR>(
      `/repos/${r}/pulls/${prNumber}`,
    );
    return {
      mergeable: data.mergeable ?? null,
      mergeableState: data.mergeable_state ?? null,
    };
  }

  // Retry getMergeability with exponential backoff (2s, 4s, 8s, 16s, 32s) when
  // GitHub returns mergeable: null. After all 5 retries, returns the last (still-null) result.
  async getMergeabilityWithRetry(
    prNumber: number,
    repo?: string,
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ): Promise<{ mergeable: boolean | null; mergeableState: string | null }> {
    const delays = [2000, 4000, 8000, 16000, 32000];
    let result = await this.getMergeability(prNumber, repo);
    for (const delay of delays) {
      if (result.mergeable !== null) return result;
      await sleep(delay);
      result = await this.getMergeability(prNumber, repo);
    }
    if (result.mergeable === null) {
      console.warn(
        `[GitHubClient] getMergeability still null after retries for PR #${prNumber} in ${repo ?? GITHUB_REPO} — skipping`,
      );
    }
    return result;
  }

  async fetchDiff(
    prId: number,
    repo?: string,
    branches?: { base: string; head: string },
  ): Promise<PRDiff> {
    const r = repo ?? GITHUB_REPO;
    let diff: string;
    if (branches) {
      // Explicit three-dot compare endpoint — guarantees merge-base semantics
      diff = await this.request<string>(
        `/repos/${r}/compare/${branches.base}...${branches.head}`,
        { headers: { ...this.headers, Accept: 'application/vnd.github.diff' } },
      );
    } else {
      diff = await this.request<string>(`/repos/${r}/pulls/${prId}`, {
        headers: { ...this.headers, Accept: 'application/vnd.github.diff' },
      });
    }
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

  /**
   * Fetch the GitHub-computed review decision for a PR via GraphQL.
   * Returns 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', or null when
   * the repository has no review requirements configured.
   */
  async getReviewState(
    prNumber: number,
    repo?: string,
  ): Promise<PRReviewDecision | null> {
    const r = repo ?? GITHUB_REPO;
    const [owner, name] = r.split('/');
    const query = `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewDecision
        }
      }
    }`;
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { owner, name, number: prNumber },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new GitHubApiError(res.status, text);
    }
    const body = (await res.json()) as {
      errors?: Array<{ message: string }>;
      data?: {
        repository?: { pullRequest?: { reviewDecision: string | null } };
      };
    };
    if (body.errors?.length) {
      throw new GitHubApiError(
        422,
        body.errors.map((e) => e.message).join('; '),
      );
    }
    const decision = body.data?.repository?.pullRequest?.reviewDecision;
    if (!decision) return null;
    return decision as PRReviewDecision;
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
    const body = (await res.json()) as { errors?: Array<{ message: string }> };
    if (body.errors?.length) {
      throw new GitHubApiError(
        422,
        body.errors.map((e) => e.message).join('; '),
      );
    }
  }

  /**
   * Fetch failing check-runs for a given commit SHA. Used to distinguish
   * "blocked by failing CI" from "blocked by branch protection" when a merge
   * attempt fails with 409/405 or when mergeable_state is `unstable`/`blocked`.
   */
  async getFailingChecks(sha: string, repo?: string): Promise<FailingCheck[]> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<{
      check_runs: Array<{
        name: string;
        status: string;
        conclusion: string | null;
      }>;
    }>(`/repos/${r}/commits/${sha}/check-runs?per_page=100`);
    return data.check_runs
      .filter(
        (c) =>
          c.status === 'completed' &&
          c.conclusion !== null &&
          FAILING_CHECK_CONCLUSIONS.has(c.conclusion),
      )
      .map((c) => ({ name: c.name, conclusion: c.conclusion as string }));
  }

  /**
   * Map GitHub's mergeable_state (plus check-runs when relevant) onto a single
   * category so the dashboard can tell merge conflicts apart from CI failures
   * and branch-protection blocks. Returns `clean` when mergeable, otherwise one
   * of `conflict` / `ci_failed` / `blocked` / `unknown`.
   *
   * Called after a 409/405 merge failure to pick the right remediation, and by
   * PRMergeWatcher polling so the state is reflected before the user clicks Merge.
   *
   * @param ciCheckNames When non-empty, only checks in this list are considered
   *   when categorizing CI failures. Checks not in the list are ignored. A named
   *   check absent from the PR's check-runs is treated as pending (unknown).
   *   When empty (default), all checks count — existing behaviour.
   */
  async categorizeMergeability(
    prNumber: number,
    repo?: string,
    ciCheckNames: string[] = [],
  ): Promise<MergeabilityCategory> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<GitHubRawPR>(
      `/repos/${r}/pulls/${prNumber}`,
    );
    return this.categorizeFromRawPR(data, r, ciCheckNames);
  }

  /**
   * Conditional PR status fetch with ETag/If-None-Match support. Returns the
   * categorized mergeability when GitHub returns 200 (with the new ETag), or
   * `{ status: 'not_modified' }` when GitHub returns 304 (no body, ETag stays
   * the same). Used by AutoMerger to avoid burning GitHub quota while polling
   * a slow-to-change PR.
   */
  async fetchPRStatusConditional(
    prNumber: number,
    repo: string,
    etag?: string | null,
    ciCheckNames: string[] = [],
  ): Promise<
    | { status: 'not_modified'; etag: string | null }
    | {
        status: 'ok';
        etag: string | null;
        state: 'open' | 'closed' | 'merged';
        mergeability: MergeabilityCategory;
        headSha: string | null;
      }
  > {
    const url = `${this.base}/repos/${repo}/pulls/${prNumber}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch(url, { headers });
    if (res.status === 304) {
      return { status: 'not_modified', etag: etag ?? null };
    }
    if (!res.ok) {
      const text = await res.text();
      throw new GitHubApiError(res.status, text);
    }
    const newEtag = res.headers.get('etag');
    const data = (await res.json()) as GitHubRawPR & {
      state: string;
      merged?: boolean;
    };
    const state: 'open' | 'closed' | 'merged' = data.merged
      ? 'merged'
      : data.state === 'closed'
        ? 'closed'
        : 'open';
    const mergeability = await this.categorizeFromRawPR(
      data,
      repo,
      ciCheckNames,
    );
    return {
      status: 'ok',
      etag: newEtag,
      state,
      mergeability,
      headSha: data.head?.sha ?? null,
    };
  }

  private async categorizeFromRawPR(
    data: GitHubRawPR,
    r: string,
    ciCheckNames: string[] = [],
  ): Promise<MergeabilityCategory> {
    const rawMergeableState = data.mergeable_state ?? null;
    const headSha = data.head?.sha ?? null;

    if (rawMergeableState === 'dirty' || rawMergeableState === 'behind') {
      return {
        category: 'conflict',
        mergeState: 'dirty',
        rawMergeableState,
        failingChecks: [],
        headSha,
      };
    }
    if (rawMergeableState === 'unstable') {
      const checksResult = headSha
        ? await this.getChecksForCategorization(headSha, r, ciCheckNames)
        : { failingChecks: [] as FailingCheck[], hasMissingNamedCheck: false };
      const { failingChecks } = checksResult;
      if (failingChecks.length > 0) {
        return {
          category: 'ci_failed',
          mergeState: 'ci_failed',
          rawMergeableState,
          failingChecks,
          headSha,
        };
      }
      return {
        category: 'unknown',
        mergeState: 'unstable',
        rawMergeableState,
        failingChecks: [],
        headSha,
      };
    }
    if (rawMergeableState === 'blocked') {
      const { failingChecks, hasMissingNamedCheck } = headSha
        ? await this.getChecksForCategorization(headSha, r, ciCheckNames)
        : { failingChecks: [], hasMissingNamedCheck: false };
      if (failingChecks.length > 0) {
        return {
          category: 'ci_failed',
          mergeState: 'ci_failed',
          rawMergeableState,
          failingChecks,
          headSha,
        };
      }
      // A named check that hasn't reported yet is treated as pending, not passing.
      if (hasMissingNamedCheck) {
        return {
          category: 'unknown',
          mergeState: 'blocked',
          rawMergeableState,
          failingChecks: [],
          headSha,
        };
      }
      return {
        category: 'blocked',
        mergeState: 'blocked',
        rawMergeableState,
        failingChecks: [],
        headSha,
      };
    }
    if (rawMergeableState === 'clean') {
      return {
        category: 'clean',
        mergeState: 'clean',
        rawMergeableState,
        failingChecks: [],
        headSha,
      };
    }
    return {
      category: 'unknown',
      mergeState: rawMergeableState ?? 'unknown',
      rawMergeableState,
      failingChecks: [],
      headSha,
    };
  }

  /**
   * Fetch check-runs for a commit and return failing checks, optionally filtered
   * to `ciCheckNames`. When `ciCheckNames` is non-empty, also reports whether any
   * named check has not yet appeared in the check-run list (pending/unreported).
   */
  private async getChecksForCategorization(
    sha: string,
    repo: string,
    ciCheckNames: string[],
  ): Promise<{ failingChecks: FailingCheck[]; hasMissingNamedCheck: boolean }> {
    let allCheckRuns: Array<{
      name: string;
      status: string;
      conclusion: string | null;
    }>;
    try {
      const data = await this.request<{
        check_runs: Array<{
          name: string;
          status: string;
          conclusion: string | null;
        }>;
      }>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
      allCheckRuns = data.check_runs;
    } catch (err) {
      console.warn(
        `[GitHubClient] getFailingChecks failed for ${sha} in ${repo}:`,
        (err as Error).message,
      );
      return { failingChecks: [], hasMissingNamedCheck: false };
    }

    const allFailingChecks = allCheckRuns
      .filter(
        (c) =>
          c.status === 'completed' &&
          c.conclusion !== null &&
          FAILING_CHECK_CONCLUSIONS.has(c.conclusion),
      )
      .map((c) => ({ name: c.name, conclusion: c.conclusion as string }));

    if (ciCheckNames.length === 0) {
      return { failingChecks: allFailingChecks, hasMissingNamedCheck: false };
    }

    const reportedNames = new Set(allCheckRuns.map((c) => c.name));
    const failingChecks = allFailingChecks.filter((c) =>
      ciCheckNames.includes(c.name),
    );
    const hasMissingNamedCheck = ciCheckNames.some(
      (name) => !reportedNames.has(name),
    );
    return { failingChecks, hasMissingNamedCheck };
  }

  /** Fetch the full list of changed files for a pull request (paginated). */
  async getPRFiles(repo: string, prNumber: number): Promise<string[]> {
    const files: string[] = [];
    let page = 1;
    while (true) {
      const data = await this.request<Array<{ filename: string }>>(
        `/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      );
      for (const f of data) files.push(f.filename);
      if (data.length < 100) break;
      page++;
    }
    return files;
  }

  /** Fetch the list of commits for a pull request. */
  async getCommitsForPR(
    repo: string,
    prNumber: number,
  ): Promise<Array<{ sha: string; message: string; author?: string | null }>> {
    const data = await this.request<
      Array<{
        sha: string;
        commit: { message: string; author?: { email?: string } };
      }>
    >(`/repos/${repo}/pulls/${prNumber}/commits?per_page=100`);
    return data.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author?.email ?? null,
    }));
  }

  /**
   * Ensure a label exists on the repo, creating it if absent.
   * Silently ignores 422 (already exists) from a race condition.
   */
  async ensureLabelExists(
    repo: string,
    name: string,
    color: string,
    description: string,
  ): Promise<void> {
    try {
      await this.request(`/repos/${repo}/labels`, {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color, description }),
      });
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 422) return;
      throw err;
    }
  }

  /** Apply a label to a pull request (issues endpoint works for PRs too). */
  async addLabelToPR(
    repo: string,
    prNumber: number,
    label: string,
  ): Promise<void> {
    await this.request(`/repos/${repo}/issues/${prNumber}/labels`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: [label] }),
    });
  }

  /** Post a comment on a pull request. */
  async createIssueComment(
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<void> {
    await this.request(`/repos/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  async listPRReviews(
    prNumber: number,
    repo?: string,
  ): Promise<PRReviewSummary[]> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<
      Array<{
        id: number;
        state: string;
        user: { login: string };
        body: string | null;
        submitted_at: string;
      }>
    >(`/repos/${r}/pulls/${prNumber}/reviews?per_page=100`);
    return data.map((review) => ({
      id: review.id,
      state: review.state as PRReviewSummary['state'],
      author: review.user.login,
      body: review.body,
      submittedAt: review.submitted_at,
    }));
  }

  async listPRReviewComments(
    prNumber: number,
    repo?: string,
  ): Promise<PRCommentSummary[]> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<
      Array<{
        id: number;
        user: { login: string };
        body: string;
        created_at: string;
        path: string;
        line: number | null;
        original_line: number | null;
      }>
    >(`/repos/${r}/pulls/${prNumber}/comments?per_page=100`);
    return data.map((c) => ({
      id: c.id,
      author: c.user.login,
      body: c.body,
      createdAt: c.created_at,
      path: c.path,
      line: c.line ?? c.original_line ?? null,
    }));
  }

  async listPRIssueComments(
    prNumber: number,
    repo?: string,
  ): Promise<PRCommentSummary[]> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<
      Array<{
        id: number;
        user: { login: string };
        body: string;
        created_at: string;
      }>
    >(`/repos/${r}/issues/${prNumber}/comments?per_page=100`);
    return data.map((c) => ({
      id: c.id,
      author: c.user.login,
      body: c.body,
      createdAt: c.created_at,
    }));
  }

  async deleteBranch(repo: string, branchName: string): Promise<void> {
    await this.request(`/repos/${repo}/git/refs/heads/${branchName}`, {
      method: 'DELETE',
    });
  }

  async listMergedPRsSince(
    repo: string,
    baseBranch: string,
    since: string,
  ): Promise<
    Array<{ number: number; title: string; url: string; mergedAt: string }>
  > {
    const data = await this.request<GitHubRawPR[]>(
      `/repos/${repo}/pulls?state=closed&base=${encodeURIComponent(baseBranch)}&sort=updated&direction=desc&per_page=50`,
    );
    return data
      .filter((pr) => {
        const raw = pr as GitHubRawPR & { merged_at?: string | null };
        return raw.merged_at && raw.merged_at >= since;
      })
      .map((pr) => {
        const raw = pr as GitHubRawPR & { merged_at: string };
        return {
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          mergedAt: raw.merged_at,
        };
      });
  }

  async listCommitsSince(
    repo: string,
    branch: string,
    since: string,
  ): Promise<
    Array<{ sha: string; message: string; author: string; date: string }>
  > {
    const data = await this.request<
      Array<{
        sha: string;
        commit: { message: string; author: { name: string; date: string } };
      }>
    >(
      `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(since)}&per_page=30`,
    );
    return data.map((c) => ({
      sha: c.sha.slice(0, 8),
      message: c.commit.message.split('\n')[0],
      author: c.commit.author.name,
      date: c.commit.author.date,
    }));
  }

  async mergePR(
    prId: number,
    commitTitle: string,
    repo?: string,
  ): Promise<MergeResult> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<{
      merged: boolean;
      message: string;
      sha: string | null;
    }>(`/repos/${r}/pulls/${prId}/merge`, {
      method: 'PUT',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merge_method: 'squash',
        commit_title: commitTitle,
      }),
    });
    return { merged: data.merged, message: data.message, sha: data.sha };
  }

  // ---- Issues -----------------------------------------------------------------

  async listIssues(
    repo: string,
    opts: {
      labels?: string[];
      milestone?: number | '*' | 'none';
      state?: 'open' | 'closed' | 'all';
      since?: string;
    } = {},
  ): Promise<Issue[]> {
    const params = new URLSearchParams();
    params.set('per_page', '100');
    if (opts.labels?.length) params.set('labels', opts.labels.join(','));
    if (opts.milestone !== undefined) params.set('milestone', String(opts.milestone));
    if (opts.state) params.set('state', opts.state);
    if (opts.since) params.set('since', opts.since);
    const data = await this.request<GitHubRawIssue[]>(
      `/repos/${repo}/issues?${params.toString()}`,
    );
    return data.map(mapIssue);
  }

  async getIssue(repo: string, number: number): Promise<Issue> {
    const data = await this.request<GitHubRawIssue>(
      `/repos/${repo}/issues/${number}`,
    );
    return mapIssue(data);
  }

  async createIssue(
    repo: string,
    input: { title: string; body?: string; labels?: string[]; milestone?: number },
  ): Promise<Issue> {
    const data = await this.request<GitHubRawIssue>(`/repos/${repo}/issues`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return mapIssue(data);
  }

  async updateIssue(
    repo: string,
    number: number,
    patch: {
      title?: string;
      body?: string;
      labels?: string[];
      milestone?: number | null;
      state?: 'open' | 'closed';
    },
  ): Promise<Issue> {
    const data = await this.request<GitHubRawIssue>(
      `/repos/${repo}/issues/${number}`,
      {
        method: 'PATCH',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    );
    return mapIssue(data);
  }

  async addIssueComment(
    repo: string,
    number: number,
    body: string,
  ): Promise<IssueComment> {
    const data = await this.request<GitHubRawIssueComment>(
      `/repos/${repo}/issues/${number}/comments`,
      {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    );
    return mapIssueComment(data);
  }

  async listIssueComments(repo: string, number: number): Promise<IssueComment[]> {
    const data = await this.request<GitHubRawIssueComment[]>(
      `/repos/${repo}/issues/${number}/comments?per_page=100`,
    );
    return data.map(mapIssueComment);
  }

  // ---- Milestones -------------------------------------------------------------

  async listMilestones(
    repo: string,
    opts: { state?: 'open' | 'closed' | 'all' } = {},
  ): Promise<Milestone[]> {
    const params = new URLSearchParams({ per_page: '100' });
    if (opts.state) params.set('state', opts.state);
    const data = await this.request<GitHubRawMilestone[]>(
      `/repos/${repo}/milestones?${params.toString()}`,
    );
    return data.map(mapMilestone);
  }

  async createMilestone(
    repo: string,
    input: { title: string; description?: string },
  ): Promise<Milestone> {
    const data = await this.request<GitHubRawMilestone>(
      `/repos/${repo}/milestones`,
      {
        method: 'POST',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    return mapMilestone(data);
  }

  async updateMilestone(
    repo: string,
    number: number,
    patch: { title?: string; description?: string; state?: 'open' | 'closed' },
  ): Promise<Milestone> {
    const data = await this.request<GitHubRawMilestone>(
      `/repos/${repo}/milestones/${number}`,
      {
        method: 'PATCH',
        headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    );
    return mapMilestone(data);
  }

  // ---- Conditional issue fetch ------------------------------------------------

  async fetchIssuesConditional(
    repo: string,
    etag: string | null,
    opts: { labels?: string[]; since?: string } = {},
  ): Promise<
    | { status: 'not_modified'; etag: string | null }
    | { status: 'ok'; etag: string | null; issues: Issue[] }
  > {
    const params = new URLSearchParams({ per_page: '100' });
    if (opts.labels?.length) params.set('labels', opts.labels.join(','));
    if (opts.since) params.set('since', opts.since);
    const url = `${this.base}/repos/${repo}/issues?${params.toString()}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch(url, { headers });
    if (res.status === 304) {
      return { status: 'not_modified', etag: etag ?? null };
    }
    if (!res.ok) {
      const text = await res.text();
      throw new GitHubApiError(res.status, text);
    }
    const newEtag = res.headers.get('etag');
    const data = (await res.json()) as GitHubRawIssue[];
    return { status: 'ok', etag: newEtag, issues: data.map(mapIssue) };
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
  head: { ref: string; sha: string };
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
    headSha: pr.head.sha,
    baseBranch: pr.base.ref,
    state: pr.state as PullRequest['state'],
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    mergeableState: pr.mergeable_state ?? null,
    draft: pr.draft,
  };
}

interface GitHubRawIssue {
  number: number;
  node_id: string;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  milestone: { number: number } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface GitHubRawIssueComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface GitHubRawMilestone {
  number: number;
  node_id: string;
  title: string;
  description: string | null;
  state: string;
  open_issues: number;
  closed_issues: number;
  created_at: string;
  updated_at: string;
}

function mapIssue(raw: GitHubRawIssue): Issue {
  return {
    id: raw.number,
    nodeId: raw.node_id,
    title: raw.title,
    body: raw.body,
    state: raw.state as Issue['state'],
    labels: raw.labels.map((l) => l.name),
    milestone: raw.milestone?.number ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    url: raw.html_url,
  };
}

function mapIssueComment(raw: GitHubRawIssueComment): IssueComment {
  return {
    id: raw.id,
    body: raw.body,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    url: raw.html_url,
  };
}

function mapMilestone(raw: GitHubRawMilestone): Milestone {
  return {
    id: raw.number,
    nodeId: raw.node_id,
    title: raw.title,
    description: raw.description,
    state: raw.state as Milestone['state'],
    openIssues: raw.open_issues,
    closedIssues: raw.closed_issues,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
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

export type PRReviewDecision =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'REVIEW_REQUIRED';

export interface PRReviewSummary {
  id: number;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  author: string;
  body: string | null;
  submittedAt: string;
}

export interface PRCommentSummary {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  path?: string | null;
  line?: number | null;
}

export interface SizeSignal {
  linesAdded: number;
  linesDeleted: number;
  filesTouched: number;
  specFileCount: number;
  oversizeRatio: number; // filesTouched / max(specFileCount, 1); 0 when no spec list
  exceededAbsoluteFloor: boolean; // (linesAdded + linesDeleted) > 800
  /**
   * Per-task LOC override from the Notion "Expected size" property. When set,
   * `isOversized` uses only `linesAdded + linesDeleted > expectedSize` and
   * skips the absolute-floor + file-ratio defaults so refactors and
   * infrastructure tasks aren't mis-flagged.
   */
  expectedSize?: number;
}

/** Absolute LOC floor above which a PR is flagged for size-proportionality review. */
export const SIZE_ABSOLUTE_FLOOR = 800;
/** File-count ratio above which a PR is flagged (filesTouched / specFileCount). */
export const SIZE_FILE_RATIO_LIMIT = 3;

/**
 * Files whose diffs should be excluded from the LOC count because they are
 * machine-generated and their churn is not representative of human-written change.
 * Matched as a suffix (file basename) or by file extension.
 */
const GENERATED_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /\.snap$/,
  /\.svg$/,
];

function isGeneratedFile(path: string): boolean {
  return GENERATED_FILE_PATTERNS.some((re) => re.test(path));
}

/** Extract spec file paths from the "Files / paths affected" section of a task spec. */
function parseSpecFiles(specFilesSection: string): string[] {
  if (!specFilesSection.trim()) return [];
  return specFilesSection
    .split('\n')
    .map((line) => line.replace(/^[-*\s]+/, '').trim())
    .filter(
      (line) => line.length > 0 && (line.includes('/') || line.includes('.')),
    );
}

/**
 * Compute size proportionality signal for a PR diff vs. its task spec.
 * Lines added/deleted are summed across non-generated files only.
 * Files touched counts the total number of files in the diff (including generated).
 *
 * When `expectedSize` is provided (from the task's "Expected size" property),
 * it is recorded on the returned signal and overrides the default heuristic in
 * `isOversized`.
 */
export function computeSizeSignal(
  diff: string,
  specFilesSection: string,
  expectedSize?: number,
): SizeSignal {
  const specFiles = parseSpecFiles(specFilesSection);
  const specFileCount = specFiles.length;

  let linesAdded = 0;
  let linesDeleted = 0;
  const files = new Set<string>();
  let currentFile: string | null = null;
  let currentFileIsGenerated = false;

  for (const line of diff.split('\n')) {
    // New file section
    if (line.startsWith('diff --git a/')) {
      const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
      currentFile = m ? m[1] : null;
      if (currentFile) {
        files.add(currentFile);
        currentFileIsGenerated = isGeneratedFile(currentFile);
      } else {
        currentFileIsGenerated = false;
      }
      continue;
    }
    if (currentFile === null) continue;
    if (currentFileIsGenerated) continue;
    // Ignore the file-header lines (---/+++), only count real +/− body lines.
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) linesAdded++;
    else if (line.startsWith('-')) linesDeleted++;
  }

  const filesTouched = files.size;
  const oversizeRatio = specFileCount > 0 ? filesTouched / specFileCount : 0;
  const exceededAbsoluteFloor = linesAdded + linesDeleted > SIZE_ABSOLUTE_FLOOR;

  return {
    linesAdded,
    linesDeleted,
    filesTouched,
    specFileCount,
    oversizeRatio,
    exceededAbsoluteFloor,
    expectedSize,
  };
}

/**
 * True when the PR exceeds the size budget. When `expectedSize` is set on the
 * signal, only `linesAdded + linesDeleted > expectedSize` matters — the
 * absolute-floor and file-ratio defaults are bypassed. Without an override,
 * the global heuristic (>800 LOC OR >3× spec files) applies.
 */
export function isOversized(signal: SizeSignal): boolean {
  if (signal.expectedSize !== undefined) {
    return signal.linesAdded + signal.linesDeleted > signal.expectedSize;
  }
  if (signal.exceededAbsoluteFloor) return true;
  if (signal.specFileCount > 0 && signal.oversizeRatio > SIZE_FILE_RATIO_LIMIT)
    return true;
  return false;
}
