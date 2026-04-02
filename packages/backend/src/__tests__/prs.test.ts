import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getPRs: vi.fn(),
  getOpenPRs: vi.fn(),
  getPRByNumber: vi.fn(),
  updatePRState: vi.fn(),
  getTaskTitleFromCache: vi.fn().mockReturnValue(null),
  upsertPullRequest: vi.fn(),
  deletePR: vi.fn(),
  deleteMergedAndClosedPRs: vi.fn(),
  countMergedAndClosedPRs: vi.fn().mockReturnValue(0),
}));

vi.mock('../config.js', () => ({
  config: {
    projects: [
      {
        id: 'proj-1',
        name: 'Test Project',
        projectDir: '/test',
        contextUrl: 'https://notion.so/ctx',
        boardId: 'board-1',
        githubRepo: 'owner/repo',
      },
      {
        id: 'proj-no-repo',
        name: 'No Repo Project',
        projectDir: '/test2',
        contextUrl: 'https://notion.so/ctx2',
        boardId: 'board-2',
      },
    ],
  },
  getProjectById: vi.fn((id: string) => {
    if (id === 'proj-1') {
      return {
        id: 'proj-1',
        name: 'Test Project',
        projectDir: '/test',
        contextUrl: 'https://notion.so/ctx',
        boardId: 'board-1',
        githubRepo: 'owner/repo',
      };
    }
    if (id === 'proj-no-repo') {
      return {
        id: 'proj-no-repo',
        name: 'No Repo Project',
        projectDir: '/test2',
        contextUrl: 'https://notion.so/ctx2',
        boardId: 'board-2',
      };
    }
    return undefined;
  }),
}));

import { createPrsRouter } from '../routes/prs.js';
import * as queries from '../db/queries.js';
import type { PullRequest } from '../github/types.js';
import { GitHubApiError } from '../github/types.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { PRReviewService } from '../github/PRReviewService.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { PullRequestRow } from '../db/types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const mockPRRow: PullRequestRow = {
  id: 1,
  pr_number: 42,
  pr_url: 'https://github.com/owner/repo/pull/42',
  notion_task_id: 'notion-task-abc',
  session_id: 'session-xyz',
  repo: 'owner/repo',
  title: 'feat: add something',
  body: null,
  head_branch: 'feature/add-something',
  base_branch: 'dev',
  state: 'open',
  review_result: null,
  review_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T01:00:00Z',
  synced_at: '2024-01-01T01:00:00Z',
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
  title: 'PR title',
  body: null,
  url: 'https://github.com/owner/repo/pull/1',
  apiUrl: 'https://api.github.com/repos/owner/repo/pulls/1',
  headBranch: 'feature/foo',
  baseBranch: 'dev',
  state: 'open',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  mergeableState: 'clean',
  draft: false,
};

const mockGitHubPR = {
  id: 42,
  title: 'feat: add something',
  body: null,
  url: 'https://github.com/owner/repo/pull/42',
  apiUrl: 'https://api.github.com/repos/owner/repo/pulls/42',
  headBranch: 'feature/add-something',
  baseBranch: 'dev',
  state: 'open' as const,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T01:00:00Z',
  mergeableState: 'clean',
  draft: false,
};

function makeMockGitHub(): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue([]),
    getPRState: vi.fn().mockResolvedValue('merged'),
    fetchDiff: vi.fn(),
    fetchPR: vi.fn().mockResolvedValue(mockGitHubPR),
    mergePR: vi.fn().mockResolvedValue({ merged: true, message: 'Merged', sha: 'abc123' }),
  } as unknown as GitHubClient;
}

function makeMockPRReviewService(): PRReviewService {
  return {
    reviewPR: vi.fn().mockResolvedValue({
      prNumber: 42,
      repo: 'owner/repo',
      verdict: 'approved',
      dimensions: [],
      summary: 'Looks good',
      reviewedAt: new Date().toISOString(),
    }),
  } as unknown as PRReviewService;
}

