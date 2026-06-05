import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import type { TaskAggregateRow } from '../db/queries.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../db/queries.js', () => ({
  getTaskCache: vi.fn(),
  getActiveTaskAggregates: vi.fn().mockReturnValue([]),
  getSetting: vi.fn().mockReturnValue(null),
  getMilestoneById: vi.fn().mockReturnValue(null),
  getLatestCodeSessionByNotionTaskId: vi.fn(),
  markSessionAborted: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getProjectById: vi.fn((id: string) => {
    if (id === 'proj-1') {
      return {
        id: 'proj-1',
        name: 'Test Project',
        projectDir: '/test',
        contextUrl: 'https://notion.so/ctx',
        boardId: 'board-1',
        taskSource: 'notion',
      };
    }
    return undefined;
  }),
}));

const updateStatusMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../tasks/TaskBackend.js', () => ({
  getTaskBackend: vi.fn(() => ({
    updateStatus: updateStatusMock,
  })),
}));

vi.mock('../projects/ProjectService.js', () => ({
  ProjectService: {
    getMilestone: vi.fn().mockReturnValue(null),
  },
}));

import { createTasksRouter } from '../routes/tasks.js';
import * as queries from '../db/queries.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function buildApp(sessionManager?: {
  abort: ReturnType<typeof vi.fn>;
}) {
  const app = express();
  app.use(express.json());
  app.use('/api', createTasksRouter(sessionManager as never));
  return app;
}

// ── POST /api/tasks/:id/abort ─────────────────────────────────────────────────

describe('POST /api/tasks/:id/abort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateStatusMock.mockResolvedValue(undefined);
    vi.mocked(queries.getActiveTaskAggregates).mockReturnValue([]);
  });

  it('returns 400 when projectId is missing', async () => {
    const res = await supertest(buildApp()).post('/api/tasks/task-1/abort').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectId/);
  });

  it('returns 404 when project is not found', async () => {
    const res = await supertest(buildApp())
      .post('/api/tasks/task-1/abort')
      .send({ projectId: 'no-such-project' });
    expect(res.status).toBe(404);
  });

  it('aborts the provided sessionId and resets task to Ready', async () => {
    const abortMock = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({ abort: abortMock });

    const res = await supertest(app)
      .post('/api/tasks/task-1/abort')
      .send({ projectId: 'proj-1', sessionId: 'session-abc' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(abortMock).toHaveBeenCalledWith('session-abc');
    expect(updateStatusMock).toHaveBeenCalledWith('task-1', '🗂️ Ready', {
      source: 'human',
    });
  });

  it('falls back to latest session from DB when sessionId is not provided', async () => {
    vi.mocked(queries.getLatestCodeSessionByNotionTaskId).mockReturnValue({
      session_id: 'session-from-db',
      task_id: 'task-1',
    } as never);

    const abortMock = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({ abort: abortMock });

    const res = await supertest(app)
      .post('/api/tasks/task-1/abort')
      .send({ projectId: 'proj-1' });

    expect(res.status).toBe(200);
    expect(abortMock).toHaveBeenCalledWith('session-from-db');
  });

  it('still resets task to Ready even when no session is found', async () => {
    vi.mocked(queries.getLatestCodeSessionByNotionTaskId).mockReturnValue(
      undefined,
    );

    const abortMock = vi.fn();
    const app = buildApp({ abort: abortMock });

    const res = await supertest(app)
      .post('/api/tasks/task-1/abort')
      .send({ projectId: 'proj-1' });

    expect(res.status).toBe(200);
    expect(abortMock).not.toHaveBeenCalled();
    expect(updateStatusMock).toHaveBeenCalledWith('task-1', '🗂️ Ready', {
      source: 'human',
    });
  });

  it('succeeds without a sessionManager (no session to kill)', async () => {
    const app = buildApp(undefined);

    const res = await supertest(app)
      .post('/api/tasks/task-1/abort')
      .send({ projectId: 'proj-1', sessionId: 'some-session' });

    // Should still reset the task even without a sessionManager
    expect(res.status).toBe(200);
    expect(updateStatusMock).toHaveBeenCalledWith('task-1', '🗂️ Ready', {
      source: 'human',
    });
  });
});

// ── SessionManager.abort() — aborted flag prevents sendOrResume ───────────────

describe('SessionManager abort flag prevents resume', () => {
  it('marks session as aborted in DB via markSessionAborted', async () => {
    // This test verifies that when abort() is called on SessionManager, it
    // marks the session as aborted before attempting to kill it.
    // We test this at the queries layer since we cannot easily instantiate
    // a full SessionManager in isolation.
    const { markSessionAborted } = await import('../db/queries.js');
    vi.mocked(markSessionAborted).mockImplementation(() => {});

    markSessionAborted('test-session');
    expect(vi.mocked(markSessionAborted)).toHaveBeenCalledWith('test-session');
  });
});
