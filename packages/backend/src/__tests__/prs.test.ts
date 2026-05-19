import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../routes/tasks.js", () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock("../db/queries.js", () => ({
  getPRs: vi.fn(),
  getPRByNumber: vi.fn(),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  getTaskTitleFromCache: vi.fn().mockReturnValue(null),
  upsertPullRequest: vi.fn(),
  deletePR: vi.fn(),
  deleteMergedAndClosedPRs: vi.fn(),
  countMergedAndClosedPRs: vi.fn().mockReturnValue(0),
  resetReviewIteration: vi.fn(),
  setPRReviewResult: vi.fn(),
  updatePRDraftStatus: vi.fn(),
}));

const mockProjectsByGithubRepo: Record<
  string,
  {
    id: string;
    name: string;
    projectDir: string;
    contextUrl: string;
    boardId: string;
    githubRepo: string;
  }
> = {
  "owner/repo": {
    id: "proj-1",
    name: "Test Project",
    projectDir: "/test",
    contextUrl: "https://notion.so/ctx",
    boardId: "board-1",
    githubRepo: "owner/repo",
  },
};

vi.mock("../config.js", () => ({
  getProjectById: vi.fn((id: string) => {
    if (id === "proj-1") {
      return {
        id: "proj-1",
        name: "Test Project",
        projectDir: "/test",
        contextUrl: "https://notion.so/ctx",
        boardId: "board-1",
        githubRepo: "owner/repo",
      };
    }
    if (id === "proj-no-repo") {
      return {
        id: "proj-no-repo",
        name: "No Repo Project",
        projectDir: "/test2",
        contextUrl: "https://notion.so/ctx2",
        boardId: "board-2",
      };
    }
    return undefined;
  }),
  getProjectByGithubRepo: vi.fn(
    (repo: string) => mockProjectsByGithubRepo[repo],
  ),
  getAllProjects: vi.fn(() => Object.values(mockProjectsByGithubRepo)),
}));

import { createPrsRouter, setPRBroadcast } from "../routes/prs.js";
import * as queries from "../db/queries.js";
import * as tasksRoute from "../routes/tasks.js";
import type { PullRequest } from "../github/types.js";
import { GitHubApiError } from "../github/types.js";
import type { GitHubClient } from "../github/GitHubClient.js";
import type { PRReviewService } from "../github/PRReviewService.js";
import type { SessionManager } from "../session/SessionManager.js";
import type { NotionClient } from "../notion/NotionClient.js";
import type { PullRequestRow } from "../db/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const mockPRRow: PullRequestRow = {
  id: 1,
  pr_number: 42,
  pr_url: "https://github.com/owner/repo/pull/42",
  notion_task_id: "notion-task-abc",
  session_id: "session-xyz",
  repo: "owner/repo",
  title: "feat: add something",
  body: null,
  head_branch: "feature/add-something",
  base_branch: "dev",
  state: "open",
  draft: 0,
  review_result: null,
  review_at: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T01:00:00Z",
  synced_at: "2024-01-01T01:00:00Z",
  review_session_id: null,
  review_iteration: 0,
  head_sha: null,
  last_reviewed_sha: null,
  node_id: null,
  mergeable: null,
  merge_state: null,
  merge_state_checked_at: null,
  pending_push: 0,
};

const mockPRRowNoTask: PullRequestRow = {
  ...mockPRRow,
  id: 2,
  pr_number: 43,
  notion_task_id: null,
  session_id: null,
};

const openGitHubPR: PullRequest = {
  id: 1,
  title: "PR title",
  body: null,
  url: "https://github.com/owner/repo/pull/1",
  apiUrl: "https://api.github.com/repos/owner/repo/pulls/1",
  headBranch: "feature/foo",
  baseBranch: "dev",
  state: "open",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  mergeableState: "clean",
  draft: false,
};

const mockGitHubPR = {
  id: 42,
  title: "feat: add something",
  body: null,
  url: "https://github.com/owner/repo/pull/42",
  apiUrl: "https://api.github.com/repos/owner/repo/pulls/42",
  headBranch: "feature/add-something",
  baseBranch: "dev",
  state: "open" as const,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T01:00:00Z",
  mergeableState: "clean",
  draft: false,
};

