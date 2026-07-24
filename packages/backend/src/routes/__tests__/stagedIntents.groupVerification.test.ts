import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

// Isolated in-memory db, matching stagedIntents.stageTimeReadiness.test.ts's
// setup — otherwise staged_intent rows persist across test cases and produce
// spurious dedup collisions.
vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import {
  createStagedIntentsRouter,
  stageIntent,
  verifyDispatchedGroupsForSession,
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

function stageBlockedReadyIntent(sessionId: string, groupId: string) {
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

describe('verifyDispatchedGroupsForSession — group-level verify gate', () => {
  it('surfaces a group that passes verification to the operator', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend('## Summary\nClean.'));
    const intent = stageBlockedReadyIntent('session-1', 'group-pass');

    const outcomes = await verifyDispatchedGroupsForSession('session-1');

    expect(outcomes).toEqual([
      expect.objectContaining({
        groupId: 'group-pass',
        passed: true,
        escalated: false,
        errors: [],
      }),
    ]);

    const app = buildApp();
    const res = await supertest(app).get('/api/staged-intents');
    expect(res.body.intents.map((i: { id: string }) => i.id)).toContain(
      intent.id,
    );
  });

  it('hides a group with a verification error from the operator-facing GET and reports the error', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    const intent = stageBlockedReadyIntent('session-2', 'group-fail');

    const outcomes = await verifyDispatchedGroupsForSession('session-2');

    expect(outcomes).toEqual([
      expect.objectContaining({
        groupId: 'group-fail',
        passed: false,
        escalated: false,
      }),
    ]);
    expect(outcomes[0].errors[0]).toContain('Open Questions');

    const app = buildApp();
    const res = await supertest(app).get('/api/staged-intents');
    expect(res.body.intents.map((i: { id: string }) => i.id)).not.toContain(
      intent.id,
    );
  });

  it('bounds the auto-revise loop: escalates to the operator on the 2nd consecutive failure instead of looping forever', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );

    // Round 1 — blocked, not yet escalated, hidden from the operator.
    stageBlockedReadyIntent('session-3', 'group-loop');
    const first = await verifyDispatchedGroupsForSession('session-3');
    expect(first[0]).toEqual(
      expect.objectContaining({ passed: false, escalated: false }),
    );

    // The session "revises" by re-staging into the same group — still fails.
    const intent = stageBlockedReadyIntent('session-3', 'group-loop');
    const second = await verifyDispatchedGroupsForSession('session-3');
    expect(second[0]).toEqual(
      expect.objectContaining({ passed: false, escalated: true }),
    );

    // Escalated — now visible to the operator despite the failure.
    const app = buildApp();
    const res = await supertest(app).get('/api/staged-intents');
    expect(res.body.intents.map((i: { id: string }) => i.id)).toContain(
      intent.id,
    );
  });
});
