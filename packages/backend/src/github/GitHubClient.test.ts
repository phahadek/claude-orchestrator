import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing GitHubClient
vi.mock("../config.js", () => ({
  GITHUB_TOKEN: "ghp_test_token",
  GITHUB_REPO: "owner/test-repo",
  config: {},
}));

vi.mock("../db/queries.js", () => ({
  getPRByNumber: vi.fn().mockReturnValue(null),
}));

import { GitHubClient } from "./GitHubClient";
import { GitHubApiError } from "./types";
import { getPRByNumber } from "../db/queries";

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
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({}),
      text: async () => "",
      ...response,
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHubClient constructor", () => {
  it("does not throw when GITHUB_TOKEN and GITHUB_REPO are set", () => {
    expect(() => new GitHubClient()).not.toThrow();
  });
});

describe("GitHubClient.listOpenPRs()", () => {
  it("returns all open PRs including drafts, with draft flag preserved", async () => {
    const rawPRs = [
      {
        node_id: "PR_kwDOA1b2c3",
        number: 1,
        title: "Open PR",
        body: null,
        html_url: "https://github.com/owner/repo/pull/1",
        url: "https://api.github.com/repos/owner/repo/pulls/1",
        head: { ref: "feature/a" },
        base: { ref: "main" },
        state: "open",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        draft: false,
      },
      {
        node_id: "PR_kwDOA1b2c4",
        number: 2,
        title: "Draft PR",
        body: null,
        html_url: "https://github.com/owner/repo/pull/2",
        url: "https://api.github.com/repos/owner/repo/pulls/2",
        head: { ref: "feature/b" },
        base: { ref: "main" },
        state: "open",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
        draft: true,
      },
    ];

    mockFetch({
      ok: true,
      headers: { get: () => "application/json" } as unknown as Headers,
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

describe("GitHubClient.fetchDiff()", () => {
  it("correctly parses filesChanged from a unified diff", async () => {
    mockFetch({
      ok: true,
      headers: { get: () => "text/plain" } as unknown as Headers,
      text: async () => SAMPLE_DIFF,
    } as unknown as Response);

    const client = new GitHubClient();
    const result = await client.fetchDiff(42);

    expect(result.prId).toBe(42);
    expect(result.diff).toBe(SAMPLE_DIFF);
    expect(result.filesChanged).toEqual(["src/foo.ts", "src/bar.ts"]);
  });
});

describe("GitHubClient.markPRReady()", () => {
  it("sends GraphQL mutation to https://api.github.com/graphql with node_id from DB", async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      id: 1,
      pr_number: 42,
      pr_url: "https://github.com/owner/repo/pull/42",
      node_id: "PR_kwDOA1b2c3",
      notion_task_id: null,
      session_id: null,
      repo: "owner/repo",
      title: null,
      body: null,
      head_branch: null,
      base_branch: null,
      state: "open",
      draft: 1,
      review_result: null,
      review_at: null,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      synced_at: "2024-01-01T00:00:00Z",
      review_session_id: null,
      review_iteration: 0,
      head_sha: null,
      last_reviewed_sha: null,
    });

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({
        data: {
          markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
        },
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = new GitHubClient();
    await client.markPRReady("owner/repo", 42);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/graphql");
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body as string) as {
      query: string;
      variables: { pullRequestId: string };
    };
    expect(body.query).toContain("markPullRequestReadyForReview");
    expect(body.variables.pullRequestId).toBe("PR_kwDOA1b2c3");
  });

  it("falls back to REST fetch when node_id not in DB, then calls GraphQL", async () => {
    vi.mocked(getPRByNumber).mockReturnValue(null);

    const fetchSpy = vi
      .fn()
      // First call: REST fetch to get PR (for node_id)
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({
          node_id: "PR_kwDOA1b2c9",
          number: 42,
          title: "Test",
          body: null,
          html_url: "https://github.com/owner/repo/pull/42",
          url: "https://api.github.com/repos/owner/repo/pulls/42",
          head: { ref: "feature/x" },
          base: { ref: "dev" },
          state: "open",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          draft: true,
        }),
        text: async () => "",
      })
      // Second call: GraphQL mutation
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({
          data: {
            markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
          },
        }),
        text: async () => "",
      });
    vi.stubGlobal("fetch", fetchSpy);

    const client = new GitHubClient();
    await client.markPRReady("owner/repo", 42);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [graphqlUrl, graphqlOptions] = fetchSpy.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(graphqlUrl).toBe("https://api.github.com/graphql");
    const body = JSON.parse(graphqlOptions.body as string) as {
      variables: { pullRequestId: string };
    };
    expect(body.variables.pullRequestId).toBe("PR_kwDOA1b2c9");
  });

  it("throws GitHubApiError when GraphQL returns errors", async () => {
    vi.mocked(getPRByNumber).mockReturnValue({
      id: 1,
      pr_number: 42,
      pr_url: "https://github.com/owner/repo/pull/42",
      node_id: "PR_kwDOA1b2c3",
      notion_task_id: null,
      session_id: null,
      repo: "owner/repo",
      title: null,
      body: null,
      head_branch: null,
      base_branch: null,
      state: "open",
      draft: 1,
      review_result: null,
      review_at: null,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      synced_at: "2024-01-01T00:00:00Z",
      review_session_id: null,
      review_iteration: 0,
      head_sha: null,
      last_reviewed_sha: null,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({
          errors: [{ message: "PR not found" }, { message: "Unauthorized" }],
        }),
        text: async () => "",
      }),
    );

    const client = new GitHubClient();
    await expect(client.markPRReady("owner/repo", 42)).rejects.toThrow(
      GitHubApiError,
    );
    await expect(client.markPRReady("owner/repo", 42)).rejects.toMatchObject({
      status: 422,
      message: "PR not found; Unauthorized",
    });
  });
});

