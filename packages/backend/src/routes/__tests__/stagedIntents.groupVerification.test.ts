import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetTaskBackend, mockClassifyReadyProposal } = vi.hoisted(() => ({
  mockGetTaskBackend: vi.fn(),
  mockClassifyReadyProposal: vi.fn(),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: mockGetTaskBackend,
}));

vi.mock('../../tasks/deferralClassifier', () => ({
  classifyReadyProposal: mockClassifyReadyProposal,
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
    type: 'yaml' as const,
    updateStatus: vi.fn().mockResolvedValue(undefined),
    setDependsOn: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn().mockResolvedValue(body),
  };
}

function wellFormedGroomingGate() {
  return {
    size_check: { decision: 'n/a' },
    type_check: { decision: 'none' },
    seam_check: { decision: 'n/a' },
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
    reason: 'This task type is exempt from gate accretion.',
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

function stageDependsOn(sessionId: string, groupId: string, taskId: string) {
  return stageIntent(
    'task.setDependsOn',
    { taskId, dependsOn: [] },
    'proj-1',
    groupId,
    sessionId,
  );
}

/** Stages a Ready-flip group that carries every mandatory member — the setDependsOn write included — so it passes both stage-time readiness and group completeness. */
function stageCompleteReadyGroup(sessionId: string, groupId: string) {
  const taskId = `notion:${groupId}`;
  stageDependsOn(sessionId, groupId, taskId);
  return stageBlockedReadyIntent(sessionId, groupId);
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  mockClassifyReadyProposal.mockReset();
  mockClassifyReadyProposal.mockResolvedValue(undefined);
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
});

describe('verifyDispatchedGroupsForSession — group-level verify gate', () => {
  it('surfaces a group that passes verification to the operator', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend('## Summary\nClean.'));
    const intent = stageCompleteReadyGroup('session-1', 'group-pass');

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

  it('invokes classifyReadyProposal with the group id once a Ready-flip group passes verification', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend('## Summary\nClean.'));
    stageCompleteReadyGroup('session-4', 'group-tier3');

    await verifyDispatchedGroupsForSession('session-4');

    expect(mockClassifyReadyProposal).toHaveBeenCalledWith(
      'group-tier3',
      expect.objectContaining({ preCommit: true }),
    );
  });

  it('does not invoke classifyReadyProposal for a group that fails verification', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    stageBlockedReadyIntent('session-5', 'group-tier3-blocked');

    await verifyDispatchedGroupsForSession('session-5');

    expect(mockClassifyReadyProposal).not.toHaveBeenCalled();
  });

  it('blocks a group whose arming intent has no task.setDependsOn write — completeness gap, not surfaced to the operator', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend('## Summary\nClean.'));
    // No stageDependsOn call: the group is missing its mandatory setDependsOn write.
    const intent = stageBlockedReadyIntent('session-7', 'group-no-dependson');

    const outcomes = await verifyDispatchedGroupsForSession('session-7');

    expect(outcomes).toEqual([
      expect.objectContaining({
        groupId: 'group-no-dependson',
        passed: false,
        escalated: false,
      }),
    ]);
    expect(outcomes[0].errors[0]).toContain('task.setDependsOn');

    const app = buildApp();
    const res = await supertest(app).get('/api/staged-intents');
    expect(res.body.intents.map((i: { id: string }) => i.id)).not.toContain(
      intent.id,
    );
  });

  it('blocks a group whose body requires a Manual-verification strip that was never staged — completeness gap, not surfaced to the operator', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend(
        '## Summary\nClean.\n\n### 👁️ Manual verification\n- Check it.\n',
      ),
    );
    const taskId = 'notion:group-no-mv-strip';
    recordAccretion(taskId);
    stageDependsOn('session-8', 'group-no-mv-strip', taskId);
    const intent = stageIntent(
      'task.setStatus',
      {
        taskId,
        status: 'Ready',
        groomingGate: {
          ...wellFormedGroomingGate(),
          hasManualVerificationSection: true,
        },
      },
      'proj-1',
      'group-no-mv-strip',
      'session-8',
    );

    const outcomes = await verifyDispatchedGroupsForSession('session-8');

    expect(outcomes).toEqual([
      expect.objectContaining({
        groupId: 'group-no-mv-strip',
        passed: false,
        escalated: false,
      }),
    ]);
    expect(outcomes[0].errors[0]).toContain('Manual verification');

    const app = buildApp();
    const res = await supertest(app).get('/api/staged-intents');
    expect(res.body.intents.map((i: { id: string }) => i.id)).not.toContain(
      intent.id,
    );
  });

  it('bounds a completeness-only failure to the same MAX_AUTO_REVISE_ROUNDS budget as any other verify failure', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend('## Summary\nClean.'));

    // Round 1 — missing setDependsOn, blocked, not yet escalated.
    stageBlockedReadyIntent('session-9', 'group-completeness-loop');
    const first = await verifyDispatchedGroupsForSession('session-9');
    expect(first[0]).toEqual(
      expect.objectContaining({ passed: false, escalated: false }),
    );

    // Session "revises" by re-staging into the same group — still missing setDependsOn.
    const intent = stageBlockedReadyIntent(
      'session-9',
      'group-completeness-loop',
    );
    const second = await verifyDispatchedGroupsForSession('session-9');
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

  it('surfaces the group and leaves the intent state unchanged even when classifyReadyProposal fails (fail-open)', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend('## Summary\nClean.'));
    mockClassifyReadyProposal.mockRejectedValue(new Error('classifier down'));
    const intent = stageCompleteReadyGroup('session-6', 'group-tier3-fail');

    const outcomes = await verifyDispatchedGroupsForSession('session-6');
    // Let the fire-and-forget classifyReadyProposal().catch(() => {}) settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(outcomes).toEqual([
      expect.objectContaining({
        groupId: 'group-tier3-fail',
        passed: true,
        errors: [],
      }),
    ]);

    const row = db
      .prepare('SELECT state, advisory FROM staged_intent WHERE id = ?')
      .get(intent.id) as { state: string; advisory: string | null };
    expect(row.state).toBe('staged');
    expect(row.advisory).toBeNull();

    const app = buildApp();
    const res = await supertest(app).get('/api/staged-intents');
    expect(res.body.intents.map((i: { id: string }) => i.id)).toContain(
      intent.id,
    );
  });
});

