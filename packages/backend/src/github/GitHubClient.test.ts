import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing GitHubClient
vi.mock('../config.js', () => ({
  GITHUB_TOKEN: 'ghp_test_token',
  GITHUB_REPO: 'owner/test-repo',
  config: {},
}));

import { GitHubClient } from './GitHubClient.js';
import { GitHubApiError } from './types.js';

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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => ({}),
    text: async () => '',
    ...response,
  }));
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
  it('filters out draft PRs from the response', async () => {
    const rawPRs = [
      {
        number: 1, title: 'Open PR', body: null, html_url: 'https://github.com/owner/repo/pull/1',
        url: 'https://api.github.com/repos/owner/repo/pulls/1',
        head: { ref: 'feature/a' }, base: { ref: 'main' },
        state: 'open', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z',
        draft: false,
      },
      {
        number: 2, title: 'Draft PR', body: null, html_url: 'https://github.com/owner/repo/pull/2',
        url: 'https://api.github.com/repos/owner/repo/pulls/2',
        head: { ref: 'feature/b' }, base: { ref: 'main' },
        state: 'open', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z',
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

    expect(prs).toHaveLength(1);
    expect(prs[0].id).toBe(1);
    expect(prs[0].draft).toBe(false);
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
    await expect(client.mergePR(1, 'squash commit')).rejects.toThrow(GitHubApiError);
    await expect(client.mergePR(1, 'squash commit')).rejects.toMatchObject({ status: 405 });
  });
});
