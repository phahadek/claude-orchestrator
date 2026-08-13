/**
 * task.setType is HUMAN_APPLY_ONLY (stagedIntents.ts's HUMAN_APPLY_ONLY_KINDS)
 * — a dispatched planning session can stage a retype for operator
 * disposition but can never apply one itself. This covers both directions:
 * a session-staged task.setType is accepted at stage time, and refused at
 * apply time when the actor is a session rather than a human.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('task.setType staged by a planning session', () => {
  it('is accepted at stage time from a session credential', async () => {
    const staged = stageIntent(
      'task.setType',
      { taskId: 't-1', type: '📐 Design' },
      'proj-1',
      null,
      'session-groom-1',
      'Operator asked for this to be retyped to Design.',
    );
    expect(staged.sessionId).toBe('session-groom-1');
    expect(staged.state).toBe('staged');
    expect(staged.kind).toBe('task.setType');
  });

  it('is refused at apply time when the actor is a session, not a human', async () => {
    const setType = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setType,
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nok'),
    });

    const staged = stageIntent(
      'task.setType',
      { taskId: 't-1', type: '📐 Design' },
      'proj-1',
      null,
      'session-groom-1',
      'Operator asked for this to be retyped to Design.',
    );

    const app = buildApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${staged.id}/apply`)
      .send({ actorType: 'session' });

    expect(applied.status).toBe(403);
    expect(setType).not.toHaveBeenCalled();
  });

  it('applies through TaskWriteCommands.setType when the actor is human', async () => {
    const setType = vi.fn().mockResolvedValue(undefined);
    mockGetTaskBackend.mockReturnValue({
      type: 'notion',
      setType,
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nok'),
    });

    const staged = stageIntent(
      'task.setType',
      { taskId: 't-1', type: '📐 Design' },
      'proj-1',
      null,
      'session-groom-1',
      'Operator asked for this to be retyped to Design.',
    );

    const app = buildApp();
    const agent = supertest(app);
    const applied = await agent
      .post(`/api/staged-intents/${staged.id}/apply`)
      .send({});

    expect(applied.status).toBe(200);
    expect(setType).toHaveBeenCalledWith('t-1', '📐 Design', {
      source: 'human',
    });
  });
});