function makeMockGitHub(): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue([]),
    getPRState: vi.fn().mockResolvedValue("merged"),
    fetchDiff: vi.fn(),
    fetchPR: vi.fn().mockResolvedValue(mockGitHubPR),
    mergePR: vi
      .fn()
      .mockResolvedValue({ merged: true, message: "Merged", sha: "abc123" }),
    markPRReady: vi.fn().mockResolvedValue(undefined),
    getMergeability: vi
      .fn()
      .mockResolvedValue({ mergeable: true, mergeableState: "clean" }),
    getMergeabilityWithRetry: vi
      .fn()
      .mockResolvedValue({ mergeable: true, mergeableState: "clean" }),
  } as unknown as GitHubClient;
}

function makeMockPRReviewService(): PRReviewService {
  return {
    reviewPR: vi.fn().mockResolvedValue({
      prNumber: 42,
      repo: "owner/repo",
      verdict: "approved",
      dimensions: [],
      summary: "Looks good",
      reviewedAt: new Date().toISOString(),
    }),
  } as unknown as PRReviewService;
}

function makeMockSessionManager(): SessionManager {
  return {
    sendOrResume: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
  } as unknown as SessionManager;
}

function makeMockNotionClient(): NotionClient {
  return {
    updateStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotionClient;
}

function buildApp(
  github = makeMockGitHub(),
  prReviewService = makeMockPRReviewService(),
  sessionManager = makeMockSessionManager(),
  notionClient = makeMockNotionClient(),
) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createPrsRouter(github, prReviewService, sessionManager, notionClient),
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── GET /api/prs ──────────────────────────────────────────────────────────────

describe("GET /api/prs", () => {
  it("returns 200 with an array when no PRs in DB", async () => {
    vi.mocked(queries.getPRs).mockReturnValue([]);
    const res = await supertest(buildApp()).get("/api/prs?projectId=proj-1");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("returns mapped PR items including notionTaskTitle from cache", async () => {
    vi.mocked(queries.getPRs).mockReturnValue([mockPRRow]);
    vi.mocked(queries.getTaskTitleFromCache).mockReturnValue("My Task Title");
    const res = await supertest(buildApp()).get("/api/prs?projectId=proj-1");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].prNumber).toBe(42);
    expect(res.body[0].notionTaskTitle).toBe("My Task Title");
  });

  it("returns PRs with all states (open, merged, closed), not just open", async () => {
    const mergedRow: PullRequestRow = {
      ...mockPRRow,
      pr_number: 50,
      state: "merged",
    };
    const closedRow: PullRequestRow = {
      ...mockPRRow,
      pr_number: 51,
      state: "closed",
    };
    vi.mocked(queries.getPRs).mockReturnValue([
      mockPRRow,
      mergedRow,
      closedRow,
    ]);
    const github = makeMockGitHub();
    // PR 42 is still open on GitHub — no reconciliation should occur for it
    vi.mocked(github.listOpenPRs).mockResolvedValue([
      { ...openGitHubPR, id: 42 },
    ]);
    const res = await supertest(buildApp(github)).get(
      "/api/prs?projectId=proj-1",
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((p: { state: string }) => p.state)).toEqual([
      "open",
      "merged",
      "closed",
    ]);
  });

  it("updates local state to merged when GitHub no longer lists the PR as open", async () => {
    const staleRow: PullRequestRow = {
      ...mockPRRow,
      pr_number: 99,
      state: "open",
    };
    vi.mocked(queries.getPRs).mockReturnValue([staleRow]);
    const github = makeMockGitHub();
    // GitHub returns no open PRs → PR 99 is stale
    vi.mocked(github.listOpenPRs).mockResolvedValue([]);
    vi.mocked(github.getPRState).mockResolvedValue("merged");

    const res = await supertest(buildApp(github)).get(
      "/api/prs?projectId=proj-1",
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(queries.updatePRState)).toHaveBeenCalledWith(
      99,
      "owner/repo",
      "merged",
    );
    expect(res.body[0].state).toBe("merged");
  });

  it("returns 400 when projectId is missing", async () => {
    const res = await supertest(buildApp()).get("/api/prs");
    expect(res.status).toBe(400);
  });

  it("returns 422 when project has no githubRepo", async () => {
    const res = await supertest(buildApp()).get(
      "/api/prs?projectId=proj-no-repo",
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/githubRepo/);
  });
});

// ── POST /api/prs/:prNumber/review ────────────────────────────────────────────

describe("POST /api/prs/:prNumber/review", () => {
  it("calls reviewPR and returns review result when PR exists", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const res = await supertest(buildApp()).post(
      "/api/prs/42/review?projectId=proj-1",
    );
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("approved");
    expect(res.body.summary).toBe("Looks good");
  });

  it("calls reviewPR even when PR has no notion_task_id (service handles error)", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRowNoTask);
    const res = await supertest(buildApp()).post(
      "/api/prs/43/review?projectId=proj-1",
    );
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("approved");
  });

  it("performs on-demand sync and calls reviewPR when PR is not in DB initially", async () => {
    vi.mocked(queries.getPRByNumber)
      .mockReturnValueOnce(null) // first call — not found
      .mockReturnValueOnce(mockPRRow); // second call — after upsert
    const github = makeMockGitHub();
    const res = await supertest(buildApp(github)).post(
      "/api/prs/42/review?projectId=proj-1",
    );
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("approved");
    expect(vi.mocked(github.fetchPR)).toHaveBeenCalledWith("owner/repo", 42);
    expect(vi.mocked(queries.upsertPullRequest)).toHaveBeenCalledOnce();
  });

  it("returns 404 when PR is not in DB and GitHub fetch also fails", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(null);
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR).mockRejectedValue(new Error("Not Found"));
    const res = await supertest(buildApp(github)).post(
      "/api/prs/42/review?projectId=proj-1",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/PR #42 not found/);
  });

  it("returns 404 when PR is not in DB and still not found after upsert", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(null);
    const res = await supertest(buildApp()).post(
      "/api/prs/42/review?projectId=proj-1",
    );
    expect(res.status).toBe(404);
  });

  it("broadcasts pr_review_complete after a successful review", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const broadcastedMessages: object[] = [];
    setPRBroadcast((msg) => broadcastedMessages.push(msg));

    await supertest(buildApp()).post("/api/prs/42/review?projectId=proj-1");

    expect(broadcastedMessages).toHaveLength(1);
    expect(broadcastedMessages[0]).toMatchObject({
      type: "pr_review_complete",
      prNumber: 42,
      repo: "owner/repo",
      verdict: "approved",
      summary: "Looks good",
    });

    // Reset broadcast to no-op
    setPRBroadcast(() => {});
  });
});

