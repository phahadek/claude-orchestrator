import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../routes/tasks.js', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../db/queries.js', () => ({
  getPRs: vi.fn(),
  getPRByNumber: vi.fn().mockReturnValue(null),
  updatePRState: vi.fn(),
  updateMergeState: vi.fn(),
  getTaskTitleFromCache: vi.fn().mockReturnValue(null),
  upsertPullRequest: vi.fn().mockReturnValue(null),
  deletePR: vi.fn(),
  resetReviewIteration: vi.fn(),
  setPRReviewResult: vi.fn(),
  updatePRDraftStatus: vi.fn(),
  getSessionsByProject: vi.fn().mockReturnValue([]),
  lookupSessionByBranch: vi.fn().mockReturnValue(null),
}));

vi.mock('../config.js', () => ({
  getProjectById: vi.fn(),
  getProjectByGithubRepo: vi.fn((repo: string) => {
    if (repo === 'owner/repo') {
      return {
        id: 'proj-1',
        name: 'Test Project',
        projectDir: '/test',
        contextUrl: 'https://notion.so/ctx',
        boardId: 'board-1',
        githubRepo: 'owner/repo',
        gitMode: 'github',
        autoMergeEnabled: false,
      };
    }
    return undefined;
  }),
  getAllProjects: vi.fn(() => []),
  loadOrchestratorConfig: vi.fn(),
}));

import { createPrsRouter, extractNotionTaskFromBody } from '../routes/prs.js';
import * as queries from '../db/queries.js';
import type { GitHubClient } from '../github/GitHubClient.js';
import type { PRReviewService } from '../github/PRReviewService.js';
import type { SessionManager } from '../session/SessionManager.js';
import { GitHubApiError } from '../github/types.js';
import type { PullRequest } from '../github/types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOTION_URL =
  'https://www.notion.so/My-Task-37822f9152f3810d8a94c8de372f2b4e';
const NOTION_TASK_ID = '37822f91-52f3-810d-8a94-c8de372f2b4e';

const mockGitHubPR: PullRequest = {
  id: 99,
  nodeId: 'PR_node_99',
  title: 'feat: orphaned PR',
  body: `## Summary\nBackfill me.\n\n## Notion Task\n${NOTION_URL}`,
  url: 'https://github.com/owner/repo/pull/99',
  apiUrl: 'https://api.github.com/repos/owner/repo/pulls/99',
  headBranch: 'feature/my-task-37822f9152f3810d8a94c8de372f2b4e',
  headSha: 'abc123',
  baseBranch: 'dev',
  state: 'open',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T01:00:00Z',
  mergeableState: 'clean',
  draft: true,
};

function makeMockGitHub(
  fetchPRImpl: () => Promise<PullRequest> = () => Promise.resolve(mockGitHubPR),
): GitHubClient {
  return {
    listOpenPRs: vi.fn().mockResolvedValue([]),
    getPRState: vi.fn().mockResolvedValue({ state: 'open', headSha: null }),
    fetchPR: vi.fn().mockImplementation(fetchPRImpl),
    fetchDiff: vi.fn(),
    mergePR: vi.fn(),
    markPRReady: vi.fn().mockResolvedValue(undefined),
    getMergeability: vi
      .fn()
      .mockResolvedValue({ mergeable: true, mergeableState: 'clean' }),
    getMergeabilityWithRetry: vi
      .fn()
      .mockResolvedValue({ mergeable: true, mergeableState: 'clean' }),
    getFailingChecks: vi.fn().mockResolvedValue([]),
    categorizeMergeability: vi.fn(),
  } as unknown as GitHubClient;
}

function makeMockPRReviewService(): PRReviewService {
  return { reviewPR: vi.fn() } as unknown as PRReviewService;
}

type MockSessionManager = SessionManager & { emit: ReturnType<typeof vi.fn> };

function makeMockSessionManager(): MockSessionManager {
  return {
    sendOrResume: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
  } as unknown as MockSessionManager;
}

function buildApp(
  github = makeMockGitHub(),
  sessionManager = makeMockSessionManager(),
) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createPrsRouter(github, makeMockPRReviewService(), sessionManager),
  );
  return { app, sessionManager };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getPRByNumber).mockReturnValue(null);
  vi.mocked(queries.lookupSessionByBranch).mockReturnValue(null);
  vi.mocked(queries.upsertPullRequest).mockReturnValue(null);
});

// ── extractNotionTaskFromBody unit tests ─────────────────────────────────────

