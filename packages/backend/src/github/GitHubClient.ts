import { GITHUB_TOKEN, GITHUB_REPO } from '../config';
import {
  GitHubApiError,
  PullRequest,
  PRDiff,
  MergeResult,
  FailingCheck,
  MergeabilityCategory,
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

  // Retry getMergeability with exponential backoff (2s, 4s, 8s, 16s, 32s) when
  // GitHub returns mergeable: null. After all 5 retries, returns the last (still-null) result.
  async getMergeabilityWithRetry(
    prNumber: number,
    repo?: string,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
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

  async fetchDiff(prId: number, repo?: string, branches?: { base: string; head: string }): Promise<PRDiff> {
    const r = repo ?? GITHUB_REPO;
    let diff: string;
    if (branches) {
      // Explicit three-dot compare endpoint — guarantees merge-base semantics
      diff = await this.request<string>(
        `/repos/${r}/compare/${branches.base}...${branches.head}`,
        { headers: { ...this.headers, 'Accept': 'application/vnd.github.diff' } }
      );
    } else {
      diff = await this.request<string>(
        `/repos/${r}/pulls/${prId}`,
        { headers: { ...this.headers, 'Accept': 'application/vnd.github.diff' } }
      );
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

  /**
   * Fetch failing check-runs for a given commit SHA. Used to distinguish
   * "blocked by failing CI" from "blocked by branch protection" when a merge
   * attempt fails with 409/405 or when mergeable_state is `unstable`/`blocked`.
   */
  async getFailingChecks(sha: string, repo?: string): Promise<FailingCheck[]> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<{
      check_runs: Array<{ name: string; status: string; conclusion: string | null }>;
    }>(`/repos/${r}/commits/${sha}/check-runs?per_page=100`);
    return data.check_runs
      .filter((c) => c.status === 'completed' && c.conclusion !== null && FAILING_CHECK_CONCLUSIONS.has(c.conclusion))
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
   */
  async categorizeMergeability(prNumber: number, repo?: string): Promise<MergeabilityCategory> {
    const r = repo ?? GITHUB_REPO;
    const data = await this.request<GitHubRawPR>(`/repos/${r}/pulls/${prNumber}`);
    const rawMergeableState = data.mergeable_state ?? null;
    const headSha = data.head?.sha ?? null;

    if (rawMergeableState === 'dirty' || rawMergeableState === 'behind') {
      return { category: 'conflict', mergeState: 'dirty', rawMergeableState, failingChecks: [] };
    }
    if (rawMergeableState === 'unstable') {
      const failingChecks = headSha ? await this.safeGetFailingChecks(headSha, r) : [];
      return { category: 'ci_failed', mergeState: 'ci_failed', rawMergeableState, failingChecks };
    }
    if (rawMergeableState === 'blocked') {
      const failingChecks = headSha ? await this.safeGetFailingChecks(headSha, r) : [];
      if (failingChecks.length > 0) {
        return { category: 'ci_failed', mergeState: 'ci_failed', rawMergeableState, failingChecks };
      }
      return { category: 'blocked', mergeState: 'blocked', rawMergeableState, failingChecks: [] };
    }
    if (rawMergeableState === 'clean') {
      return { category: 'clean', mergeState: 'clean', rawMergeableState, failingChecks: [] };
    }
    return { category: 'unknown', mergeState: rawMergeableState ?? 'unknown', rawMergeableState, failingChecks: [] };
  }

  private async safeGetFailingChecks(sha: string, repo: string): Promise<FailingCheck[]> {
    try {
      return await this.getFailingChecks(sha, repo);
    } catch (err) {
      console.warn(
        `[GitHubClient] getFailingChecks failed for ${sha} in ${repo}:`,
        (err as Error).message,
      );
      return [];
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

export interface SizeSignal {
  linesAdded: number;
  linesDeleted: number;
  filesTouched: number;
  specFileCount: number;
  oversizeRatio: number;          // filesTouched / max(specFileCount, 1); 0 when no spec list
  exceededAbsoluteFloor: boolean; // (linesAdded + linesDeleted) > 800
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
    .filter((line) => line.length > 0 && (line.includes('/') || line.includes('.')));
}

/**
 * Compute size proportionality signal for a PR diff vs. its task spec.
 * Lines added/deleted are summed across non-generated files only.
 * Files touched counts the total number of files in the diff (including generated).
 */
export function computeSizeSignal(diff: string, specFilesSection: string): SizeSignal {
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
  const exceededAbsoluteFloor = (linesAdded + linesDeleted) > SIZE_ABSOLUTE_FLOOR;

  return {
    linesAdded,
    linesDeleted,
    filesTouched,
    specFileCount,
    oversizeRatio,
    exceededAbsoluteFloor,
  };
}

/** True when the PR exceeds either size threshold (absolute LOC or file-count ratio). */
export function isOversized(signal: SizeSignal): boolean {
  if (signal.exceededAbsoluteFloor) return true;
  if (signal.specFileCount > 0 && signal.oversizeRatio > SIZE_FILE_RATIO_LIMIT) return true;
  return false;
}
