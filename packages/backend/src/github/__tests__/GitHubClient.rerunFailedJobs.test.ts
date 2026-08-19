import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../config', () => ({
  GITHUB_TOKEN: 'test-token',
  GITHUB_REPO: 'owner/repo',
}));

vi.mock('../../db/queries', () => ({
  getPRByNumber: vi.fn().mockReturnValue(null),
}));

import { GitHubClient } from '../GitHubClient';

function makeFetch(bodies: unknown[]) {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }
  return fn;
}

describe('GitHubClient.rerunFailedJobs', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rerequests completed+failing runs and marks them rerequested: true', async () => {
    const listPoll = {
      check_runs: [
        {
          id: 1,
          name: 'ci-test',
          status: 'completed',
          conclusion: 'failure',
          started_at: '2026-08-13T07:36:00Z',
        },
      ],
    };
    const mockFetch = makeFetch([listPoll, { ok: true }]);
    globalThis.fetch = mockFetch as never;

    const client = new GitHubClient();
    const result = await client.rerunFailedJobs('sha123', 'owner/repo');

    expect(result).toEqual([
      { id: 1, priorStartedAt: '2026-08-13T07:36:00Z', rerequested: true },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toContain(
      '/repos/owner/repo/check-runs/1/rerequest',
    );
  });

  it('includes an already in-flight check-run that drifted out of the completed+failing window, without re-rerequesting it', async () => {
    // No completed+failing runs at call time — one run has already been
    // reset to in_progress (e.g. by a prior attempt or GitHub's own lag)
    // by the time rerunFailedJobs looks.
    const listPoll = {
      check_runs: [
        {
          id: 2,
          name: 'ci-test',
          status: 'in_progress',
          conclusion: null,
          started_at: '2026-08-13T07:40:00Z',
        },
      ],
    };
    const mockFetch = makeFetch([listPoll]);
    globalThis.fetch = mockFetch as never;

    const client = new GitHubClient();
    const result = await client.rerunFailedJobs('sha123', 'owner/repo');

    expect(result).toEqual([
      { id: 2, priorStartedAt: '2026-08-13T07:40:00Z', rerequested: false },
    ]);
    // No rerequest call issued — only the listing fetch.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('restricts in-flight inclusion to the ciCheckNames allowlist when provided', async () => {
    const listPoll = {
      check_runs: [
        {
          id: 3,
          name: 'unrelated-check',
          status: 'queued',
          conclusion: null,
          started_at: null,
        },
        {
          id: 4,
          name: 'ci-test',
          status: 'queued',
          conclusion: null,
          started_at: null,
        },
      ],
    };
    const mockFetch = makeFetch([listPoll]);
    globalThis.fetch = mockFetch as never;

    const client = new GitHubClient();
    const result = await client.rerunFailedJobs('sha123', 'owner/repo', [
      'ci-test',
    ]);

    expect(result).toEqual([
      { id: 4, priorStartedAt: null, rerequested: false },
    ]);
  });

  it('returns an empty list when nothing is failing or in flight', async () => {
    const listPoll = {
      check_runs: [
        {
          id: 5,
          name: 'ci-test',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-08-13T07:36:00Z',
        },
      ],
    };
    const mockFetch = makeFetch([listPoll]);
    globalThis.fetch = mockFetch as never;

    const client = new GitHubClient();
    const result = await client.rerunFailedJobs('sha123', 'owner/repo');

    expect(result).toEqual([]);
  });
});