describe('extractNotionTaskFromBody', () => {
  it('returns null for null body', () => {
    expect(extractNotionTaskFromBody(null)).toBeNull();
  });

  it('returns null when no Notion URL is present', () => {
    expect(extractNotionTaskFromBody('No notion link here')).toBeNull();
  });

  it('extracts taskId from a dashless 32-hex Notion URL', () => {
    const result = extractNotionTaskFromBody(
      `See https://www.notion.so/My-Task-37822f9152f3810d8a94c8de372f2b4e for context`,
    );
    expect(result).not.toBeNull();
    expect(result!.taskId).toBe('37822f91-52f3-810d-8a94-c8de372f2b4e');
    expect(result!.taskUrl).toContain('notion.so');
  });

  it('extracts taskId from an app.notion.com URL', () => {
    const result = extractNotionTaskFromBody(
      `Task: https://app.notion.com/p/Some-Task-37822f9152f3810d8a94c8de372f2b4e`,
    );
    expect(result).not.toBeNull();
    expect(result!.taskId).toBe('37822f91-52f3-810d-8a94-c8de372f2b4e');
  });

  it('extracts only the first Notion URL when multiple are present', () => {
    const body = [
      'First: https://www.notion.so/Task-A-37822f9152f3810d8a94c8de372f2b4e',
      'Second: https://www.notion.so/Task-B-aabbccdd11223344aabbccdd11223344',
    ].join('\n');
    const result = extractNotionTaskFromBody(body);
    expect(result!.taskId).toBe('37822f91-52f3-810d-8a94-c8de372f2b4e');
  });
});

// ── POST /api/prs/ingest ──────────────────────────────────────────────────────

describe('POST /api/prs/ingest', () => {
  it('returns 400 when repo is missing', async () => {
    const { app } = buildApp();
    const res = await supertest(app)
      .post('/api/prs/ingest')
      .send({ prNumber: 99 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when prNumber is missing', async () => {
    const { app } = buildApp();
    const res = await supertest(app)
      .post('/api/prs/ingest')
      .send({ repo: 'owner/repo' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when no project is configured for repo', async () => {
    const { app } = buildApp();
    const res = await supertest(app)
      .post('/api/prs/ingest')
      .send({ repo: 'unknown/repo', prNumber: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No project configured/);
  });

  it('returns 409 when PR row already exists', async () => {
    vi.mocked(queries.getPRByNumber).mockReturnValue({
      id: 1,
      pr_number: 99,
      repo: 'owner/repo',
    } as ReturnType<typeof queries.getPRByNumber>);
    const { app } = buildApp();
    const res = await supertest(app)
      .post('/api/prs/ingest')
      .send({ repo: 'owner/repo', prNumber: 99 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already tracked/);
  });

  it('returns 404 when GitHub returns 404 for the PR', async () => {
    const github = makeMockGitHub(() =>
      Promise.reject(new GitHubApiError(404, 'Not Found')),
    );
    const { app } = buildApp(github);
    const res = await supertest(app)
      .post('/api/prs/ingest')
      .send({ repo: 'owner/repo', prNumber: 99 });
    expect(res.status).toBe(404);
  });

  it('inserts PR row with task_id when Notion URL is in body', async () => {
    vi.mocked(queries.lookupSessionByBranch).mockReturnValue({
      session_id: 'session-abc',
      task_id: NOTION_TASK_ID,
    });
    const { app, sessionManager } = buildApp();
    const res = await supertest(app)
      .post('/api/prs/ingest')
      .send({ repo: 'owner/repo', prNumber: 99 });

    expect(res.status).toBe(201);
    expect(res.body.pr_number).toBe(99);
    expect(res.body.taskId).toBe(NOTION_TASK_ID);
    expect(res.body.sessionId).toBe('session-abc');

    expect(queries.upsertPullRequest).toHaveBeenCalledOnce();
    const upsertArg = vi.mocked(queries.upsertPullRequest).mock.calls[0][0];
    expect(upsertArg.task_id).toBe(NOTION_TASK_ID);
    expect(upsertArg.session_id).toBe('session-abc');
    expect(upsertArg.head_sha).toBe('abc123');
    expect(upsertArg.draft).toBe(1);

    expect(sessionManager.emit).toHaveBeenCalledWith(
      'pr_opened',
      expect.objectContaining({
        prNumber: 99,
        repo: 'owner/repo',
        taskId: NOTION_TASK_ID,
      }),
    );
  });

  it('inserts PR row with task_id=null and emits pr_opened when body has no Notion URL', async () => {
    const prNoNotion: PullRequest = { ...mockGitHubPR, body: 'No notion link here' };
    const github = makeMockGitHub(() => Promise.resolve(prNoNotion));
    const { app, sessionManager } = buildApp(github);
    const res = await supertest(app)
      .post('/api/prs/ingest')
      .send({ repo: 'owner/repo', prNumber: 99 });

    expect(res.status).toBe(201);
    expect(res.body.taskId).toBeNull();

    const upsertArg = vi.mocked(queries.upsertPullRequest).mock.calls[0][0];
    expect(upsertArg.task_id).toBeNull();

    expect(sessionManager.emit).toHaveBeenCalledWith(
      'pr_opened',
      expect.objectContaining({ prNumber: 99, repo: 'owner/repo', taskId: null }),
    );
  });

  it('inserts PR row with session_id=null when branch cannot be matched', async () => {
    vi.mocked(queries.lookupSessionByBranch).mockReturnValue(null);
    const { app } = buildApp();
    const res = await supertest(app)
      .post('/api/prs/ingest')
      .send({ repo: 'owner/repo', prNumber: 99 });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBeNull();
    const upsertArg = vi.mocked(queries.upsertPullRequest).mock.calls[0][0];
    expect(upsertArg.session_id).toBeNull();
  });
});