describe("GitHubClient mapPR — node_id", () => {
  it("maps node_id from raw PR to nodeId on PullRequest", async () => {
    mockFetch({
      ok: true,
      headers: { get: () => "application/json" } as unknown as Headers,
      json: async () => [
        {
          node_id: "PR_kwDOTestNodeId",
          number: 5,
          title: "Test PR",
          body: null,
          html_url: "https://github.com/owner/repo/pull/5",
          url: "https://api.github.com/repos/owner/repo/pulls/5",
          head: { ref: "feature/test" },
          base: { ref: "main" },
          state: "open",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
          draft: false,
        },
      ],
    } as unknown as Response);

    const client = new GitHubClient();
    const prs = await client.listOpenPRs("owner/repo");
    expect(prs[0].nodeId).toBe("PR_kwDOTestNodeId");
  });
});

describe("GitHubClient request error handling", () => {
  it("throws GitHubApiError with correct status when response.ok is false", async () => {
    mockFetch({
      ok: false,
      status: 404,
      headers: { get: () => "application/json" } as unknown as Headers,
      text: async () => "Not Found",
    } as unknown as Response);

    const client = new GitHubClient();
    await expect(client.listOpenPRs()).rejects.toThrow(GitHubApiError);
    await expect(client.listOpenPRs()).rejects.toMatchObject({ status: 404 });
  });

  it("throws GitHubApiError with status 405 for non-mergeable PR", async () => {
    mockFetch({
      ok: false,
      status: 405,
      headers: { get: () => "application/json" } as unknown as Headers,
      text: async () => "Method Not Allowed",
    } as unknown as Response);

    const client = new GitHubClient();
    await expect(client.mergePR(1, "squash commit")).rejects.toThrow(
      GitHubApiError,
    );
    await expect(client.mergePR(1, "squash commit")).rejects.toMatchObject({
      status: 405,
    });
  });
});