describe('gate.accrete/seed.stage auto-grant on a verified content-match', () => {
  function auditEventsFor(intentId: string) {
    return (
      db
        .prepare(
          "SELECT actor_type, payload FROM audit_log WHERE event_type = 'staged_intent_disposition'",
        )
        .all() as { actor_type: string; payload: string }[]
    ).filter((row) => JSON.parse(row.payload).intentId === intentId);
  }

  it('auto-approves a gate.accrete intent whose accreted items cleanly match the stripped Manual verification section', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend(
        '## Summary\nClean.\n\n### 👁️ Manual verification\n- Check it.\n',
      ),
    );
    const taskId = 'notion:group-gate-auto-approve';
    const groupId = 'group-gate-auto-approve';
    recordAccretion(taskId);
    stageDependsOn('session-auto-1', groupId, taskId);
    stageIntent(
      'task.patchBodySection',
      { taskId, section: '👁️ Manual verification', operation: 'remove' },
      'proj-1',
      groupId,
      'session-auto-1',
    );
    const gateAccrete = stageIntent(
      'gate.accrete',
      {
        sourceTask: {
          id: taskId,
          title: 'A task',
          project: 'proj-1',
          milestone: 'M1',
        },
        items: [{ text: 'Check it.' }],
        classification: 'items',
      },
      'proj-1',
      groupId,
      'session-auto-1',
    );
    stageIntent(
      'task.setStatus',
      {
        taskId,
        status: 'Ready',
        groomingGate: {
          ...wellFormedGroomingGate(),
          hasManualVerificationSection: true,
        },
      },
      'proj-1',
      groupId,
      'session-auto-1',
    );

    const outcomes = await verifyDispatchedGroupsForSession('session-auto-1');
    expect(outcomes).toEqual([
      expect.objectContaining({ groupId, passed: true, errors: [] }),
    ]);

    const row = db
      .prepare('SELECT state, annotation FROM staged_intent WHERE id = ?')
      .get(gateAccrete.id) as { state: string; annotation: string | null };
    expect(row.state).toBe('approved');
    expect(JSON.parse(row.annotation ?? 'null')).toEqual({
      autoApproved: true,
    });

    const events = auditEventsFor(gateAccrete.id);
    expect(events).toHaveLength(1);
    expect(events[0].actor_type).toBe('system');
    expect(JSON.parse(events[0].payload)).toEqual(
      expect.objectContaining({
        intentId: gateAccrete.id,
        disposition: 'auto_approved',
        provenance: 'auto',
      }),
    );
  });

  it('does not auto-approve a gate.accrete intent on a content-match failure — falls back to ordinary operator disposition', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend(
        '## Summary\nClean.\n\n### 👁️ Manual verification\n- Check it.\n',
      ),
    );
    const taskId = 'notion:group-gate-no-auto-approve';
    const groupId = 'group-gate-no-auto-approve';
    stageDependsOn('session-auto-2', groupId, taskId);
    const gateAccrete = stageIntent(
      'gate.accrete',
      {
        sourceTask: {
          id: taskId,
          title: 'A task',
          project: 'proj-1',
          milestone: 'M1',
        },
        items: [{ text: 'Something totally unrelated' }],
        classification: 'items',
      },
      'proj-1',
      groupId,
      'session-auto-2',
    );
    stageIntent(
      'task.setStatus',
      {
        taskId,
        status: 'Ready',
        groomingGate: {
          ...wellFormedGroomingGate(),
          hasManualVerificationSection: true,
        },
      },
      'proj-1',
      groupId,
      'session-auto-2',
    );

    const outcomes = await verifyDispatchedGroupsForSession('session-auto-2');
    expect(outcomes[0]).toEqual(
      expect.objectContaining({ groupId, passed: false }),
    );

    const row = db
      .prepare('SELECT state, annotation FROM staged_intent WHERE id = ?')
      .get(gateAccrete.id) as { state: string; annotation: string | null };
    expect(row.state).not.toBe('approved');
    expect(JSON.parse(row.annotation ?? 'null')).not.toEqual({
      autoApproved: true,
    });
    expect(auditEventsFor(gateAccrete.id)).toHaveLength(0);
  });

  it('does not auto-approve a gate.accrete intent staged with a none/n-a classification — bare-decision path is unaffected', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend(
        '## Summary\nClean.\n\n### 👁️ Manual verification\n- Check it.\n',
      ),
    );
    const taskId = 'notion:group-gate-none';
    const groupId = 'group-gate-none';
    recordAccretion(taskId);
    stageDependsOn('session-auto-3', groupId, taskId);
    stageIntent(
      'task.patchBodySection',
      { taskId, section: '👁️ Manual verification', operation: 'remove' },
      'proj-1',
      groupId,
      'session-auto-3',
    );
    const gateAccrete = stageIntent(
      'gate.accrete',
      {
        sourceTask: {
          id: taskId,
          title: 'A task',
          project: 'proj-1',
          milestone: 'M1',
        },
        items: [],
        classification: 'n/a',
        reason: 'Assessed the change; nothing runtime-observable resulted.',
      },
      'proj-1',
      groupId,
      'session-auto-3',
    );
    stageIntent(
      'task.setStatus',
      {
        taskId,
        status: 'Ready',
        groomingGate: {
          ...wellFormedGroomingGate(),
          hasManualVerificationSection: true,
        },
      },
      'proj-1',
      groupId,
      'session-auto-3',
    );

    const outcomes = await verifyDispatchedGroupsForSession('session-auto-3');
    expect(outcomes[0]).toEqual(
      expect.objectContaining({ groupId, passed: true }),
    );

    const row = db
      .prepare('SELECT state, annotation FROM staged_intent WHERE id = ?')
      .get(gateAccrete.id) as { state: string; annotation: string | null };
    expect(row.state).toBe('staged');
    expect(row.annotation).toBeNull();
    expect(auditEventsFor(gateAccrete.id)).toHaveLength(0);
  });
});
