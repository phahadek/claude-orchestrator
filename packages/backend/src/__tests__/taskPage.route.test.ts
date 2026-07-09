/**
 * Route-level tests for GET /api/tasks/:taskId/page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockGetProjectById, mockGetTaskBackend, mockFetchTaskPage } = vi.hoisted(
  () => ({
    mockGetProjectById: vi.fn(),
    mockGetTaskBackend: vi.fn(),
    mockFetchTaskPage: vi.fn(),
  }),
);

vi.mock('../config.js', () => ({
  getProjectById: mockGetProjectById,
  runtimeSettings: {},
}));

vi.mock('../db/queries.js', () => ({
  getTaskCache: vi.fn().mockReturnValue(null),
  getActiveTaskAggregates: vi.fn().mockReturnValue([]),
  clearTaskPauseReason: vi.fn(),
  resetTaskCrashCount: vi.fn(),
  deleteTaskCacheRow: vi.fn(),
  getTaskRepoAssignment: vi.fn().mockReturnValue(undefined),
  setTaskRepoAssignment: vi.fn(),
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: { getMilestone: vi.fn() },
  getProjectRepos: vi.fn().mockReturnValue([]),
}));

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config/settings.js', () => ({
  typedGetSetting: vi.fn().mockReturnValue(3),
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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GET /api/tasks/:taskId/page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTaskBackend.mockReturnValue({ fetchTaskPage: mockFetchTaskPage });
  });

  it('returns { markdown } from the resolved task backend', async () => {
    mockFetchTaskPage.mockResolvedValue('# Title\n\n- [ ] item');
    const app = buildApp();
    const res = await supertest(app).get(
      '/api/tasks/task-1/page?projectId=proj-1',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ markdown: '# Title\n\n- [ ] item' });
    expect(mockGetTaskBackend).toHaveBeenCalledWith('proj-1');
    expect(mockFetchTaskPage).toHaveBeenCalledWith('task-1');
  });

  it('returns 400 when projectId is missing', async () => {
    const app = buildApp();
    const res = await supertest(app).get('/api/tasks/task-1/page');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'projectId is required' });
    expect(mockGetTaskBackend).not.toHaveBeenCalled();
  });

  it('returns 404 when fetchTaskPage reports the task is not found', async () => {
    mockFetchTaskPage.mockRejectedValue(
      new Error('[LocalTaskBackend] task not found: task-1'),
    );
    const app = buildApp();
    const res = await supertest(app).get(
      '/api/tasks/task-1/page?projectId=proj-1',
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });
});
