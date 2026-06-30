import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  GITHUB_TOKEN: 'ghp_test_token',
  GITHUB_REPO: 'owner/test-repo',
  config: {},
}));

vi.mock('../../db/queries.js', () => ({
  getPRByNumber: vi.fn().mockReturnValue(null),
}));

import { GitHubClient } from '../GitHubClient';
import { GitHubApiError } from '../types';

beforeEach(() => {
  vi.unstubAllGlobals();
});

function makeGraphqlFetch(responseBody: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 422,
    headers: { get: () => 'application/json' },
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  });
}

// ── addPullRequestReviewThreadReply ──────────────────────────────────────────

describe('GitHubClient.addPullRequestReviewThreadReply()', () => {
  it('sends GraphQL mutation to /graphql with threadId and body', async () => {
    const fetchSpy = makeGraphqlFetch({
      data: {
        addPullRequestReviewThreadReply: { comment: { id: 'RC_kwDO123' } },
      },
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await client.addPullRequestReviewThreadReply(
      'PRRT_kwDOAbc',
      'Addressed in latest commit.',
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/graphql');
    expect(opts.method).toBe('POST');
    const reqBody = JSON.parse(opts.body as string) as {
      query: string;
      variables: { threadId: string; body: string };
    };
    expect(reqBody.query).toContain('addPullRequestReviewThreadReply');
    expect(reqBody.variables.threadId).toBe('PRRT_kwDOAbc');
    expect(reqBody.variables.body).toBe('Addressed in latest commit.');
  });

  it('throws GitHubApiError when response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => 'application/json' },
        text: async () => 'Unauthorized',
      }),
    );

    const client = new GitHubClient();
    await expect(
      client.addPullRequestReviewThreadReply('PRRT_kwDOAbc', 'reply'),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('throws GitHubApiError when GraphQL returns errors', async () => {
    const fetchSpy = makeGraphqlFetch({
      errors: [{ message: 'Thread not found' }],
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await expect(
      client.addPullRequestReviewThreadReply('PRRT_bad', 'reply'),
    ).rejects.toMatchObject({ status: 422 });
  });
});

// ── resolveReviewThread ──────────────────────────────────────────────────────

describe('GitHubClient.resolveReviewThread()', () => {
  it('sends resolveReviewThread mutation with threadId', async () => {
    const fetchSpy = makeGraphqlFetch({
      data: { resolveReviewThread: { thread: { isResolved: true } } },
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await client.resolveReviewThread('PRRT_kwDOAbc');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/graphql');
    const reqBody = JSON.parse(opts.body as string) as {
      query: string;
      variables: { threadId: string };
    };
    expect(reqBody.query).toContain('resolveReviewThread');
    expect(reqBody.variables.threadId).toBe('PRRT_kwDOAbc');
  });

  it('throws GitHubApiError when response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers: { get: () => 'application/json' },
        text: async () => 'Forbidden',
      }),
    );

    const client = new GitHubClient();
    await expect(
      client.resolveReviewThread('PRRT_kwDOAbc'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('throws GitHubApiError when GraphQL returns errors', async () => {
    const fetchSpy = makeGraphqlFetch({
      errors: [{ message: 'Cannot resolve' }, { message: 'Already resolved' }],
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await expect(client.resolveReviewThread('PRRT_bad')).rejects.toMatchObject({
      status: 422,
    });
    await expect(client.resolveReviewThread('PRRT_bad')).rejects.toThrow(
      'Cannot resolve; Already resolved',
    );
  });
});

// ── getReviewThreads / findThreadByCommentId ─────────────────────────────────

describe('GitHubClient.getReviewThreads()', () => {
  const THREADS_RESPONSE = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'PRRT_thread1',
                isResolved: false,
                comments: { nodes: [{ databaseId: 101 }, { databaseId: 102 }] },
              },
              {
                id: 'PRRT_thread2',
                isResolved: true,
                comments: { nodes: [{ databaseId: 200 }] },
              },
            ],
          },
        },
      },
    },
  };

  it('sends reviewThreads query and maps threads to ReviewThread shape', async () => {
    const fetchSpy = makeGraphqlFetch(THREADS_RESPONSE);
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    const threads = await client.getReviewThreads(42, 'owner/repo');

    expect(threads).toHaveLength(2);
    expect(threads[0]).toEqual({
      id: 'PRRT_thread1',
      isResolved: false,
      commentDatabaseIds: [101, 102],
    });
    expect(threads[1]).toEqual({
      id: 'PRRT_thread2',
      isResolved: true,
      commentDatabaseIds: [200],
    });
  });

  it('sends query with correct owner/name/number variables', async () => {
    const fetchSpy = makeGraphqlFetch(THREADS_RESPONSE);
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await client.getReviewThreads(7, 'myorg/myrepo');

    const reqBody = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as {
      query: string;
      variables: { owner: string; name: string; number: number };
    };

    expect(reqBody.variables.owner).toBe('myorg');
    expect(reqBody.variables.name).toBe('myrepo');
    expect(reqBody.variables.number).toBe(7);
    expect(reqBody.query).toContain('reviewThreads');
  });

  it('returns empty array when pullRequest has no threads', async () => {
    const fetchSpy = makeGraphqlFetch({
      data: {
        repository: {
          pullRequest: { reviewThreads: { nodes: [] } },
        },
      },
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    const threads = await client.getReviewThreads(1, 'owner/repo');
    expect(threads).toEqual([]);
  });

  it('throws GitHubApiError on HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => 'application/json' },
        text: async () => 'Internal Server Error',
      }),
    );

    const client = new GitHubClient();
    await expect(
      client.getReviewThreads(1, 'owner/repo'),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('throws GitHubApiError when GraphQL errors present', async () => {
    const fetchSpy = makeGraphqlFetch({
      errors: [{ message: 'not found' }],
    });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new GitHubClient();
    await expect(
      client.getReviewThreads(1, 'owner/repo'),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});

describe('GitHubClient.findThreadByCommentId()', () => {
  const THREADS_RESPONSE = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'PRRT_thread1',
                isResolved: false,
                comments: { nodes: [{ databaseId: 101 }, { databaseId: 102 }] },
              },
              {
                id: 'PRRT_thread2',
                isResolved: true,
                comments: { nodes: [{ databaseId: 200 }] },
              },
            ],
          },
        },
      },
    },
  };

  it('returns the thread node-id for a known comment_id', async () => {
    vi.stubGlobal('fetch', makeGraphqlFetch(THREADS_RESPONSE));

    const client = new GitHubClient();
    const threadId = await client.findThreadByCommentId(102, 42, 'owner/repo');
    expect(threadId).toBe('PRRT_thread1');
  });

  it('returns the correct thread for a comment in the second thread', async () => {
    vi.stubGlobal('fetch', makeGraphqlFetch(THREADS_RESPONSE));

    const client = new GitHubClient();
    const threadId = await client.findThreadByCommentId(200, 42, 'owner/repo');
    expect(threadId).toBe('PRRT_thread2');
  });

  it('returns null when comment_id is not found in any thread', async () => {
    vi.stubGlobal('fetch', makeGraphqlFetch(THREADS_RESPONSE));

    const client = new GitHubClient();
    const threadId = await client.findThreadByCommentId(999, 42, 'owner/repo');
    expect(threadId).toBeNull();
  });
});
