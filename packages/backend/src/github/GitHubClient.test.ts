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
      task_id: null,
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
      task_id: null,
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
      body: 'PR not found; Unauthorized',
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

  it('populates detailsUrl from details_url on failing checks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          check_runs: [
            {
              name: 'build',
              status: 'completed',
              conclusion: 'failure',
              details_url:
                'https://github.com/owner/repo/actions/runs/42/job/1',
              html_url: 'https://github.com/owner/repo/actions/runs/42',
            },
          ],
        }),
        text: async () => '',
      }),
    );

    const client = new GitHubClient();
    const failing = await client.getFailingChecks('deadbeef', 'owner/repo');
    expect(failing[0]?.detailsUrl).toBe(
      'https://github.com/owner/repo/actions/runs/42/job/1',
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
      details_url?: string;
      html_url?: string;
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

  it('categorizes unstable + running checks as ci_running (CI in progress)', async () => {
    mockPRThenChecks({ mergeable_state: 'unstable' }, [
      { name: 'lint', status: 'in_progress', conclusion: null },
      { name: 'unit-tests', status: 'in_progress', conclusion: null },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.category).toBe('unknown');
    expect(result.mergeState).toBe('ci_running');
    expect(result.failingChecks).toEqual([]);
  });

  it('categorizes unstable + queued check as ci_running', async () => {
    mockPRThenChecks({ mergeable_state: 'unstable' }, [
      { name: 'build', status: 'queued', conclusion: null },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.category).toBe('unknown');
    expect(result.mergeState).toBe('ci_running');
    expect(result.failingChecks).toEqual([]);
  });

  it('categorizes unstable + no failing and no running checks as unstable (genuine edge case)', async () => {
    mockPRThenChecks({ mergeable_state: 'unstable' }, [
      { name: 'check', status: 'completed', conclusion: 'success' },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.category).toBe('unknown');
    expect(result.mergeState).toBe('unstable');
    expect(result.failingChecks).toEqual([]);
  });

  it('categorizes unstable + one failed check as ci_failed (unchanged)', async () => {
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

  it('populates detailsUrl on failing checks from details_url ?? html_url', async () => {
    mockPRThenChecks({ mergeable_state: 'unstable' }, [
      {
        name: 'unit-tests',
        status: 'completed',
        conclusion: 'failure',
        details_url: 'https://github.com/owner/repo/actions/runs/999/job/123',
        html_url: 'https://github.com/owner/repo/actions/runs/999',
      },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.failingChecks[0]?.detailsUrl).toBe(
      'https://github.com/owner/repo/actions/runs/999/job/123',
    );
  });

  it('falls back to html_url when details_url is absent', async () => {
    mockPRThenChecks({ mergeable_state: 'unstable' }, [
      {
        name: 'unit-tests',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/owner/repo/actions/runs/999',
      },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo');
    expect(result.failingChecks[0]?.detailsUrl).toBe(
      'https://github.com/owner/repo/actions/runs/999',
    );
  });
});

// ── ciCheckNames filtering ────────────────────────────────────────────────────

describe('GitHubClient.categorizeMergeability() — ciCheckNames filtering', () => {
  function mockPRThenChecks(
    prResponse: { mergeable_state: string | null; head_sha?: string },
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

  it('empty ciCheckNames preserves ci_failed for unstable with failing checks', async () => {
    mockPRThenChecks({ mergeable_state: 'unstable' }, [
      { name: 'lint', status: 'completed', conclusion: 'failure' },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo', []);
    expect(result.category).toBe('ci_failed');
    expect(result.failingChecks.map((c) => c.name)).toEqual(['lint']);
  });

  it('empty ciCheckNames preserves blocked state when no checks fail', async () => {
    mockPRThenChecks({ mergeable_state: 'blocked' }, [
      { name: 'lint', status: 'completed', conclusion: 'success' },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo', []);
    expect(result.category).toBe('blocked');
  });

  it('empty ciCheckNames preserves conflict state', async () => {
    mockPRThenChecks({ mergeable_state: 'dirty' });
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo', []);
    expect(result.category).toBe('conflict');
  });

  it('empty ciCheckNames preserves clean state', async () => {
    mockPRThenChecks({ mergeable_state: 'clean' });
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo', []);
    expect(result.category).toBe('clean');
  });

  it('non-empty ciCheckNames ignores failures on checks not in the list (unstable)', async () => {
    mockPRThenChecks({ mergeable_state: 'unstable' }, [
      { name: 'lint', status: 'completed', conclusion: 'failure' },
      { name: 'build', status: 'completed', conclusion: 'success' },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo', [
      'build',
    ]);
    // lint failure should be ignored — only build counts, and build passed
    expect(result.category).toBe('unknown');
    expect(result.failingChecks).toEqual([]);
  });

  it('non-empty ciCheckNames reports ci_failed when a named check fails (unstable)', async () => {
    mockPRThenChecks({ mergeable_state: 'unstable' }, [
      { name: 'lint', status: 'completed', conclusion: 'failure' },
      { name: 'build', status: 'completed', conclusion: 'failure' },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo', [
      'build',
    ]);
    expect(result.category).toBe('ci_failed');
    expect(result.failingChecks.map((c) => c.name)).toEqual(['build']);
  });

  it('non-empty ciCheckNames ignores failures on checks not in the list (blocked)', async () => {
    mockPRThenChecks({ mergeable_state: 'blocked' }, [
      { name: 'lint', status: 'completed', conclusion: 'failure' },
      { name: 'build', status: 'completed', conclusion: 'success' },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo', [
      'build',
    ]);
    // lint failure ignored; build passed and is present — blocked (not CI, other reason)
    expect(result.category).toBe('blocked');
    expect(result.failingChecks).toEqual([]);
  });

  it('non-empty ciCheckNames reports unknown when a named check has not yet reported (blocked)', async () => {
    mockPRThenChecks({ mergeable_state: 'blocked' }, [
      { name: 'lint', status: 'completed', conclusion: 'success' },
      // 'build' is absent from check-runs — not yet reported
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo', [
      'build',
    ]);
    // named check 'build' hasn't reported → treat as pending (unknown, not blocked)
    expect(result.category).toBe('unknown');
    expect(result.failingChecks).toEqual([]);
  });

  it('non-empty ciCheckNames reports unknown when a named check is still in_progress (unstable)', async () => {
    mockPRThenChecks({ mergeable_state: 'unstable' }, [
      { name: 'build', status: 'in_progress', conclusion: null },
    ]);
    const client = new GitHubClient();
    const result = await client.categorizeMergeability(42, 'owner/repo', [
      'build',
    ]);
    // build is in_progress — not a failure, not yet done → unknown
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

// ── Issues API ────────────────────────────────────────────────────────────────

function makeRawIssue(
  overrides: Partial<{
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
  }> = {},
) {
  return {
    number: 1,
    node_id: 'I_kwDOTest',
    title: 'Test issue',
    body: 'Body text',
    state: 'open',
    labels: [{ name: 'bug' }],
    milestone: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    html_url: 'https://github.com/owner/repo/issues/1',
    ...overrides,
  };
}

function makeRawMilestone(
  overrides: Partial<{
    number: number;
    node_id: string;
    title: string;
    description: string | null;
    state: string;
    open_issues: number;
    closed_issues: number;
    created_at: string;
    updated_at: string;
  }> = {},
) {
  return {
    number: 1,
    node_id: 'MI_kwDOTest',
    title: 'v1.0',
    description: 'First release',
    state: 'open',
    open_issues: 3,
    closed_issues: 5,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('GitHubClient.listIssues()', () => {
  it('round-trips labels, milestone, state, and since into query string', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => [makeRawIssue()],
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await client.listIssues('owner/repo', {
      labels: ['bug', 'enhancement'],
      milestone: 2,
      state: 'all',
      since: '2024-01-01T00:00:00Z',
    });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('labels=bug%2Cenhancement');
    expect(url).toContain('milestone=2');
    expect(url).toContain('state=all');
    expect(url).toContain('since=2024-01-01T00%3A00%3A00Z');
  });

  it('maps raw API shape to Issue interface', async () => {
    mockFetch({
      ok: true,
      headers: { get: () => 'application/json' } as unknown as Headers,
      json: async () => [
        makeRawIssue({ labels: [{ name: 'bug' }], milestone: { number: 3 } }),
      ],
    } as unknown as Response);

    const client = new GitHubClient();
    const issues = await client.listIssues('owner/repo');

    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe(1);
    expect(issues[0].title).toBe('Test issue');
    expect(issues[0].labels).toEqual(['bug']);
    expect(issues[0].milestone).toBe(3);
  });

  it('throws GitHubApiError on non-2xx', async () => {
    mockFetch({
      ok: false,
      status: 403,
      headers: { get: () => 'application/json' } as unknown as Headers,
      text: async () => 'Forbidden',
    } as unknown as Response);

    const client = new GitHubClient();
    await expect(client.listIssues('owner/repo')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('GitHubClient.createIssue() + getIssue()', () => {
  it('round-trips title, body, labels, and milestone', async () => {
    const raw = makeRawIssue({
      number: 7,
      title: 'My issue',
      body: 'Description',
      labels: [{ name: 'feature' }],
      milestone: { number: 2 },
    });

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => raw,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => raw,
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    const created = await client.createIssue('owner/repo', {
      title: 'My issue',
      body: 'Description',
      labels: ['feature'],
      milestone: 2,
    });

    expect(created.id).toBe(7);
    expect(created.title).toBe('My issue');
    expect(created.body).toBe('Description');
    expect(created.labels).toEqual(['feature']);
    expect(created.milestone).toBe(2);

    const fetched = await client.getIssue('owner/repo', 7);
    expect(fetched.id).toBe(7);
    expect(fetched.title).toBe('My issue');
  });

  it('createIssue sends POST to correct endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => makeRawIssue({ number: 10 }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await client.createIssue('owner/repo', { title: 'New issue' });

    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/repos/owner/repo/issues');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toMatchObject({
      title: 'New issue',
    });
  });

  it('throws GitHubApiError on non-2xx for createIssue', async () => {
    mockFetch({
      ok: false,
      status: 422,
      headers: { get: () => 'application/json' } as unknown as Headers,
      text: async () => 'Validation failed',
    } as unknown as Response);

    const client = new GitHubClient();
    await expect(
      client.createIssue('owner/repo', { title: 'x' }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('GitHubClient.updateIssue()', () => {
  it('patches labels without dropping unrelated fields', async () => {
    const after = makeRawIssue({
      title: 'Updated',
      labels: [{ name: 'bug' }, { name: 'p1' }],
      state: 'open',
    });

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => after,
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    const result = await client.updateIssue('owner/repo', 1, {
      labels: ['bug', 'p1'],
    });

    expect(result.labels).toEqual(['bug', 'p1']);
    expect(result.title).toBe('Updated');

    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/repos/owner/repo/issues/1');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body as string)).toEqual({ labels: ['bug', 'p1'] });
  });

  it('throws GitHubApiError on non-2xx for updateIssue', async () => {
    mockFetch({
      ok: false,
      status: 404,
      headers: { get: () => 'application/json' } as unknown as Headers,
      text: async () => 'Not Found',
    } as unknown as Response);

    const client = new GitHubClient();
    await expect(
      client.updateIssue('owner/repo', 999, { state: 'closed' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('GitHubClient.addIssueComment() + listIssueComments()', () => {
  const rawComment = {
    id: 101,
    body: 'Great point!',
    created_at: '2024-01-03T00:00:00Z',
    updated_at: '2024-01-03T00:00:00Z',
    html_url: 'https://github.com/owner/repo/issues/1#issuecomment-101',
  };

  it('round-trips addIssueComment + listIssueComments', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => rawComment,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => [rawComment],
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    const created = await client.addIssueComment(
      'owner/repo',
      1,
      'Great point!',
    );
    expect(created.id).toBe(101);
    expect(created.body).toBe('Great point!');

    const list = await client.listIssueComments('owner/repo', 1);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(101);
    expect(list[0].body).toBe('Great point!');
  });

  it('addIssueComment sends POST to correct endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => rawComment,
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await client.addIssueComment('owner/repo', 5, 'hello');

    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/repos/owner/repo/issues/5/comments');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ body: 'hello' });
  });

  it('throws GitHubApiError on non-2xx for addIssueComment', async () => {
    mockFetch({
      ok: false,
      status: 404,
      headers: { get: () => 'application/json' } as unknown as Headers,
      text: async () => 'Not Found',
    } as unknown as Response);

    const client = new GitHubClient();
    await expect(
      client.addIssueComment('owner/repo', 999, 'x'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ── Milestones API ────────────────────────────────────────────────────────────

describe('GitHubClient milestones round-trip', () => {
  it('createMilestone + listMilestones + updateMilestone round-trip', async () => {
    const rawMs = makeRawMilestone({ number: 2, title: 'v2.0' });
    const rawMsClosed = { ...rawMs, state: 'closed' };

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => rawMs,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => [rawMs],
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => rawMsClosed,
        text: async () => '',
      });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();

    const created = await client.createMilestone('owner/repo', {
      title: 'v2.0',
      description: 'Second release',
    });
    expect(created.id).toBe(2);
    expect(created.title).toBe('v2.0');

    const list = await client.listMilestones('owner/repo');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(2);

    const updated = await client.updateMilestone('owner/repo', 2, {
      state: 'closed',
    });
    expect(updated.state).toBe('closed');
  });

  it('createMilestone sends POST with correct payload', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => makeRawMilestone(),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await client.createMilestone('owner/repo', {
      title: 'v1.0',
      description: 'First',
    });

    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/repos/owner/repo/milestones');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({
      title: 'v1.0',
      description: 'First',
    });
  });

  it('throws GitHubApiError on non-2xx for createMilestone', async () => {
    mockFetch({
      ok: false,
      status: 422,
      headers: { get: () => 'application/json' } as unknown as Headers,
      text: async () => 'Validation failed',
    } as unknown as Response);

    const client = new GitHubClient();
    await expect(
      client.createMilestone('owner/repo', { title: 'dup' }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

// ── fetchIssuesConditional() ──────────────────────────────────────────────────

describe('GitHubClient.fetchIssuesConditional()', () => {
  it('returns not_modified with 304', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 304,
        ok: false,
        headers: { get: () => null },
        text: async () => '',
      }),
    );

    const client = new GitHubClient();
    const result = await client.fetchIssuesConditional(
      'owner/repo',
      '"abc123"',
      {},
    );

    expect(result.status).toBe('not_modified');
    expect(result.etag).toBe('"abc123"');
  });

  it('returns ok with issues and new etag on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: {
          get: (h: string) => (h === 'etag' ? '"newetag"' : 'application/json'),
        },
        json: async () => [makeRawIssue({ number: 42, title: 'Fetched' })],
        text: async () => '',
      }),
    );

    const client = new GitHubClient();
    const result = await client.fetchIssuesConditional('owner/repo', null, {});

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.etag).toBe('"newetag"');
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].id).toBe(42);
      expect(result.issues[0].title).toBe('Fetched');
    }
  });

  it('sends If-None-Match header when etag is provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 304,
      ok: false,
      headers: { get: () => null },
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await client.fetchIssuesConditional('owner/repo', '"W/etag"', {});

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['If-None-Match']).toBe(
      '"W/etag"',
    );
  });

  it('does not send If-None-Match when etag is null', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: {
        get: (h: string) => (h === 'etag' ? '"fresh"' : 'application/json'),
      },
      json: async () => [],
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await client.fetchIssuesConditional('owner/repo', null, {});

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(
      (opts.headers as Record<string, string>)['If-None-Match'],
    ).toBeUndefined();
  });

  it('passes labels and since into the query string', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: {
        get: (h: string) => (h === 'etag' ? '"e"' : 'application/json'),
      },
      json: async () => [],
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await client.fetchIssuesConditional('owner/repo', null, {
      labels: ['bug', 'p1'],
      since: '2024-06-01T00:00:00Z',
    });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('labels=bug%2Cp1');
    expect(url).toContain('since=2024-06-01T00%3A00%3A00Z');
  });

  it('throws GitHubApiError on non-2xx non-304', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 401,
        ok: false,
        headers: { get: () => null },
        text: async () => 'Unauthorized',
      }),
    );

    const client = new GitHubClient();
    await expect(
      client.fetchIssuesConditional('owner/repo', null, {}),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('GitHubApiError — enumerable properties and toJSON', () => {
  it('status and body are enumerable own properties', () => {
    const err = new GitHubApiError(405, 'Pull Request is still a draft');
    const keys = Object.keys(err);
    expect(keys).toContain('status');
    expect(keys).toContain('body');
  });

  it('JSON.stringify reveals status, body, message (not {})', () => {
    const err = new GitHubApiError(405, 'Pull Request is still a draft');
    const serialized = JSON.stringify(err);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed.status).toBe(405);
    expect(parsed.body).toBe('Pull Request is still a draft');
    expect(typeof parsed.message).toBe('string');
    expect(parsed.message).toContain('405');
    expect(serialized).not.toBe('{}');
  });

  it('toJSON returns { name, status, body, message }', () => {
    const err = new GitHubApiError(422, 'Validation Failed');
    const json = err.toJSON();
    expect(json.name).toBe('GitHubApiError');
    expect(json.status).toBe(422);
    expect(json.body).toBe('Validation Failed');
    expect(json.message).toBe('GitHub API error 422: Validation Failed');
  });

  it('message contains the GitHub status code and body prefix', () => {
    const err = new GitHubApiError(403, 'Forbidden');
    expect(err.message).toBe('GitHub API error 403: Forbidden');
  });
});
