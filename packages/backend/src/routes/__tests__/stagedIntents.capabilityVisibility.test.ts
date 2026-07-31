/**
 * A session.requestCapability intent reaches the decision surface only once
 * its staging session has parked awaiting the disposition — not while its
 * turn is still in flight (task 3ae22f9152f38152a4a2cc4de293f2af). Staging
 * itself is never delayed or refused on account of turn state: the row is
 * written immediately, and becomes visible on every list lens once the
 * session's turn ends, without being re-staged. Visibility is derived from
 * the same per-session turn-completeness signal
 * (db/queries.ts#isSessionComplete) the sibling task
 * (3ae22f9152f381a39a34eb3f4cc1efbb) gates disposition on — no second
 * implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createStagedIntentsRouter, stageIntent } from '../stagedIntents';

const PROJECT_ID = 'proj-capability-visibility';
const SESSION_ID = 'sess-capability-visibility-1';

function makeSessionManager(hasActiveTurn: boolean) {
  const sm = new EventEmitter();
  const liveSession = { hasActiveTurn: vi.fn(() => hasActiveTurn) };
  return Object.assign(sm, {
    getLiveSession: vi.fn().mockReturnValue(liveSession),
    grantCapability: vi.fn().mockReturnValue([]),
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
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

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('session.requestCapability decision-surface visibility', () => {
  it('is staged immediately while the turn is in flight, but hidden from the project lens until the session parks', async () => {
    const sessionManager = makeSessionManager(true);
    const app = makeApp(sessionManager);
    const agent = supertest(app);

    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(psql:*)',
        plan: 'inspect prod row counts',
        evidence: 'task asks for a row-count audit',
      },
      PROJECT_ID,
      null,
      SESSION_ID,
    );
    // Staging itself is never delayed/refused on turn state — the row exists now.
    expect(intent.state).toBe('staged');

    const whileInFlight = await agent.get(
      `/api/staged-intents?projectId=${PROJECT_ID}`,
    );
    expect(whileInFlight.body.intents).toHaveLength(0);

    // Session parks: turn ends, no re-staging.
    sessionManager.liveSession.hasActiveTurn.mockReturnValue(false);

    const afterPark = await agent.get(
      `/api/staged-intents?projectId=${PROJECT_ID}`,
    );
    expect(afterPark.body.intents).toHaveLength(1);
    expect(afterPark.body.intents[0].id).toBe(intent.id);
  });

  it('is also hidden from the session-scoped lens while the turn is in flight', async () => {
    const sessionManager = makeSessionManager(true);
    const app = makeApp(sessionManager);
    const agent = supertest(app);

    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(psql:*)',
        plan: 'inspect prod row counts',
        evidence: 'task asks for a row-count audit',
      },
      PROJECT_ID,
      null,
      SESSION_ID,
    );

    const whileInFlight = await agent.get(
      `/api/staged-intents?sessionId=${SESSION_ID}`,
    );
    expect(whileInFlight.body.intents).toHaveLength(0);

    sessionManager.liveSession.hasActiveTurn.mockReturnValue(false);

    const afterPark = await agent.get(
      `/api/staged-intents?sessionId=${SESSION_ID}`,
    );
    expect(afterPark.body.intents.map((i: { id: string }) => i.id)).toEqual([
      intent.id,
    ]);
  });

  it('does not affect visibility of other intent kinds', async () => {
    const sessionManager = makeSessionManager(true);
    const app = makeApp(sessionManager);
    const agent = supertest(app);

    stageIntent(
      'task.setProperties',
      { taskId: 'task-a', patch: { priority: 'High' } },
      PROJECT_ID,
      null,
      SESSION_ID,
    );

    const res = await agent.get(`/api/staged-intents?projectId=${PROJECT_ID}`);
    expect(res.body.intents).toHaveLength(1);
  });

  it('once visible, approving grants exactly the requested capability and resumes the session with the existing audit event', async () => {
    const sessionManager = makeSessionManager(true);
    const app = makeApp(sessionManager);
    const agent = supertest(app);

    const intent = stageIntent(
      'session.requestCapability',
      {
        capability: 'Bash(psql:*)',
        plan: 'inspect prod row counts',
        evidence: 'task asks for a row-count audit',
      },
      PROJECT_ID,
      null,
      SESSION_ID,
    );

    // Hidden while the turn is in flight.
    let list = await agent.get(`/api/staged-intents?projectId=${PROJECT_ID}`);
    expect(list.body.intents).toHaveLength(0);

    // The session parks.
    sessionManager.liveSession.hasActiveTurn.mockReturnValue(false);
    list = await agent.get(`/api/staged-intents?projectId=${PROJECT_ID}`);
    expect(list.body.intents).toHaveLength(1);

    const res = await agent.post(`/api/staged-intents/${intent.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('committed');
    expect(sessionManager.grantCapability).toHaveBeenCalledWith(
      SESSION_ID,
      'Bash(psql:*)',
    );
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [sessionId, source, message] =
      sessionManager.enqueueFeedback.mock.calls[0];
    expect(sessionId).toBe(SESSION_ID);
    expect(source).toBe('operator-disposition');
    expect(message).toMatch(/approved/i);
  });
});
