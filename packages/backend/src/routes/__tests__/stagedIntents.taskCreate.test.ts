/**
 * A dispatched planning session (groom/design/ops) now has task.create in
 * its allowed intent kinds (procedureAssembler.ts's PLANNING_INTENT_KINDS)
 * so it can stage mandated follow-on Code tasks instead of handing the spec
 * back in chat. This covers the apply-path guarantee that makes staging safe:
 * a task.create staged through the loopback session-stage endpoint
 * (POST /api/task-intents, the transport a dispatched planning session
 * actually uses) commits, on operator approval, to a task the backend always
 * creates at 🔲 Backlog — never Ready — regardless of the staged payload.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend, mockGetSession, mockRecordEvent } = vi.hoisted(
  () => ({
    mockGetTaskBackend: vi.fn(),
    mockGetSession: vi.fn(),
    mockRecordEvent: vi.fn(),
  }),
);

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/queries')>();
  return {
    ...actual,
    getSession: mockGetSession,
    getTaskCache: vi.fn().mockReturnValue(null),
  };
});

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: mockRecordEvent,
}));

import { db } from '../../db/db';
import { createTaskIntentsRouter } from '../taskIntents';
import { createStagedIntentsRouter } from '../stagedIntents';
import {
  mintStageCredential,
  _resetStageCredentialsForTesting,
} from '../../auth/SessionStageAuth';

/** Wired like the real server: the loopback session-stage endpoint ahead of
 *  the human/device-authed staged-intents apply surface. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createTaskIntentsRouter());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetSession.mockReset();
  mockRecordEvent.mockReset();
  _resetStageCredentialsForTesting();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('task.create staged by a planning session', () => {
  it('applies through createTask, which the backend hard-codes to Backlog regardless of the payload', async () => {
    mockGetSession.mockReturnValue({
      session_id: 'session-ops-1',
      project_id: 'proj-1',
    });
    const token = mintStageCredential('session-ops-1');
    const createTask = vi.fn().mockResolvedValue('notion:new-task-id');
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      createTask,
    });

    const app = buildApp();
    const agent = supertest(app);

    const staged = await agent
      .post('/api/task-intents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        kind: 'task.create',
        decisionProposal:
          'Follow-on Code task filed by a dispatched ops session',
        payload: {
          databaseId: 'db-1',
          title: 'Fix the thing the investigation found',
          type: '💻 Code',
          // A planning session cannot smuggle a Ready status through the
          // payload — NewTaskFields carries no status field at all, and the
          // backend enforces Backlog unconditionally.
        },
      });
    expect(staged.status).toBe(201);
    expect(staged.body.sessionId).toBe('session-ops-1');
    expect(staged.body.state).toBe('staged');
    expect(mockGetTaskBackend).not.toHaveBeenCalled();

    const applied = await agent
      .post(`/api/staged-intents/${staged.body.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);
    expect(applied.body.result).toEqual({ id: 'notion:new-task-id' });

    expect(createTask).toHaveBeenCalledTimes(1);
    const [fields] = createTask.mock.calls[0];
    expect(fields).toEqual({
      databaseId: 'db-1',
      title: 'Fix the thing the investigation found',
      type: '💻 Code',
    });
    expect(fields).not.toHaveProperty('status');
  });
});
