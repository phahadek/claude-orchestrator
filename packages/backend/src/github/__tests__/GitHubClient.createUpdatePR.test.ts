import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../config', () => ({
  GITHUB_TOKEN: 'test-token',
  GITHUB_REPO: 'owner/repo',
}));

vi.mock('../../db/queries', () => ({
  getPRByNumber: vi.fn().mockReturnValue(null),
}));

import { GitHubClient } from '../GitHubClient';

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const CREATED_PR = {
  number: 99,
  html_url: 'https://github.com/owner/repo/pull/99',
  title: 'feat: my-task',
  body: '## Summary\nfoo\n\n## Notion Task\nlink\n\n## Automated Tests\nnone\n\n## Files Changed\n- file.ts',
  head: { ref: 'feature/my-task', sha: 'abc123' },
  base: { ref: 'dev' },
  state: 'open',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  draft: true,
};

describe('GitHubClient.createPR', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs to /repos/{repo}/pulls with correct payload', async () => {
    const mockFetch = makeFetch(201, CREATED_PR);
    globalThis.fetch = mockFetch as never;

    const client = new GitHubClient();
    const result = await client.createPR('owner/repo', {
      title: 'feat: my-task',
      body: 'the body',
      head: 'feature/my-task',
      base: 'dev',
      draft: true,
    });

    expect(result.number).toBe(99);
    expect(result.html_url).toBe('https://github.com/owner/repo/pull/99');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/pulls',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: 'feat: my-task',
          body: 'the body',
          head: 'feature/my-task',
          base: 'dev',
          draft: true,
        }),
      }),
    );
  });

  it('defaults draft to true when not specified', async () => {
    const mockFetch = makeFetch(201, CREATED_PR);
    globalThis.fetch = mockFetch as never;

    const client = new GitHubClient();
    await client.createPR('owner/repo', {
      title: 'feat: t',
      body: 'b',
      head: 'feature/t',
      base: 'dev',
    });

    const sentBody = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.draft).toBe(true);
  });

  it('throws GitHubApiError on non-ok response', async () => {
    globalThis.fetch = makeFetch(422, {
      message: 'Validation Failed',
    }) as never;

    const client = new GitHubClient();
    await expect(
      client.createPR('owner/repo', {
        title: 'feat: t',
        body: 'b',
        head: 'feature/t',
        base: 'dev',
      }),
    ).rejects.toThrow();
  });
});

describe('GitHubClient.updatePR', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('PATCHes to /repos/{repo}/pulls/{number} with body patch', async () => {
    const mockFetch = makeFetch(200, { ...CREATED_PR, body: 'updated body' });
    globalThis.fetch = mockFetch as never;

    const client = new GitHubClient();
    const result = await client.updatePR('owner/repo', 99, {
      body: 'updated body',
    });

    expect(result.number).toBe(99);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/pulls/99',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ body: 'updated body' }),
      }),
    );
  });

  it('supports updating title alongside body', async () => {
    const mockFetch = makeFetch(200, CREATED_PR);
    globalThis.fetch = mockFetch as never;

    const client = new GitHubClient();
    await client.updatePR('owner/repo', 99, {
      title: 'feat: new-name',
      body: 'new body',
    });

    const sentBody = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.title).toBe('feat: new-name');
    expect(sentBody.body).toBe('new body');
  });
});
