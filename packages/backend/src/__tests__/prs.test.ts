import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getOpenPRs: vi.fn(),
  getPRByNumber: vi.fn(),
  updatePRState: vi.fn(),
  getTaskTitleFromCache: vi.fn().mockReturnValue(null),
  upsertPullRequest: vi.fn(),
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

function makeMockGitHub(): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue([]),
    fetchDiff: vi.fn(),
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
    vi.mocked(queries.getOpenPRs).mockReturnValue([]);
    const res = await supertest(buildApp()).get('/api/prs?projectId=proj-1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('returns mapped PR items including notionTaskTitle from cache', async () => {
    vi.mocked(queries.getOpenPRs).mockReturnValue([mockPRRow]);
    vi.mocked(queries.getTaskTitleFromCache).mockReturnValue('My Task Title');
    const res = await supertest(buildApp()).get('/api/prs?projectId=proj-1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].prNumber).toBe(42);
    expect(res.body[0].notionTaskTitle).toBe('My Task Title');
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
  it('returns 422 when notion_task_id is null', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRowNoTask);
    const res = await supertest(buildApp())
      .post('/api/prs/43/review?projectId=proj-1');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/No Notion task/);
  });

  it('returns review result on success', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue(mockPRRow);
    const res = await supertest(buildApp())
      .post('/api/prs/42/review?projectId=proj-1');
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('approved');
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
    vi.mocked(github.listOpenPRs).mockResolvedValue([
      {
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
      },
    ]);

    const job = new PRSyncJob(github);
    await job.run();
    expect(vi.mocked(queries.upsertPullRequest)).toHaveBeenCalledOnce();
  });
});
