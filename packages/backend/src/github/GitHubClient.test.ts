import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing GitHubClient
vi.mock('../config.js', () => ({
  GITHUB_TOKEN: 'ghp_test_token',
  GITHUB_REPO: 'owner/test-repo',
  config: {},
}));

vi.mock('../db/queries.js', () => ({
  getPRByNumber: vi.fn().mockReturnValue(null),
}));

import {
  GitHubClient,
  computeSizeSignal,
  isOversized,
  SIZE_ABSOLUTE_FLOOR,
} from './GitHubClient';
import { GitHubApiError } from './types';
import { getPRByNumber } from '../db/queries';

// Sample unified diff fixture
const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc123..def456 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 import foo from './foo';
+import bar from './bar';

 export default foo;
diff --git a/src/bar.ts b/src/bar.ts
index 111111..222222 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,2 +1,3 @@
 export const bar = 1;
+export const baz = 2;
`;

function mockFetch(response: Partial<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({}),
      text: async () => '',
      ...response,
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHubClient constructor', () => {
  it('does not throw when GITHUB_TOKEN and GITHUB_REPO are set', () => {
    expect(() => new GitHubClient()).not.toThrow();
  });
});

describe('GitHubClient.listOpenPRs()', () => {
  it('returns all open PRs including drafts, with draft flag preserved', async () => {
    const rawPRs = [
      {
        node_id: 'PR_kwDOA1b2c3',
        number: 1,
        title: 'Open PR',
        body: null,
        html_url: 'https://github.com/owner/repo/pull/1',
        url: 'https://api.github.com/repos/owner/repo/pulls/1',
        head: { ref: 'feature/a' },
        base: { ref: 'main' },
        state: 'open',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        draft: false,
      },
      {
        node_id: 'PR_kwDOA1b2c4',
        number: 2,
        title: 'Draft PR',
        body: null,
        html_url: 'https://github.com/owner/repo/pull/2',
        url: 'https://api.github.com/repos/owner/repo/pulls/2',
        head: { ref: 'feature/b' },
        base: { ref: 'main' },
        state: 'open',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        draft: true,
      },
    ];

    mockFetch({
      ok: true,
      headers: { get: () => 'application/json' } as unknown as Headers,
      json: async () => rawPRs,
    } as unknown as Response);

    const client = new GitHubClient();
    const prs = await client.listOpenPRs();

    // listOpenPRs is used to reconcile state against GitHub; drafts are still
    // open PRs and must remain in the result so reconciliation doesn't mark
    // them stale.
    expect(prs).toHaveLength(2);
    expect(prs.find((p) => p.id === 1)?.draft).toBe(false);
    expect(prs.find((p) => p.id === 2)?.draft).toBe(true);
  });
});

describe('GitHubClient.fetchDiff()', () => {
  it('correctly parses filesChanged from a unified diff', async () => {
    mockFetch({
      ok: true,
      headers: { get: () => 'text/plain' } as unknown as Headers,
      text: async () => SAMPLE_DIFF,
    } as unknown as Response);

    const client = new GitHubClient();
    const result = await client.fetchDiff(42);

    expect(result.prId).toBe(42);
    expect(result.diff).toBe(SAMPLE_DIFF);
    expect(result.filesChanged).toEqual(['src/foo.ts', 'src/bar.ts']);
  });
});

describe('GitHubClient.markPRReady()', () => {
  it('sends GraphQL mutation to https://api.github.com/graphql with node_id from DB', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      id: 1,
      pr_number: 42,
      pr_url: 'https://github.com/owner/repo/pull/42',
      node_id: 'PR_kwDOA1b2c3',
      notion_task_id: null,
      session_id: null,
      repo: 'owner/repo',
      title: null,
      body: null,
      head_branch: null,
      base_branch: null,
      state: 'open',
      draft: 1,
      review_result: null,
      review_at: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      synced_at: '2024-01-01T00:00:00Z',
      review_session_id: null,
      review_iteration: 0,
      head_sha: null,
      last_reviewed_sha: null,
    });

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        data: {
          markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
        },
      }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await client.markPRReady('owner/repo', 42);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/graphql');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body as string) as {
      query: string;
      variables: { pullRequestId: string };
    };
    expect(body.query).toContain('markPullRequestReadyForReview');
    expect(body.variables.pullRequestId).toBe('PR_kwDOA1b2c3');
  });

  it('falls back to REST fetch when node_id not in DB, then calls GraphQL', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(null);

    const fetchSpy = vi
      .fn()
      // First call: REST fetch to get PR (for node_id)
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          node_id: 'PR_kwDOA1b2c9',
          number: 42,
          title: 'Test',
          body: null,
          html_url: 'https://github.com/owner/repo/pull/42',
          url: 'https://api.github.com/repos/owner/repo/pulls/42',
          head: { ref: 'feature/x' },
          base: { ref: 'dev' },
          state: 'open',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          draft: true,
        }),
        text: async () => '',
      })
      // Second call: GraphQL mutation
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          data: {
            markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
          },
        }),
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await client.markPRReady('owner/repo', 42);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [graphqlUrl, graphqlOptions] = fetchSpy.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(graphqlUrl).toBe('https://api.github.com/graphql');
    const body = JSON.parse(graphqlOptions.body as string) as {
      variables: { pullRequestId: string };
    };
    expect(body.variables.pullRequestId).toBe('PR_kwDOA1b2c9');
  });

  it('throws GitHubApiError when GraphQL returns errors', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      id: 1,
      pr_number: 42,
      pr_url: 'https://github.com/owner/repo/pull/42',
      node_id: 'PR_kwDOA1b2c3',
      notion_task_id: null,
      session_id: null,
      repo: 'owner/repo',
      title: null,
      body: null,
      head_branch: null,
      base_branch: null,
      state: 'open',
      draft: 1,
      review_result: null,
      review_at: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      synced_at: '2024-01-01T00:00:00Z',
      review_session_id: null,
      review_iteration: 0,
      head_sha: null,
      last_reviewed_sha: null,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          errors: [{ message: 'PR not found' }, { message: 'Unauthorized' }],
        }),
        text: async () => '',
      }),
    );

    const client = new GitHubClient();
    await expect(client.markPRReady('owner/repo', 42)).rejects.toThrow(
      GitHubApiError,
    );
    await expect(client.markPRReady('owner/repo', 42)).rejects.toMatchObject({
      status: 422,
      message: 'PR not found; Unauthorized',
    });
  });
});

describe('GitHubClient mapPR — node_id', () => {
  it('maps node_id from raw PR to nodeId on PullRequest', async () => {
    mockFetch({
      ok: true,
      headers: { get: () => 'application/json' } as unknown as Headers,
      json: async () => [
        {
          node_id: 'PR_kwDOTestNodeId',
          number: 5,
          title: 'Test PR',
          body: null,
          html_url: 'https://github.com/owner/repo/pull/5',
          url: 'https://api.github.com/repos/owner/repo/pulls/5',
          head: { ref: 'feature/test' },
          base: { ref: 'main' },
          state: 'open',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
          draft: false,
        },
      ],
    } as unknown as Response);

    const client = new GitHubClient();
    const prs = await client.listOpenPRs('owner/repo');
    expect(prs[0].nodeId).toBe('PR_kwDOTestNodeId');
  });
});

describe('GitHubClient request error handling', () => {
  it('throws GitHubApiError with correct status when response.ok is false', async () => {
    mockFetch({
      ok: false,
      status: 404,
      headers: { get: () => 'application/json' } as unknown as Headers,
      text: async () => 'Not Found',
    } as unknown as Response);

    const client = new GitHubClient();
    await expect(client.listOpenPRs()).rejects.toThrow(GitHubApiError);
    await expect(client.listOpenPRs()).rejects.toMatchObject({ status: 404 });
  });

  it('throws GitHubApiError with status 405 for non-mergeable PR', async () => {
    mockFetch({
      ok: false,
      status: 405,
      headers: { get: () => 'application/json' } as unknown as Headers,
      text: async () => 'Method Not Allowed',
    } as unknown as Response);

    const client = new GitHubClient();
    await expect(client.mergePR(1, 'squash commit')).rejects.toThrow(
      GitHubApiError,
    );
    await expect(client.mergePR(1, 'squash commit')).rejects.toMatchObject({
      status: 405,
    });
  });
});

// ── computeSizeSignal() ──────────────────────────────────────────────────────

// ── getFailingChecks() ───────────────────────────────────────────────────────

describe('GitHubClient.getFailingChecks()', () => {
  it('returns only failing/timed_out/cancelled/action_required check-runs', async () => {
    const checkRuns = [
      { name: 'success-check', status: 'completed', conclusion: 'success' },
      { name: 'lint', status: 'completed', conclusion: 'failure' },
      { name: 'unit-tests', status: 'completed', conclusion: 'failure' },
      { name: 'flaky-test', status: 'completed', conclusion: 'timed_out' },
      { name: 'cancelled-check', status: 'completed', conclusion: 'cancelled' },
      {
        name: 'manual-step',
        status: 'completed',
        conclusion: 'action_required',
      },
      { name: 'skipped-check', status: 'completed', conclusion: 'skipped' },
      { name: 'neutral-check', status: 'completed', conclusion: 'neutral' },
      // Incomplete runs are excluded — only completed runs count.
      { name: 'still-running', status: 'in_progress', conclusion: null },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ check_runs: checkRuns }),
        text: async () => '',
      }),
    );

    const client = new GitHubClient();
    const failing = await client.getFailingChecks('deadbeef', 'owner/repo');

    expect(failing.map((c) => c.name)).toEqual([
      'lint',
      'unit-tests',
      'flaky-test',
      'cancelled-check',
      'manual-step',
    ]);
    expect(failing.find((c) => c.name === 'lint')?.conclusion).toBe('failure');
  });

  it('returns an empty array when no check-runs have failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          check_runs: [
            { name: 'all-good', status: 'completed', conclusion: 'success' },
          ],
        }),
        text: async () => '',
      }),
    );

    const client = new GitHubClient();
    const failing = await client.getFailingChecks('deadbeef', 'owner/repo');
    expect(failing).toEqual([]);
  });

  it('hits the correct endpoint path', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ check_runs: [] }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await client.getFailingChecks('abc123', 'owner/repo');

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/repos/owner/repo/commits/abc123/check-runs'),
      expect.anything(),
    );
  });
});

// ── categorizeMergeability() ─────────────────────────────────────────────────

describe('GitHubClient.categorizeMergeability()', () => {
  function mockPRThenChecks(
    prResponse: {
      mergeable_state: string | null;
      head_sha?: string;
    },
    checkRuns: Array<{
      name: string;
      status: string;
      conclusion: string | null;
    }> = [],
  ): ReturnType<typeof vi.fn> {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          node_id: 'PR_1',
          number: 42,
          title: 'Test PR',
          body: null,
          html_url: 'https://github.com/owner/repo/pull/42',
          url: 'https://api.github.com/repos/owner/repo/pulls/42',
          head: { ref: 'feature/x', sha: prResponse.head_sha ?? 'sha-abc' },
          base: { ref: 'dev' },
          state: 'open',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          mergeable: null,
          mergeable_state: prResponse.mergeable_state,
          draft: false,
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ check_runs: checkRuns }),
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  it('categorizes clean as clean (no check-runs fetched)', async () => {
    const fetchSpy = mockPRThenChecks({ mergeable_state: 'clean' });
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.category).toBe('clean');
    expect(result.mergeState).toBe('clean');
    expect(result.failingChecks).toEqual([]);
    // Only the PR fetch should fire — no check-runs request.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('categorizes dirty as conflict', async () => {
    mockPRThenChecks({ mergeable_state: 'dirty' });
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.category).toBe('conflict');
    expect(result.mergeState).toBe('dirty');
  });

  it('categorizes behind as conflict (needs rebase)', async () => {
    mockPRThenChecks({ mergeable_state: 'behind' });
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.category).toBe('conflict');
    expect(result.mergeState).toBe('dirty');
  });

  it('categorizes unstable as ci_failed and includes failing-check names', async () => {
    mockPRThenChecks({ mergeable_state: 'unstable' }, [
      { name: 'lint', status: 'completed', conclusion: 'failure' },
      { name: 'unit-tests', status: 'completed', conclusion: 'success' },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.category).toBe('ci_failed');
    expect(result.mergeState).toBe('ci_failed');
    expect(result.failingChecks.map((c) => c.name)).toEqual(['lint']);
  });

  it('categorizes blocked + failing checks as ci_failed', async () => {
    mockPRThenChecks({ mergeable_state: 'blocked' }, [
      { name: 'required-check', status: 'completed', conclusion: 'failure' },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.category).toBe('ci_failed');
    expect(result.mergeState).toBe('ci_failed');
    expect(result.failingChecks).toHaveLength(1);
  });

  it('categorizes blocked + no failing checks as blocked', async () => {
    mockPRThenChecks({ mergeable_state: 'blocked' }, [
      { name: 'happy-check', status: 'completed', conclusion: 'success' },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.category).toBe('blocked');
    expect(result.mergeState).toBe('blocked');
    expect(result.failingChecks).toEqual([]);
  });

  it('categorizes unknown mergeable_state as unknown', async () => {
    mockPRThenChecks({ mergeable_state: 'unknown' });
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.category).toBe('unknown');
    expect(result.mergeState).toBe('unknown');
  });

  it('categorizes unstable + no failing checks as unknown (CI still pending)', async () => {
    mockPRThenChecks({ mergeable_state: 'unstable' }, [
      { name: 'lint', status: 'in_progress', conclusion: null },
      { name: 'unit-tests', status: 'in_progress', conclusion: null },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.category).toBe('unknown');
    expect(result.mergeState).toBe('unstable');
    expect(result.failingChecks).toEqual([]);
  });

  it('categorizes unstable + one failed check as ci_failed', async () => {
    mockPRThenChecks({ mergeable_state: 'unstable' }, [
      { name: 'unit-tests', status: 'completed', conclusion: 'failure' },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.category).toBe('ci_failed');
    expect(result.mergeState).toBe('ci_failed');
    expect(result.failingChecks.map((c) => c.name)).toEqual(['unit-tests']);
  });

  it('returns unknown when check-runs request fails for unstable PR (graceful degradation)', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          node_id: 'PR_1',
          number: 42,
          title: 'Test',
          body: null,
          html_url: 'https://github.com/owner/repo/pull/42',
          url: 'https://api.github.com/repos/owner/repo/pulls/42',
          head: { ref: 'feature/x', sha: 'sha-abc' },
          base: { ref: 'dev' },
          state: 'open',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          mergeable_state: 'unstable',
          draft: false,
        }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: { get: () => 'application/json' },
        text: async () => 'GitHub error',
      });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    // safeGetFailingChecks returns [] on error → unknown (AutoMerger polls until deadline).
    expect(result.category).toBe('unknown');
    expect(result.failingChecks).toEqual([]);
  });
});

describe('computeSizeSignal()', () => {
  const TWO_FILE_SPEC =
    '- packages/backend/src/foo.ts\n- packages/backend/src/bar.ts';

  it('returns zeros for empty diff', () => {
    const s = computeSizeSignal('', TWO_FILE_SPEC);
    expect(s.linesAdded).toBe(0);
    expect(s.linesDeleted).toBe(0);
    expect(s.filesTouched).toBe(0);
    expect(s.specFileCount).toBe(2);
    expect(s.oversizeRatio).toBe(0);
    expect(s.exceededAbsoluteFloor).toBe(false);
    expect(isOversized(s)).toBe(false);
  });

  it('handles diff with no spec files section: specFileCount=0, oversizeRatio=0', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,2 @@',
      ' a',
      '+b',
    ].join('\n');
    const s = computeSizeSignal(diff, '');
    expect(s.linesAdded).toBe(1);
    expect(s.linesDeleted).toBe(0);
    expect(s.filesTouched).toBe(1);
    expect(s.specFileCount).toBe(0);
    expect(s.oversizeRatio).toBe(0);
    expect(isOversized(s)).toBe(false);
  });

  it('flags exceededAbsoluteFloor for a 2,535-line case', () => {
    const lines: string[] = [
      'diff --git a/src/big.ts b/src/big.ts',
      '--- a/src/big.ts',
      '+++ b/src/big.ts',
      '@@ -1,1000 +1,1535 @@',
    ];
    for (let i = 0; i < 1535; i++) lines.push(`+added line ${i}`);
    for (let i = 0; i < 1000; i++) lines.push(`-removed line ${i}`);
    const diff = lines.join('\n');
    const s = computeSizeSignal(diff, TWO_FILE_SPEC);
    expect(s.linesAdded).toBe(1535);
    expect(s.linesDeleted).toBe(1000);
    expect(s.linesAdded + s.linesDeleted).toBe(2535);
    expect(s.exceededAbsoluteFloor).toBe(true);
    expect(isOversized(s)).toBe(true);
  });

  it('flags oversizeRatio>3 even when LOC is small', () => {
    const lines = ['diff --git a/a/a.ts b/a/a.ts'];
    // 7 files vs 2 in spec = ratio 3.5
    for (let i = 0; i < 7; i++) {
      lines.push(`diff --git a/src/f${i}.ts b/src/f${i}.ts`);
      lines.push('--- a/src/f' + i + '.ts');
      lines.push('+++ b/src/f' + i + '.ts');
      lines.push('@@ -1,1 +1,1 @@');
      lines.push('+x');
    }
    const diff = lines.join('\n');
    const s = computeSizeSignal(diff, TWO_FILE_SPEC);
    expect(s.specFileCount).toBe(2);
    expect(s.filesTouched).toBeGreaterThan(6);
    expect(s.oversizeRatio).toBeGreaterThan(3);
    expect(isOversized(s)).toBe(true);
  });

  it('does not flag a small in-budget PR', () => {
    const diff = [
      'diff --git a/packages/backend/src/foo.ts b/packages/backend/src/foo.ts',
      '--- a/packages/backend/src/foo.ts',
      '+++ b/packages/backend/src/foo.ts',
      '@@ -1,1 +1,2 @@',
      ' a',
      '+b',
    ].join('\n');
    const s = computeSizeSignal(diff, TWO_FILE_SPEC);
    expect(s.linesAdded).toBe(1);
    expect(s.filesTouched).toBe(1);
    expect(s.exceededAbsoluteFloor).toBe(false);
    expect(isOversized(s)).toBe(false);
  });

  it('filters generated files (package-lock.json, *.snap, *.svg) from LOC count', () => {
    const lines = [
      // Generated file with massive churn — should NOT be counted in LOC
      'diff --git a/package-lock.json b/package-lock.json',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -1,1 +1,1500 @@',
    ];
    for (let i = 0; i < 1500; i++) lines.push(`+lockfile line ${i}`);
    // Real human file
    lines.push('diff --git a/src/foo.ts b/src/foo.ts');
    lines.push('--- a/src/foo.ts');
    lines.push('+++ b/src/foo.ts');
    lines.push('@@ -1,1 +1,3 @@');
    lines.push(' keep');
    lines.push('+new');
    lines.push('+also new');
    // .snap and .svg also excluded
    lines.push(
      'diff --git a/__snapshots__/component.test.ts.snap b/__snapshots__/component.test.ts.snap',
    );
    lines.push('--- a/__snapshots__/component.test.ts.snap');
    lines.push('+++ b/__snapshots__/component.test.ts.snap');
    lines.push('@@ -1,1 +1,1000 @@');
    for (let i = 0; i < 1000; i++) lines.push(`+snapshot line ${i}`);
    lines.push('diff --git a/icons/logo.svg b/icons/logo.svg');
    lines.push('--- a/icons/logo.svg');
    lines.push('+++ b/icons/logo.svg');
    lines.push('@@ -1,1 +1,500 @@');
    for (let i = 0; i < 500; i++) lines.push(`+<path d="..."/>`);

    const s = computeSizeSignal(lines.join('\n'), '- src/foo.ts');
    // Only the 2 real lines should be counted; lockfile/snap/svg excluded.
    expect(s.linesAdded).toBe(2);
    expect(s.linesDeleted).toBe(0);
    // filesTouched still reflects the total count of files in the diff
    expect(s.filesTouched).toBe(4);
    expect(s.exceededAbsoluteFloor).toBe(false);
  });

  it('exposes the documented SIZE_ABSOLUTE_FLOOR threshold of 800', () => {
    expect(SIZE_ABSOLUTE_FLOOR).toBe(800);
  });

  describe('with Expected size override', () => {
    // Diff that triggers BOTH defaults: 1000 LOC (> 800 floor) AND ratio > 3
    // (7 files touched vs 2 spec files = 3.5×). Without an override this is
    // oversized; with a generous expectedSize it should pass.
    function buildLargeDiff(): string {
      const lines: string[] = [];
      for (let i = 0; i < 7; i++) {
        lines.push(`diff --git a/src/f${i}.ts b/src/f${i}.ts`);
        lines.push(`--- a/src/f${i}.ts`);
        lines.push(`+++ b/src/f${i}.ts`);
        lines.push('@@ -1,0 +1,1000 @@');
      }
      // 1000 added lines spread across the diff (all go to the last file
      // since lines after the final `diff --git` header belong to it).
      for (let i = 0; i < 1000; i++) lines.push(`+added line ${i}`);
      return lines.join('\n');
    }

    it('records the override on the returned signal', () => {
      const s = computeSizeSignal('', TWO_FILE_SPEC, 1500);
      expect(s.expectedSize).toBe(1500);
    });

    it('flags oversized when LOC exceeds the expected-size budget', () => {
      const diff = buildLargeDiff();
      const s = computeSizeSignal(diff, TWO_FILE_SPEC, 500);
      expect(s.linesAdded).toBe(1000);
      expect(s.expectedSize).toBe(500);
      expect(isOversized(s)).toBe(true);
    });

    it('passes within an expected-size budget even when defaults would flag', () => {
      const diff = buildLargeDiff();
      const s = computeSizeSignal(diff, TWO_FILE_SPEC, 2000);
      // The default heuristic would flag this: > 800 LOC AND ratio > 3.
      expect(s.exceededAbsoluteFloor).toBe(true);
      expect(s.oversizeRatio).toBeGreaterThan(3);
      // Override raises the budget above the actual LOC and suppresses the file-ratio default.
      expect(isOversized(s)).toBe(false);
    });

    it('still applies defaults when expectedSize is undefined', () => {
      const diff = buildLargeDiff();
      const s = computeSizeSignal(diff, TWO_FILE_SPEC);
      expect(s.expectedSize).toBeUndefined();
      expect(isOversized(s)).toBe(true);
    });
  });
});
