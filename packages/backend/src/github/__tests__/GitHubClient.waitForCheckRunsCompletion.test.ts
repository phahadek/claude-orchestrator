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

describe('GitHubClient.waitForCheckRunsCompletion', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('does not resolve early on a stale completed first poll — requires started_at to advance', async () => {
    const priorStartedAt = '2026-08-13T07:36:00Z';
    // First poll: GitHub still reports the pre-rerequest run — status
    // 'completed' but started_at unchanged (the rerequest hasn't taken
    // effect server-side yet). This must NOT be treated as done.
    const stalePoll = {
      check_runs: [{ id: 42, status: 'completed', started_at: priorStartedAt }],
    };
    // Second poll: the run has genuinely re-executed — later started_at and
    // now terminal again.
    const freshPoll = {
      check_runs: [
        {
          id: 42,
          status: 'completed',
          started_at: '2026-08-13T07:36:45Z',
        },
      ],
    };
    const mockFetch = makeFetch([stalePoll, freshPoll]);
    globalThis.fetch = mockFetch as never;

    const client = new GitHubClient();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await client.waitForCheckRunsCompletion(
      'sha123',
      'owner/repo',
      [{ id: 42, priorStartedAt }],
      { sleep, pollIntervalMs: 10, timeoutMs: 60_000 },
    );

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('times out if the run never advances past its pre-rerequest started_at', async () => {
    const priorStartedAt = '2026-08-13T07:36:00Z';
    const stalePoll = {
      check_runs: [{ id: 42, status: 'completed', started_at: priorStartedAt }],
    };
    const mockFetch = makeFetch([stalePoll, stalePoll, stalePoll]);
    globalThis.fetch = mockFetch as never;

    const client = new GitHubClient();
    const sleep = vi.fn().mockResolvedValue(undefined);
    let now = 0;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 25;
      return now;
    });

    const result = await client.waitForCheckRunsCompletion(
      'sha123',
      'owner/repo',
      [{ id: 42, priorStartedAt }],
      { sleep, pollIntervalMs: 10, timeoutMs: 50 },
    );

    expect(result).toBe(false);
    dateSpy.mockRestore();
  });

  it('accepts an immediate completed run when no prior started_at is known', async () => {
    const onlyPoll = {
      check_runs: [
        { id: 7, status: 'completed', started_at: '2026-08-13T07:36:00Z' },
      ],
    };
    const mockFetch = makeFetch([onlyPoll]);
    globalThis.fetch = mockFetch as never;

    const client = new GitHubClient();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await client.waitForCheckRunsCompletion(
      'sha123',
      'owner/repo',
      [{ id: 7, priorStartedAt: null }],
      { sleep, pollIntervalMs: 10, timeoutMs: 60_000 },
    );

    expect(result).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });
});