function makeMockSessionManager(): SessionManager {
  return {
    sendOrResume: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionManager;
}

function buildApp(
  github = makeMockGitHub(),
  prReviewService = makeMockPRReviewService(),
  sessionManager = makeMockSessionManager(),
) {
  const app = express();
  app.use(express.json());
  app.use('/api', createPrsRouter(github, prReviewService, sessionManager));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── GET /api/prs ──────────────────────────────────────────────────────────────

describe('GET /api/prs', () => {
  it('returns 200 with an array when no PRs in DB', async () => {
    vi.mocked(queries.getPRs).mockReturnValue([]);
    const res = await supertest(buildApp()).get('/api/prs?projectId=proj-1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('returns mapped PR items including notionTaskTitle from cache', async () => {
    vi.mocked(queries.getPRs).mockReturnValue([mockPRRow]);
    vi.mocked(queries.getTaskTitleFromCache).mockReturnValue('My Task Title');
    const res = await supertest(buildApp()).get('/api/prs?projectId=proj-1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].prNumber).toBe(42);
    expect(res.body[0].notionTaskTitle).toBe('My Task Title');
  });

  it('returns PRs with all states (open, merged, closed), not just open', async () => {
    const mergedRow: PullRequestRow = { ...mockPRRow, pr_number: 50, state: 'merged' };
    const closedRow: PullRequestRow = { ...mockPRRow, pr_number: 51, state: 'closed' };
    vi.mocked(queries.getPRs).mockReturnValue([mockPRRow, mergedRow, closedRow]);
    const github = makeMockGitHub();
    // PR 42 is still open on GitHub — no reconciliation should occur for it
    vi.mocked(github.listOpenPRs).mockResolvedValue([{ ...openGitHubPR, id: 42 }]);
    const res = await supertest(buildApp(github)).get('/api/prs?projectId=proj-1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((p: { state: string }) => p.state)).toEqual(['open', 'merged', 'closed']);
  });

  it('updates local state to merged when GitHub no longer lists the PR as open', async () => {
    const staleRow: PullRequestRow = { ...mockPRRow, pr_number: 99, state: 'open' };
    vi.mocked(queries.getPRs).mockReturnValue([staleRow]);
    const github = makeMockGitHub();
    // GitHub returns no open PRs → PR 99 is stale
    vi.mocked(github.listOpenPRs).mockResolvedValue([]);
    vi.mocked(github.getPRState).mockResolvedValue('merged');

    const res = await supertest(buildApp(github)).get('/api/prs?projectId=proj-1');
    expect(res.status).toBe(200);
    expect(vi.mocked(queries.updatePRState)).toHaveBeenCalledWith(99, 'owner/repo', 'merged');
    expect(res.body[0].state).toBe('merged');
  });

  it('returns 400 when projectId is missing', async () => {
    const res = await supertest(buildApp()).get('/api/prs');
    expect(res.status).toBe(400);
  });

  it('returns 422 when project has no githubRepo', async () => {
    const res = await supertest(buildApp()).get('/api/prs?projectId=proj-no-repo');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/githubRepo/);
  });
});

// ── POST /api/prs/:prNumber/review ────────────────────────────────────────────

describe('POST /api/prs/:prNumber/review', () => {
  it('returns stub response when PR exists with notion_task_id', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const res = await supertest(buildApp())
      .post('/api/prs/42/review?projectId=proj-1');
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBeNull();
    expect(res.body.message).toBe('PR review not yet implemented');
  });

  it('returns stub response when PR exists without notion_task_id', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRowNoTask);
    const res = await supertest(buildApp())
      .post('/api/prs/43/review?projectId=proj-1');
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBeNull();
  });

  it('performs on-demand sync and returns stub when PR is not in DB', async () => {
    vi.mocked(queries.getPRByNumber)
      .mockReturnValueOnce(null)           // first call — not found
      .mockReturnValueOnce(mockPRRow);     // second call — after upsert
    const github = makeMockGitHub();
    const res = await supertest(buildApp(github))
      .post('/api/prs/42/review?projectId=proj-1');
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBeNull();
    expect(vi.mocked(github.fetchPR)).toHaveBeenCalledWith('owner/repo', 42);
    expect(vi.mocked(queries.upsertPullRequest)).toHaveBeenCalledOnce();
  });

  it('returns 404 when PR is not in DB and GitHub fetch also fails', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(null);
    const github = makeMockGitHub();
    vi.mocked(github.fetchPR).mockRejectedValue(new Error('Not Found'));
    const res = await supertest(buildApp(github))
      .post('/api/prs/42/review?projectId=proj-1');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/PR #42 not found/);
  });

  it('returns 404 when PR is not in DB and still not found after upsert', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(null);
    const res = await supertest(buildApp())
      .post('/api/prs/42/review?projectId=proj-1');
    expect(res.status).toBe(404);
  });
});

// ── POST /api/prs/:prNumber/merge ─────────────────────────────────────────────