// ── POST /api/prs/:prNumber/merge ─────────────────────────────────────────────

describe("POST /api/prs/:prNumber/merge", () => {
  it("returns 422 with conflict message on 405 GitHubApiError", async () => {
    const github = makeMockGitHub();
    vi.mocked(github.mergePR).mockRejectedValue(
      new GitHubApiError(405, "Not mergeable"),
    );
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const res = await supertest(buildApp(github))
      .post("/api/prs/owner/repo/42/merge")
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toBe(
      "PR has merge conflicts. Use Fix Conflicts to have the code session rebase and resolve them.",
    );
  });

  it("calls sendOrResume with conflict-fix message on 409 merge conflict", async () => {
    const github = makeMockGitHub();
    vi.mocked(github.mergePR).mockRejectedValue(
      new GitHubApiError(409, "Merge conflict"),
    );
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const sessionManager = makeMockSessionManager();
    const res = await supertest(
      buildApp(github, makeMockPRReviewService(), sessionManager),
    )
      .post("/api/prs/owner/repo/42/merge")
      .send({});
    expect(res.status).toBe(422);
    expect(vi.mocked(sessionManager.sendOrResume)).toHaveBeenCalledWith(
      "session-xyz",
      "PR #42 has merge conflicts with the base branch. Rebase onto `dev`, resolve the conflicts, and push the fixed branch.",
    );
  });

  it("returns merge result and updates state on success", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const res = await supertest(buildApp())
      .post("/api/prs/owner/repo/42/merge")
      .send({ commitTitle: "feat: add something (#42)" });
    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(true);
    expect(vi.mocked(queries.updatePRState)).toHaveBeenCalledWith(
      42,
      "owner/repo",
      "merged",
    );
  });

  it("ends coding session and review session gracefully on merge", async () => {
    const prWithSessions: PullRequestRow = {
      ...mockPRRow,
      session_id: "coding-session-id",
      review_session_id: "review-session-id",
    };
    vi.mocked(queries.getPRByNumber).mockReturnValue(prWithSessions);
    const sessionManager = makeMockSessionManager();
    const res = await supertest(
      buildApp(makeMockGitHub(), makeMockPRReviewService(), sessionManager),
    )
      .post("/api/prs/owner/repo/42/merge")
      .send({});
    expect(res.status).toBe(200);
    expect(vi.mocked(sessionManager.endSession)).toHaveBeenCalledWith(
      "coding-session-id",
    );
    expect(vi.mocked(sessionManager.endSession)).toHaveBeenCalledWith(
      "review-session-id",
    );
  });

  it("calls NotionClient.updateStatus with Done on merge", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const notionClient = makeMockNotionClient();
    const res = await supertest(
      buildApp(
        makeMockGitHub(),
        makeMockPRReviewService(),
        makeMockSessionManager(),
        notionClient,
      ),
    )
      .post("/api/prs/owner/repo/42/merge")
      .send({});
    expect(res.status).toBe(200);
    expect(vi.mocked(notionClient.updateStatus)).toHaveBeenCalledWith(
      "notion-task-abc",
      "✅ Done",
    );
  });

  it("calls emitTaskUpdated after successful Notion update on merge", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const notionClient = makeMockNotionClient();
    const res = await supertest(
      buildApp(
        makeMockGitHub(),
        makeMockPRReviewService(),
        makeMockSessionManager(),
        notionClient,
      ),
    )
      .post("/api/prs/owner/repo/42/merge")
      .send({});
    expect(res.status).toBe(200);
    expect(vi.mocked(tasksRoute.emitTaskUpdated)).toHaveBeenCalledWith(
      "notion-task-abc",
    );
  });

  it("broadcasts task_status_changed after successful Notion update on merge", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const broadcastedMessages: object[] = [];
    setPRBroadcast((msg) => broadcastedMessages.push(msg));

    await supertest(buildApp()).post("/api/prs/owner/repo/42/merge").send({});

    expect(broadcastedMessages).toContainEqual({
      type: "task_status_changed",
      notionTaskId: "notion-task-abc",
      newStatus: "✅ Done",
    });

    setPRBroadcast(() => {});
  });

  it("does NOT call emitTaskUpdated when PR has no notion_task_id", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRowNoTask);
    const res = await supertest(buildApp())
      .post("/api/prs/owner/repo/43/merge")
      .send({});
    expect(res.status).toBe(200);
    expect(vi.mocked(tasksRoute.emitTaskUpdated)).not.toHaveBeenCalled();
  });

  it("broadcasts task_status_changed and calls emitTaskUpdated before res.json() resolves", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);

    const callOrder: string[] = [];

    const notionClient = makeMockNotionClient();
    vi.mocked(notionClient.updateStatus).mockImplementation(async () => {
      callOrder.push("updateStatus");
    });

    setPRBroadcast((msg) => {
      callOrder.push(`broadcast:${(msg as { type: string }).type}`);
    });

    vi.mocked(tasksRoute.emitTaskUpdated).mockImplementation(() => {
      callOrder.push("emitTaskUpdated");
    });

    const res = await supertest(
      buildApp(
        makeMockGitHub(),
        makeMockPRReviewService(),
        makeMockSessionManager(),
        notionClient,
      ),
    )
      .post("/api/prs/owner/repo/42/merge")
      .send({});

    // push after supertest resolves — by this point res.json() has already fired
    callOrder.push("response");

    expect(res.status).toBe(200);

    const taskStatusIdx = callOrder.indexOf("broadcast:task_status_changed");
    const emitIdx = callOrder.indexOf("emitTaskUpdated");
    const responseIdx = callOrder.indexOf("response");

    expect(taskStatusIdx).toBeGreaterThanOrEqual(0);
    expect(emitIdx).toBeGreaterThanOrEqual(0);
    expect(taskStatusIdx).toBeLessThan(responseIdx);
    expect(emitIdx).toBeLessThan(responseIdx);

    setPRBroadcast(() => {});
  });
});

