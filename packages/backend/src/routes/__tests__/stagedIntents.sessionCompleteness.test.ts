/**
 * Enforces the "staged intent disposition gating on session-turn
 * completeness" invariant (task 3ae22f9152f381a39a34eb3f4cc1efbb): a
 * session's staged intents are inert — apply/commit refused — until the
 * session itself is "complete": it has staged at least one intent since its
 * last stop, and its turn has ended (AgentSession.hasActiveTurn() false).
 * Completeness is derived purely from existing session state (turn-in-flight
 * + staged_intent rows), never a new persisted column or intent kind.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { insertSession } from '../../db/queries';
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';

function makeSessionManager(hasActiveTurn: boolean) {
  const sm = new EventEmitter();
  const liveSession = { hasActiveTurn: vi.fn(() => hasActiveTurn) };
  return Object.assign(sm, {
    getLiveSession: vi.fn().mockReturnValue(liveSession),
    liveSession,
  });
}

function makeApp(sessionManager: ReturnType<typeof makeSessionManager>) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createStagedIntentsRouter(undefined, sessionManager as never),
  );
  return app;
}

const PROJECT_ID = 'proj-completeness-gate';
const SESSION_ID = 'sess-completeness-gate-1';

function seedSession(sessionId: string) {
  insertSession({
    session_id: sessionId,
    task_id: null,
    task_url: null,
    project_context_url: null,
    status: 'running',
    started_at: 0,
    session_type: 'groom',
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    granted_capabilities: '[]',
  });
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue({
    type: 'notion',
    setProperties: vi.fn().mockResolvedValue(undefined),
  });
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('session-turn-completeness disposition gating', () => {
  it('refuses apply while the turn is in flight, and succeeds once the turn ends', async () => {
    seedSession(SESSION_ID);
    const sessionManager = makeSessionManager(true);
    const app = makeApp(sessionManager);
    const agent = supertest(app);

    const intentA = stageIntent(
      'task.setProperties',
      { taskId: 'task-a', patch: { priority: 'High' } },
      PROJECT_ID,
      null,
      SESSION_ID,
    );
    stageIntent(
      'task.setProperties',
      { taskId: 'task-b', patch: { priority: 'Low' } },
      PROJECT_ID,
      null,
      SESSION_ID,
    );

    const refused = await agent
      .post(`/api/staged-intents/${intentA.id}/apply`)
      .send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/not yet complete/);

    sessionManager.liveSession.hasActiveTurn.mockReturnValue(false);

    const applied = await agent
      .post(`/api/staged-intents/${intentA.id}/apply`)
      .send({});
    expect(applied.status).toBe(200);
  });

  it('reverts prior staged intents to incomplete on resume, until the session stops again', async () => {
    seedSession(SESSION_ID);
    const sessionManager = makeSessionManager(false);
    const app = makeApp(sessionManager);
    const agent = supertest(app);

    const intentA = stageIntent(
      'task.setProperties',
      { taskId: 'task-a', patch: { priority: 'High' } },
      PROJECT_ID,
      null,
      SESSION_ID,
    );
    const intentB = stageIntent(
      'task.setProperties',
      { taskId: 'task-b', patch: { priority: 'Low' } },
      PROJECT_ID,
      null,
      SESSION_ID,
    );

    // Turn already ended: the session is complete and intentA applies.
    const firstApply = await agent
      .post(`/api/staged-intents/${intentA.id}/apply`)
      .send({});
    expect(firstApply.status).toBe(200);

    // The session wakes (a resume) — its turn goes back in flight, reverting
    // its remaining staged intent (intentB) to incomplete.
    sessionManager.liveSession.hasActiveTurn.mockReturnValue(true);

    const midTurn = await agent
      .post(`/api/staged-intents/${intentB.id}/apply`)
      .send({});
    expect(midTurn.status).toBe(409);
    expect(midTurn.body.error).toMatch(/not yet complete/);

    // The session stops again (turn ends) — intentB is dispositionable again.
    sessionManager.liveSession.hasActiveTurn.mockReturnValue(false);

    const afterStop = await agent
      .post(`/api/staged-intents/${intentB.id}/apply`)
      .send({});
    expect(afterStop.status).toBe(200);
  });
});
