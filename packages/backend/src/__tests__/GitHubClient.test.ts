import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  GITHUB_TOKEN: 'test-token',
  GITHUB_REPO: 'owner/default-repo',
}));

vi.mock('../db/queries.js', () => ({
  getPRByNumber: vi.fn().mockReturnValue(null),
}));

import { GitHubClient } from '../github/GitHubClient.js';

function makeRawPR(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_id: 'PR_node1',
    number: 10,
    title: 'Test PR',
    body: null,
    html_url: 'https://github.com/owner/repo/pull/10',
    url: 'https://api.github.com/repos/owner/repo/pulls/10',
    head: { ref: 'feature/test', sha: 'abc123' },
    base: { ref: 'dev' },
    state: 'closed',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-20T00:00:00Z',
    merged_at: null,
    closed_at: '2026-05-20T00:00:00Z',
    draft: false,
    ...overrides,
  };
}

function mockFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GitHubClient.listClosedPullRequests', () => {
  it('returns PRs whose merged_at falls within the lookback window', async () => {
    // 30-day window from 2026-06-01 → cutoff 2026-05-02
    const withinWindow = makeRawPR({
      number: 1,
      merged_at: '2026-05-20T00:00:00Z', // within 30 days
      closed_at: '2026-05-20T00:00:00Z',
    });
    const outsideWindow = makeRawPR({
      number: 2,
      merged_at: '2026-04-01T00:00:00Z', // older than 30 days
      closed_at: '2026-04-01T00:00:00Z',
    });
    mockFetch([withinWindow, outsideWindow]);

    const client = new GitHubClient();
    const result = await client.listClosedPullRequests('owner/repo', 30);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it('returns PRs whose closed_at (not merged) falls within the lookback window', async () => {
    const closedWithin = makeRawPR({
      number: 5,
      merged_at: null,
      closed_at: '2026-05-25T00:00:00Z',
    });
    const closedOutside = makeRawPR({
      number: 6,
      merged_at: null,
      closed_at: '2026-04-10T00:00:00Z',
    });
    mockFetch([closedWithin, closedOutside]);

    const client = new GitHubClient();
    const result = await client.listClosedPullRequests('owner/repo', 30);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(5);
  });

  it('maps merged_at non-null to state=merged', async () => {
    const mergedPR = makeRawPR({
      number: 7,
      merged_at: '2026-05-28T00:00:00Z',
      closed_at: '2026-05-28T00:00:00Z',
    });
    mockFetch([mergedPR]);

    const client = new GitHubClient();
    const result = await client.listClosedPullRequests('owner/repo', 30);

    expect(result[0].state).toBe('merged');
  });

  it('maps merged_at null to state=closed', async () => {
    const closedPR = makeRawPR({
      number: 8,
      merged_at: null,
      closed_at: '2026-05-28T00:00:00Z',
    });
    mockFetch([closedPR]);

    const client = new GitHubClient();
    const result = await client.listClosedPullRequests('owner/repo', 30);

    expect(result[0].state).toBe('closed');
  });

  it('returns empty array when no PRs fall within the lookback window', async () => {
    const oldPR = makeRawPR({
      number: 9,
      merged_at: '2026-01-01T00:00:00Z',
      closed_at: '2026-01-01T00:00:00Z',
    });
    mockFetch([oldPR]);

    const client = new GitHubClient();
    const result = await client.listClosedPullRequests('owner/repo', 30);

    expect(result).toHaveLength(0);
  });

  it('calls the GitHub API with state=closed for the given repo', async () => {
    mockFetch([]);
    const client = new GitHubClient();
    await client.listClosedPullRequests('org/my-repo', 30);

    const fetchMock = vi.mocked(global.fetch as ReturnType<typeof vi.fn>);
    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/repos/org/my-repo/pulls');
    expect(calledUrl).toContain('state=closed');
  });

  it('respects a shorter lookback window — 7 days', async () => {
    // cutoff: 2026-06-01 - 7 days = 2026-05-25
    const recent = makeRawPR({
      number: 11,
      merged_at: '2026-05-28T00:00:00Z',
      closed_at: '2026-05-28T00:00:00Z',
    });
    const olderThan7 = makeRawPR({
      number: 12,
      merged_at: '2026-05-20T00:00:00Z', // within 30 days but outside 7 days
      closed_at: '2026-05-20T00:00:00Z',
    });
    mockFetch([recent, olderThan7]);

    const client = new GitHubClient();
    const result = await client.listClosedPullRequests('owner/repo', 7);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(11);
  });
});