// ── POST /api/prs/:prNumber/re-review ─────────────────────────────────────────

describe("POST /api/prs/:prNumber/re-review", () => {
  it("returns 404 when PR not found", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(null);
    const res = await supertest(buildApp()).post(
      "/api/prs/owner/repo/42/re-review",
    );
    expect(res.status).toBe(404);
  });

  it("resets review_iteration and runs review on success", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const res = await supertest(buildApp()).post(
      "/api/prs/owner/repo/42/re-review",
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(queries.resetReviewIteration)).toHaveBeenCalledWith(
      42,
      "owner/repo",
    );
  });

  it("returns 422 when repo not in config", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const res = await supertest(buildApp()).post(
      "/api/prs/unknown/norepo/42/re-review",
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/No project configured/);
  });

  it("broadcasts pr_review_complete after a successful re-review", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const broadcastedMessages: object[] = [];
    setPRBroadcast((msg) => broadcastedMessages.push(msg));

    await supertest(buildApp()).post("/api/prs/owner/repo/42/re-review");

    expect(broadcastedMessages).toHaveLength(1);
    expect(broadcastedMessages[0]).toMatchObject({
      type: "pr_review_complete",
      prNumber: 42,
      repo: "owner/repo",
      verdict: "approved",
      summary: "Looks good",
    });

    // Reset broadcast to no-op
    setPRBroadcast(() => {});
  });
});

