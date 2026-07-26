/**
 * Stage-time redrive: a {blocked:true} annotation from runStageTimeReadyChecks
 * used to be returned only in the response to the staging call itself, never
 * routed to the originating session, and the blocked intent sat visible to
 * the operator (state='staged') until the next turn-park. routeStageTimeBlock
 * closes both gaps in-turn: it routes the block to the session via
 * enqueueFeedback immediately, and hides the intent from the operator
 * (needs_revision) while within the MAX_AUTO_REVISE_ROUNDS budget — mirroring
 * verifyGroup's turn-park behavior, just fired at stage time instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import type { SessionManager } from '../../session/SessionManager';

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
import {
  createStagedIntentsRouter,
  stageIntent,
  routeStageTimeBlock,
} from '../stagedIntents';
import { recordAccretionMarker } from '../../gate/gateStore';
import { recordAccretionMarker as recordSeedAccretionMarker } from '../../seed/seedStore';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

function makeBackend(body: string) {
  return {
    type: 'local' as const,
    updateStatus: vi.fn().mockResolvedValue(undefined),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn().mockResolvedValue(body),
  };
}

function makeSessionManager() {
  return {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionManager & {
    enqueueFeedback: ReturnType<typeof vi.fn>;
  };
}

function wellFormedGroomingGate() {
  return {
    size_check: { decision: 'n/a' },
    type_check: { decision: 'none' },
    type: '💻 Code',
    filesPathsEntries: [
      {
        raw: 'packages/backend/src/foo.ts',
        isNew: true,
        existsInRepo: false,
      },
    ],
  };
}

function recordAccretion(taskId: string) {
  recordAccretionMarker({
    sourceTaskId: taskId,
    project: 'polimarket-analyser',
    milestone: 'M12',
    decision: 'n/a',
    accretedAt: new Date(0).toISOString(),
  });
  recordSeedAccretionMarker({
    sourceTaskId: taskId,
    project: 'polimarket-analyser',
    milestone: 'M12',
    decision: 'n/a',
    accretedAt: new Date(0).toISOString(),
  });
}

function stageReadyIntent(sessionId: string | null, groupId: string) {
  const taskId = `notion:${groupId}`;
  recordAccretion(taskId);
  return stageIntent(
    'task.setStatus',
    {
      taskId,
      status: 'Ready',
      groomingGate: wellFormedGroomingGate(),
    },
    'proj-1',
    groupId,
    sessionId,
  );
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
});

describe('routeStageTimeBlock — stage-time redrive', () => {
  it('routes a stage-time blocked annotation to the originating session via enqueueFeedback', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    const sessionManager = makeSessionManager();
    const intent = stageReadyIntent('session-1', 'group-1');

    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.annotation).toEqual(
      expect.objectContaining({ blocked: true }),
    );
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const [sessionId, source, message] =
      sessionManager.enqueueFeedback.mock.calls[0];
    expect(sessionId).toBe('session-1');
    expect(source).toBe('verification-error');
    expect(message).toContain('Open Questions');
  });

  it('hides a blocked intent from the operator (needs_revision) while within the auto-revise budget, then surfaces it once escalated', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    const sessionManager = makeSessionManager();
    const app = buildApp();

    // Round 1 — blocked, hidden from the operator, fed back to the session.
    const first = stageReadyIntent('session-2', 'group-loop');
    const checkedFirst = await routeStageTimeBlock(first, sessionManager);
    expect(checkedFirst.state).toBe('needs_revision');

    const resAfterFirst = await supertest(app).get('/api/staged-intents');
    expect(
      resAfterFirst.body.intents.map((i: { id: string }) => i.id),
    ).not.toContain(first.id);
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);

    // The session "revises" by re-staging into the same group — still fails,
    // which hits the MAX_AUTO_REVISE_ROUNDS cap.
    const second = stageReadyIntent('session-2', 'group-loop');
    const checkedSecond = await routeStageTimeBlock(second, sessionManager);
    expect(checkedSecond.state).toBe('staged');

    // Escalated — no further feedback sent, and now visible to the operator.
    expect(sessionManager.enqueueFeedback).toHaveBeenCalledTimes(1);
    const resAfterSecond = await supertest(app).get('/api/staged-intents');
    expect(
      resAfterSecond.body.intents.map((i: { id: string }) => i.id),
    ).toContain(second.id);
  });

  it('surfaces a clean re-stage into the same group normally (state stays staged, no feedback sent)', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend('## Summary\nClean.'));
    const sessionManager = makeSessionManager();
    const app = buildApp();

    const intent = stageReadyIntent('session-3', 'group-clean');
    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.annotation).toBeFalsy();
    expect(checked.state).toBe('staged');
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();

    const res = await supertest(app).get('/api/staged-intents');
    expect(res.body.intents.map((i: { id: string }) => i.id)).toContain(
      intent.id,
    );
  });

  it('does not hide or route a stage-time block for a human-staged intent (no originating session)', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    const sessionManager = makeSessionManager();
    const app = buildApp();

    const intent = stageReadyIntent(null, 'group-human');
    const checked = await routeStageTimeBlock(intent, sessionManager);

    expect(checked.annotation).toEqual(
      expect.objectContaining({ blocked: true }),
    );
    expect(checked.state).toBe('staged');
    expect(sessionManager.enqueueFeedback).not.toHaveBeenCalled();

    const res = await supertest(app).get('/api/staged-intents');
    expect(res.body.intents.map((i: { id: string }) => i.id)).toContain(
      intent.id,
    );
  });
});