describe('POST /api/prs/:prNumber/merge', () => {
  it('returns 422 with error message on GitHubApiError', async () => {
    const github = makeMockGitHub();
    vi.mocked(github.mergePR).mockRejectedValue(new GitHubApiError(405, 'Not mergeable'));
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const res = await supertest(buildApp(github))
      .post('/api/prs/42/merge?projectId=proj-1')
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Not mergeable');
  });

  it('returns merge result and updates state on success', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const res = await supertest(buildApp())
      .post('/api/prs/42/merge?projectId=proj-1')
      .send({ commitTitle: 'feat: add something (#42)' });
    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(true);
    expect(vi.mocked(queries.updatePRState)).toHaveBeenCalledWith(42, 'owner/repo', 'merged');
  });
});

// ── DELETE /api/prs/:prNumber ──────────────────────────────────────────────────

describe('DELETE /api/prs/:prNumber', () => {
  it('returns 200 and calls deletePR when PR exists', async () => {
    vi.mocked(queries.deletePR).mockReturnValue(true);
    const res = await supertest(buildApp())
      .delete('/api/prs/42?projectId=proj-1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(vi.mocked(queries.deletePR)).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('returns 404 when PR does not exist', async () => {
    vi.mocked(queries.deletePR).mockReturnValue(false);
    const res = await supertest(buildApp())
      .delete('/api/prs/99?projectId=proj-1');
    expect(res.status).toBe(404);
  });

  it('returns 400 when projectId is missing', async () => {
    const res = await supertest(buildApp()).delete('/api/prs/42');
    expect(res.status).toBe(400);
  });
});

// ── DELETE /api/prs/clear ─────────────────────────────────────────────────────

describe('DELETE /api/prs/clear', () => {
  it('returns deleted count', async () => {
    vi.mocked(queries.deleteMergedAndClosedPRs).mockReturnValue(3);
    const res = await supertest(buildApp())
      .delete('/api/prs/clear?projectId=proj-1');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(3);
    expect(vi.mocked(queries.deleteMergedAndClosedPRs)).toHaveBeenCalledWith('owner/repo');
  });

  it('returns 400 when projectId is missing', async () => {
    const res = await supertest(buildApp()).delete('/api/prs/clear');
    expect(res.status).toBe(400);
  });
});

// ── GET /api/prs/clear/count ──────────────────────────────────────────────────

describe('GET /api/prs/clear/count', () => {
  it('returns count of merged/closed PRs', async () => {
    vi.mocked(queries.countMergedAndClosedPRs).mockReturnValue(2);
    const res = await supertest(buildApp())
      .get('/api/prs/clear/count?projectId=proj-1');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

// ── PRSyncJob ─────────────────────────────────────────────────────────────────

describe('PRSyncJob.run()', () => {
  it('does not throw when listOpenPRs rejects — warns instead', async () => {
    // Import here so the config mock is active
    const { PRSyncJob } = await import('../github/PRSyncJob.js');
    const github = makeMockGitHub();
    vi.mocked(github.listOpenPRs).mockRejectedValue(new Error('network error'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const job = new PRSyncJob(github);
    await expect(job.run()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sync failed'),
      'network error',
    );
    warnSpy.mockRestore();
  });

  it('upserts PRs from GitHub into the DB', async () => {
    const { PRSyncJob } = await import('../github/PRSyncJob.js');
    const github = makeMockGitHub();
    vi.mocked(github.listOpenPRs).mockResolvedValue([openGitHubPR]);
    vi.mocked(queries.getOpenPRs).mockReturnValue([]);

    const job = new PRSyncJob(github);
    await job.run();
    expect(vi.mocked(queries.upsertPullRequest)).toHaveBeenCalledOnce();
  });

  it('updates state to merged for a locally-open PR no longer open on GitHub', async () => {
    const { PRSyncJob } = await import('../github/PRSyncJob.js');
    const github = makeMockGitHub();
    // GitHub reports PR 1 as open; locally PR 99 is also "open" but absent from GitHub
    vi.mocked(github.listOpenPRs).mockResolvedValue([openGitHubPR]);
    vi.mocked(github.getPRState).mockResolvedValue('merged');
    const staleRow: PullRequestRow = { ...mockPRRow, pr_number: 99, state: 'open' };
    vi.mocked(queries.getOpenPRs).mockReturnValue([staleRow]);

    const job = new PRSyncJob(github);
    await job.run();
    expect(vi.mocked(github.getPRState)).toHaveBeenCalledWith(99, 'owner/repo');
    expect(vi.mocked(queries.updatePRState)).toHaveBeenCalledWith(99, 'owner/repo', 'merged');
  });
});
