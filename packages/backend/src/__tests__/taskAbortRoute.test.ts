import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const mockUpdateStatus = vi.fn(async () => {});
const mockAppendImplementationNote = vi.fn(async () => {});
const mockFetchTaskSummary = vi.fn(
  async () => null as { title: string; type: string; status: string } | null,
);

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    type: 'notion',
    updateStatus: mockUpdateStatus,
    fetchTaskPage: vi.fn(async () => ''),
    fetchTaskSummary: mockFetchTaskSummary,
    appendImplementationNote: mockAppendImplementationNote,
  })),
}));

import { db } from '../db/db.js';
import { insertSession } from '../db/queries.js';
import { isPlanningKillSuppressed } from '../db/queries.js';
import { createTaskAbortRouter } from '../routes/taskAbort.js';

const PROJECT = 'proj-1';
const TASK_ID = 'task-abort-1';

/** Mirrors what AgentSession.kill() -> markSessionErrored actually writes: status='killed' + a session_errored audit event carrying reason 'user_kill'. */
async function fakeKill(sessionId: string): Promise<void> {
  const { updateSessionStatus } = await import('../db/queries.js');
  const { recordEvent } = await import('../audit/AuditLog.js');
  updateSessionStatus(sessionId, 'killed', Date.now());
  recordEvent({
    event_type: 'session_errored',
    actor_type: 'system',
    actor_id: sessionId,
    project_id: null,
    task_id: null,
    payload: { sessionId, status: 'killed', reason: 'user_kill' },
  });
}

function makeApp(withSessionManager = true) {
  const app = express();
  app.use(express.json());
  const sessionManager = withSessionManager
    ? { kill: vi.fn(fakeKill) }
    : undefined;
  app.use('/api', createTaskAbortRouter(sessionManager));
  return { app, sessionManager };
}

function seedGroomSession(sessionId: string, taskId: string) {
  insertSession({
    session_id: sessionId,
    task_id: taskId,
    task_url: null,
    project_context_url: null,
    project_id: PROJECT,
    status: 'running',
    started_at: Date.now(),
    ended_at: null,
    session_type: 'groom',
  } as never);
}

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM devices').run();
  vi.clearAllMocks();
  mockFetchTaskSummary.mockReset();
});

describe('POST /api/tasks/:id/abort', () => {
  it('rejects requests with no device token when devices are enrolled', async () => {
    const { insertDevice } = await import('../db/queries.js');
    insertDevice({
      id: 'dev-1',
      name: 'test device',
      user_agent: null,
      last_ip: null,
      enrolled_at: Date.now(),
      token: 'tok-1',
    } as never);
    const { app } = makeApp();
    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/abort`)
      .send({ projectId: PROJECT });
    expect(res.status).toBe(401);
  });

  it('rejects a task whose current status is not Backlog', async () => {
    mockFetchTaskSummary.mockResolvedValue({
      title: 'T',
      type: '💻 Code',
      status: '🗂️ Ready',
    });
    const { app } = makeApp();
    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/abort`)
      .send({ projectId: PROJECT });
    expect(res.status).toBe(400);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('sets status to Deferred, appends a note, and kills the bound groom session', async () => {
    mockFetchTaskSummary.mockResolvedValue({
      title: 'T',
      type: '💻 Code',
      status: '🔲 Backlog',
    });
    const groomSessionId = 'sess-groom-1';
    seedGroomSession(groomSessionId, TASK_ID);
    const otherSessionId = 'sess-standard-1';
    insertSession({
      session_id: otherSessionId,
      task_id: TASK_ID,
      task_url: null,
      project_context_url: null,
      project_id: PROJECT,
      status: 'running',
      started_at: Date.now(),
      ended_at: null,
      session_type: 'standard',
    } as never);

    const { app, sessionManager } = makeApp();
    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/abort`)
      .send({ projectId: PROJECT, note: 'mis-filed, refiling' });

    expect(res.status).toBe(200);
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      TASK_ID,
      '⏭️ Deferred',
      expect.objectContaining({ source: 'human' }),
    );
    expect(mockAppendImplementationNote).toHaveBeenCalledWith(
      TASK_ID,
      'mis-filed, refiling',
    );
    expect(sessionManager!.kill).toHaveBeenCalledWith(groomSessionId);
    expect(sessionManager!.kill).not.toHaveBeenCalledWith(otherSessionId);

    const { getSession } = await import('../db/queries.js');
    expect(getSession(groomSessionId)?.status).toBe('killed');
    expect(getSession(otherSessionId)?.status).toBe('running');

    expect(isPlanningKillSuppressed(TASK_ID, 'groom')).toBe(true);
  });

  it('succeeds without attempting a kill when no session is bound to the task', async () => {
    mockFetchTaskSummary.mockResolvedValue({
      title: 'T',
      type: '💻 Code',
      status: '🔲 Backlog',
    });
    const { app, sessionManager } = makeApp();
    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/abort`)
      .send({ projectId: PROJECT });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, killedSessionId: null });
    expect(mockUpdateStatus).toHaveBeenCalled();
    expect(mockAppendImplementationNote).toHaveBeenCalled();
    expect(sessionManager!.kill).not.toHaveBeenCalled();
  });
});