// ── DELETE /api/prs/:prNumber ──────────────────────────────────────────────────

describe("DELETE /api/prs/:prNumber", () => {
  it("returns 200 and calls deletePR when PR exists", async () => {
    vi.mocked(queries.deletePR).mockReturnValue(true);
    const res = await supertest(buildApp()).delete(
      "/api/prs/42?projectId=proj-1",
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(vi.mocked(queries.deletePR)).toHaveBeenCalledWith(42, "owner/repo");
  });

  it("returns 404 when PR does not exist", async () => {
    vi.mocked(queries.deletePR).mockReturnValue(false);
    const res = await supertest(buildApp()).delete(
      "/api/prs/99?projectId=proj-1",
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when projectId is missing", async () => {
    const res = await supertest(buildApp()).delete("/api/prs/42");
    expect(res.status).toBe(400);
  });
});

// ── DELETE /api/prs/clear ─────────────────────────────────────────────────────

describe("DELETE /api/prs/clear", () => {
  it("returns deleted count", async () => {
    vi.mocked(queries.deleteMergedAndClosedPRs).mockReturnValue(3);
    const res = await supertest(buildApp()).delete(
      "/api/prs/clear?projectId=proj-1",
    );
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(3);
    expect(vi.mocked(queries.deleteMergedAndClosedPRs)).toHaveBeenCalledWith(
      "owner/repo",
    );
  });

  it("returns 400 when projectId is missing", async () => {
    const res = await supertest(buildApp()).delete("/api/prs/clear");
    expect(res.status).toBe(400);
  });
});

// ── GET /api/prs/clear/count ──────────────────────────────────────────────────

describe("GET /api/prs/clear/count", () => {
  it("returns count of merged/closed PRs", async () => {
    vi.mocked(queries.countMergedAndClosedPRs).mockReturnValue(2);
    const res = await supertest(buildApp()).get(
      "/api/prs/clear/count?projectId=proj-1",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

// ── POST /api/prs/:owner/:repo/:prNumber/approve ──────────────────────────────

describe("POST /api/prs/:owner/:repo/:prNumber/approve", () => {
  it("returns 200 and stores approved verdict when PR exists", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const res = await supertest(buildApp()).post(
      "/api/prs/owner/repo/42/approve",
    );
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("approved");
    expect(res.body.summary).toBe("Manually approved via dashboard");
    expect(vi.mocked(queries.setPRReviewResult)).toHaveBeenCalledWith(
      42,
      "owner/repo",
      expect.stringContaining('"verdict":"approved"'),
    );
  });

  it("returns 404 for unknown PR", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(null);
    const res = await supertest(buildApp()).post(
      "/api/prs/owner/repo/99/approve",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/PR #99 not found/);
  });

  it("calls markPRReady and updatePRDraftStatus when approving a draft PR", async () => {
    const draftPR: PullRequestRow = { ...mockPRRow, draft: 1 };
    vi.mocked(queries.getPRByNumber).mockReturnValue(draftPR);
    const github = makeMockGitHub();
    const res = await supertest(buildApp(github)).post(
      "/api/prs/owner/repo/42/approve",
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(github.markPRReady)).toHaveBeenCalledWith(
      "owner/repo",
      42,
    );
    expect(vi.mocked(queries.updatePRDraftStatus)).toHaveBeenCalledWith(
      42,
      "owner/repo",
      0,
    );
  });

  it("calls markPRReady unconditionally even when approving a non-draft PR (eliminates stale-field race)", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow); // draft: 0
    const github = makeMockGitHub();
    const res = await supertest(buildApp(github)).post(
      "/api/prs/owner/repo/42/approve",
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(github.markPRReady)).toHaveBeenCalledWith(
      "owner/repo",
      42,
    );
    expect(vi.mocked(queries.updatePRDraftStatus)).toHaveBeenCalledWith(
      42,
      "owner/repo",
      0,
    );
  });

  it("calls notionClient.updateStatus with In Review when PR has notion_task_id", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow); // notion_task_id: 'notion-task-abc'
    const notionClient = makeMockNotionClient();
    const res = await supertest(
      buildApp(
        makeMockGitHub(),
        makeMockPRReviewService(),
        makeMockSessionManager(),
        notionClient,
      ),
    ).post("/api/prs/owner/repo/42/approve");
    expect(res.status).toBe(200);
    expect(vi.mocked(notionClient.updateStatus)).toHaveBeenCalledWith(
      "notion-task-abc",
      "👀 In Review",
    );
  });

  it("does NOT call notionClient.updateStatus when PR has no notion_task_id", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRowNoTask); // notion_task_id: null
    const notionClient = makeMockNotionClient();
    const res = await supertest(
      buildApp(
        makeMockGitHub(),
        makeMockPRReviewService(),
        makeMockSessionManager(),
        notionClient,
      ),
    ).post("/api/prs/owner/repo/43/approve");
    expect(res.status).toBe(200);
    expect(vi.mocked(notionClient.updateStatus)).not.toHaveBeenCalled();
  });
});

// ── AC: Break 2 — review endpoint calls prReviewService.reviewPR() ──────────
// Required by task: Wire ReviewOrchestrator into server event flow
// Verifies the endpoint is NOT stubbed and delegates to prReviewService.reviewPR().

describe("Break 2 (AC) — POST /api/prs/:prNumber/review calls prReviewService.reviewPR()", () => {
  it("calls prReviewService.reviewPR() with correct args and returns real verdict, not stub null", async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const prReviewService = makeMockPRReviewService();
    const res = await supertest(
      buildApp(makeMockGitHub(), prReviewService),
    ).post("/api/prs/42/review?projectId=proj-1");
    expect(res.status).toBe(200);
    // Must invoke reviewPR — not return the old stub { verdict: null }
    expect(vi.mocked(prReviewService.reviewPR)).toHaveBeenCalledWith(
      42,
      "owner/repo",
      "proj-1",
      "https://notion.so/ctx",
    );
    expect(res.body.verdict).toBe("approved");
    expect(res.body.verdict).not.toBeNull();
    // Old stub message must be absent (response has no message field in current impl)
    expect(res.body.message ?? "").not.toMatch(/not yet implemented/i);
  });
});
