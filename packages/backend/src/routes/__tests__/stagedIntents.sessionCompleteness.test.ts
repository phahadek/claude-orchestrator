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
import {
  insertSession,
  isSessionComplete,
  transitionStagedIntent,
} from '../../db/queries';
import {
  createStagedIntentsRouter,
  stageIntent,
  setStagedIntentBroadcast,
} from '../stagedIntents';
import type { ServerMessage } from '../../ws/types';

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

function seedSession(
  sessionId: string,
  status: string = 'running',
  archived = 0,
) {
  insertSession({
    session_id: sessionId,
    task_id: null,
    task_url: null,
    project_context_url: null,
    status,
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
  if (archived) {
    db.prepare('UPDATE sessions SET archived = 1 WHERE session_id = ?').run(
      sessionId,
    );
  }
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockGetTaskBackend.mockReturnValue({
    type: 'notion',
    setProperties: vi.fn().mockResolvedValue(undefined),
  });
  setStagedIntentBroadcast(() => {});
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

describe('isSessionComplete — group scoping and session lifecycle', () => {
  it('is not blocked by a needs_revision intent parked in a different group of the same session', () => {
    seedSession(SESSION_ID, 'running');
    const groupA = 'group-a';
    const groupB = 'group-b';
    const blocked = stageIntent(
      'task.setProperties',
      { taskId: 'task-a', patch: { priority: 'High' } },
      PROJECT_ID,
      groupA,
      SESSION_ID,
    );
    transitionStagedIntent(blocked.id, 'needs_revision');
    stageIntent(
      'task.setProperties',
      { taskId: 'task-b', patch: { priority: 'Low' } },
      PROJECT_ID,
      groupB,
      SESSION_ID,
    );

    expect(isSessionComplete(SESSION_ID, false, groupB)).toBe(true);
  });

  it('still reads incomplete when the blocked intent belongs to the group under evaluation', () => {
    seedSession(SESSION_ID, 'running');
    const groupA = 'group-a';
    const blocked = stageIntent(
      'task.setProperties',
      { taskId: 'task-a', patch: { priority: 'High' } },
      PROJECT_ID,
      groupA,
      SESSION_ID,
    );
    transitionStagedIntent(blocked.id, 'needs_revision');
    stageIntent(
      'task.setProperties',
      { taskId: 'task-b', patch: { priority: 'Low' } },
      PROJECT_ID,
      groupA,
      SESSION_ID,
    );

    expect(isSessionComplete(SESSION_ID, false, groupA)).toBe(false);
  });

  it.each(['done', 'error', 'killed'])(
    'resolves complete for a terminal (%s) session despite a stale blocked intent',
    (status) => {
      seedSession(SESSION_ID, status);
      const groupA = 'group-a';
      const blocked = stageIntent(
        'task.setProperties',
        { taskId: 'task-a', patch: { priority: 'High' } },
        PROJECT_ID,
        groupA,
        SESSION_ID,
      );
      transitionStagedIntent(blocked.id, 'needs_revision');

      expect(isSessionComplete(SESSION_ID, false, groupA)).toBe(true);
      expect(isSessionComplete(SESSION_ID, false)).toBe(true);
    },
  );

  it('resolves complete for an archived session regardless of its status value', () => {
    seedSession(SESSION_ID, 'running', 1);
    const groupA = 'group-a';
    const blocked = stageIntent(
      'task.setProperties',
      { taskId: 'task-a', patch: { priority: 'High' } },
      PROJECT_ID,
      groupA,
      SESSION_ID,
    );
    transitionStagedIntent(blocked.id, 'needs_revision');

    expect(isSessionComplete(SESSION_ID, false, groupA)).toBe(true);
  });
});

describe('commitGroupIntents — agrees with computeGroupBlockedSignals on group scoping', () => {
  it('commits a group whose owning session left a stale blocked intent behind in a sibling group (regression fixture)', async () => {
    seedSession(SESSION_ID, 'done');
    const sessionManager = makeSessionManager(false);
    const app = makeApp(sessionManager);
    const agent = supertest(app);

    const groupA = 'groom-latency-jitter-3d022f91';
    const groupB = 'groom-3d022f91-latency-jitter';

    const staleBlocked = stageIntent(
      'task.setProperties',
      { taskId: 'task-a', patch: { priority: 'High' } },
      PROJECT_ID,
      groupA,
      SESSION_ID,
    );
    transitionStagedIntent(staleBlocked.id, 'needs_revision');

    const activeInB = stageIntent(
      'task.setProperties',
      { taskId: 'task-b', patch: { priority: 'Low' } },
      PROJECT_ID,
      groupB,
      SESSION_ID,
    );
    transitionStagedIntent(activeInB.id, 'approved');

    // GET listing (rowToApi/computeGroupBlockedSignals) must agree with the
    // commit route: neither refuses group B over group A's stale blocker.
    const listing = await agent
      .get('/api/staged-intents')
      .query({ projectId: PROJECT_ID });
    const bIntent = listing.body.intents.find(
      (i: { id: string }) => i.id === activeInB.id,
    );
    expect(bIntent.groupBlocked).toBe(false);

    const commit = await agent
      .post(`/api/staged-intents/group/${groupB}/commit`)
      .send({});
    expect(commit.status).toBe(200);
  });
});

/**
 * The termination gap this task closes: sessionComplete is denormalised onto
 * every staged intent at serialisation time, and only one thing corrects a
 * connected client's stale copy — the turn-boundary listener riding
 * session_event/'result'. A session that's killed, crashes, or errors out
 * mid-turn never emits a 'result', so without a dedicated session-level
 * signal its already-staged intents stay suppressed on a live client
 * indefinitely. These tests exercise the broadcast wiring
 * createStagedIntentsRouter installs on the SessionManager 'message' stream.
 */
describe('session_completeness broadcast — the termination-gap fix', () => {
  it.each(['done', 'error', 'killed'])(
    'broadcasts complete:true when a session reaches a terminal (%s) status without ever emitting a result event',
    async (status) => {
      seedSession(SESSION_ID, 'running');
      const sessionManager = makeSessionManager(false);
      makeApp(sessionManager);
      stageIntent(
        'task.setProperties',
        { taskId: 'task-a', patch: { priority: 'High' } },
        PROJECT_ID,
        null,
        SESSION_ID,
      );

      const broadcast = vi.fn();
      setStagedIntentBroadcast(broadcast);

      // Mirrors production: SessionManager writes the terminal status to the
      // row before emitting the status transition on its 'message' stream.
      db.prepare('UPDATE sessions SET status = ? WHERE session_id = ?').run(
        status,
        SESSION_ID,
      );
      sessionManager.emit('message', {
        type: 'session_status',
        sessionId: SESSION_ID,
        status,
      } as ServerMessage);

      expect(broadcast).toHaveBeenCalledWith({
        type: 'session_completeness',
        sessionId: SESSION_ID,
        complete: true,
      });
    },
  );

  it('broadcasts complete:true on session_ended, independent of session_status', async () => {
    seedSession(SESSION_ID, 'running');
    const sessionManager = makeSessionManager(false);
    makeApp(sessionManager);

    db.prepare('UPDATE sessions SET status = ? WHERE session_id = ?').run(
      'killed',
      SESSION_ID,
    );

    const broadcast = vi.fn();
    setStagedIntentBroadcast(broadcast);

    sessionManager.emit('message', {
      type: 'session_ended',
      sessionId: SESSION_ID,
      status: 'killed',
    } as ServerMessage);

    expect(broadcast).toHaveBeenCalledWith({
      type: 'session_completeness',
      sessionId: SESSION_ID,
      complete: true,
    });
  });

  it('broadcasts complete:true on a clean turn-ending result, exactly as today', async () => {
    seedSession(SESSION_ID, 'running');
    const sessionManager = makeSessionManager(false);
    makeApp(sessionManager);
    stageIntent(
      'task.setProperties',
      { taskId: 'task-a', patch: { priority: 'High' } },
      PROJECT_ID,
      null,
      SESSION_ID,
    );

    const broadcast = vi.fn();
    setStagedIntentBroadcast(broadcast);

    sessionManager.emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'result',
      content: '',
    } as ServerMessage);

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_completeness',
        sessionId: SESSION_ID,
        complete: true,
      }),
    );
  });

  it('does not broadcast session_completeness for a non-terminal status transition (e.g. still running)', () => {
    seedSession(SESSION_ID, 'running');
    const sessionManager = makeSessionManager(true);
    makeApp(sessionManager);

    const broadcast = vi.fn();
    setStagedIntentBroadcast(broadcast);

    sessionManager.emit('message', {
      type: 'session_status',
      sessionId: SESSION_ID,
      status: 'running',
    } as ServerMessage);

    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_completeness' }),
    );
  });
});
