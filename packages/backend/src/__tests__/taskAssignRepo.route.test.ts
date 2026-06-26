/**
 * Route-level tests for POST /api/tasks/:taskId/assign-repo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  mockGetProjectById,
  mockSetTaskRepoAssignment,
  mockGetTaskRepoAssignment,
  mockGetActiveTaskAggregates,
  mockGetReviewIterationCap,
} = vi.hoisted(() => ({
  mockGetProjectById: vi.fn(),
  mockSetTaskRepoAssignment: vi.fn(),
  mockGetTaskRepoAssignment: vi.fn().mockReturnValue(undefined),
  mockGetActiveTaskAggregates: vi.fn().mockReturnValue([]),
  mockGetReviewIterationCap: vi.fn().mockReturnValue(3),
}));

vi.mock('../config.js', () => ({
  getProjectById: mockGetProjectById,
  runtimeSettings: {},
}));

vi.mock('../db/queries.js', () => ({
  getTaskCache: vi.fn().mockReturnValue(null),
  getActiveTaskAggregates: mockGetActiveTaskAggregates,
  clearTaskPauseReason: vi.fn(),
  resetTaskCrashCount: vi.fn(),
  deleteTaskCacheRow: vi.fn(),
  getTaskRepoAssignment: mockGetTaskRepoAssignment,
  setTaskRepoAssignment: mockSetTaskRepoAssignment,
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: { getMilestone: vi.fn() },
  getProjectRepos: vi.fn((p: { githubRepo?: string | null }) => {
    const raw = p.githubRepo;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* bare string */ }
    return [raw];
  }),
}));

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config/settings.js', () => ({
  typedGetSetting: mockGetReviewIterationCap,
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { createTasksRouter } from '../routes/tasks.js';

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createTasksRouter());
  return app;
}

function makeProject(extra: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    name: 'Test Project',
    githubRepo: JSON.stringify(['owner/repo-a', 'owner/repo-b']),
    taskSource: 'notion',
    gitMode: 'github',
    ...extra,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('POST /api/tasks/:taskId/assign-repo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProjectById.mockReturnValue(makeProject());
    mockSetTaskRepoAssignment.mockImplementation(() => undefined);
    mockGetTaskRepoAssignment.mockReturnValue(undefined);
    mockGetActiveTaskAggregates.mockReturnValue([]);
  });

  it('returns 200 with ok:true when valid repo is assigned', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/tasks/task-1/assign-repo?projectId=proj-1')
      .send({ repo: 'owner/repo-a' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, repo: 'owner/repo-a' });
    expect(mockSetTaskRepoAssignment).toHaveBeenCalledWith(
      'task-1',
      'proj-1',
      'owner/repo-a',
      'human',
      ['owner/repo-a', 'owner/repo-b'],
    );
  });

  it('returns 422 when projectId is missing', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/tasks/task-1/assign-repo')
      .send({ repo: 'owner/repo-a' });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'projectId is required' });
  });

  it('returns 422 when repo is missing from body', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/tasks/task-1/assign-repo?projectId=proj-1')
      .send({});

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'repo is required' });
  });

  it('returns 422 when projectId does not match a known project', async () => {
    mockGetProjectById.mockReturnValue(undefined);
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/tasks/task-1/assign-repo?projectId=no-such-project')
      .send({ repo: 'owner/repo-a' });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('not found');
  });

  it('returns 422 when repo is not in the project repo set', async () => {
    mockSetTaskRepoAssignment.mockImplementation(() => {
      throw new Error('Repo "owner/wrong-repo" is not in the project\'s repo set');
    });
    const app = buildApp();
    const res = await supertest(app)
      .post('/api/tasks/task-1/assign-repo?projectId=proj-1')
      .send({ repo: 'owner/wrong-repo' });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('not in the project');
  });
});
