/**
 * Readiness-retry cap: bounds how many times a groom session may re-stage a
 * task.setStatus -> Ready that the readiness gate (checkReadiness) rejects
 * for the exact same violation set — see evaluateReadinessRetryCap in
 * stagedIntents.ts. Regression coverage for groom session 27841dfd, which
 * re-staged the same rejected flip 57 times in one turn because each retry
 * opened a fresh group (so routeStageTimeBlock's existing per-group
 * groupRevisionRounds budget never accumulated against it) — this cap is
 * keyed by (sessionId, taskId) instead, independent of grouping.
 *
 * The end-to-end test below re-stages into the SAME group each round (the
 * same shape stagedIntents.stageTimeRedrive.test.ts already exercises for
 * routeStageTimeBlock's own per-group budget) rather than a fresh group per
 * round: a fresh group per round is only reachable once the prior round's
 * blocked intent has already been withdrawn/superseded to a terminal state
 * (per the incident record), which this cap does not require to engage —
 * same-group re-staging alone is already enough to prove the new cap catches
 * what the old per-group budget cannot. The narrower counter-arithmetic
 * assertions (resets on progress / on a body-edit commit / per-session
 * keying) are tested directly against the persisted counter functions
 * (recordReadinessRetryAttempt / resetReadinessRetryCount), which is what
 * they actually describe.
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
import {
  createStagedIntentsRouter,
  stageIntent,
  routeStageTimeBlock,
} from '../stagedIntents';
import {
  recordReadinessRetryAttempt,
  resetReadinessRetryCount,
} from '../../db/queries';
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
    patchBodySection: vi.fn().mockResolvedValue(undefined),
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

/**
 * Re-stages the identical task.setStatus payload into the SAME group each
 * call — stageIntent's own dedup (findActiveStagedIntentForTask) transparently
 * decides whether the prior round's row is still active (returns it as-is) or
 * already hidden in needs_revision (creates a fresh row), exactly mirroring
 * what a groom session re-staging an unrevised flip produces in practice.
 */
function stageReadyAttempt(
  sessionId: string | null,
  taskId: string,
  groupId: string,
) {
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
  db.prepare('DELETE FROM readiness_retry_counts').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('readiness-retry cap — end to end (stageIntent + routeStageTimeBlock)', () => {
  it('rejects the 3rd consecutive identical-violation task.setStatus stage with a terminal readiness_retry_cap annotation, and a 4th is also refused', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    const taskId = 'notion:retry-cap';
    const groupId = 'group-retry-cap';
    recordAccretion(taskId);

    const first = stageReadyAttempt('session-cap', taskId, groupId);
    const checkedFirst = await routeStageTimeBlock(first, undefined);
    expect(checkedFirst.state).not.toBe('rejected');

    const second = stageReadyAttempt('session-cap', taskId, groupId);
    const checkedSecond = await routeStageTimeBlock(second, undefined);
    expect(checkedSecond.state).not.toBe('rejected');

    const third = stageReadyAttempt('session-cap', taskId, groupId);
    const checkedThird = await routeStageTimeBlock(third, undefined);
    expect(checkedThird.state).toBe('rejected');
    expect(checkedThird.annotation).toEqual(
      expect.objectContaining({
        blocked: true,
        terminalReason: 'readiness_retry_cap',
        attempts: 3,
      }),
    );

    const auditRows = db
      .prepare(`SELECT * FROM audit_log WHERE event_type = ?`)
      .all('groom_readiness_retry_capped') as { task_id: string }[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].task_id).toBe(taskId);

    const fourth = stageReadyAttempt('session-cap', taskId, groupId);
    const checkedFourth = await routeStageTimeBlock(fourth, undefined);
    expect(checkedFourth.state).toBe('rejected');
    expect(checkedFourth.annotation).toEqual(
      expect.objectContaining({
        terminalReason: 'readiness_retry_cap',
        attempts: 4,
      }),
    );
  });

  it('leaves the terminal row queryable via the decision-surface GET route with its readiness_retry_cap annotation intact', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    const taskId = 'notion:retry-cap-http';
    const groupId = 'group-retry-cap-http';
    recordAccretion(taskId);

    await routeStageTimeBlock(
      stageReadyAttempt('session-http', taskId, groupId),
      undefined,
    );
    await routeStageTimeBlock(
      stageReadyAttempt('session-http', taskId, groupId),
      undefined,
    );
    const checkedThird = await routeStageTimeBlock(
      stageReadyAttempt('session-http', taskId, groupId),
      undefined,
    );
    expect(checkedThird.state).toBe('rejected');

    const row = db
      .prepare(`SELECT * FROM staged_intent WHERE id = ?`)
      .get(checkedThird.id) as { annotation: string; state: string };
    const annotation = JSON.parse(row.annotation);
    expect(row.state).toBe('rejected');
    expect(annotation.terminalReason).toBe('readiness_retry_cap');

    const app = buildApp();
    const res = await supertest(app)
      .get('/api/staged-intents')
      .query({ sessionId: 'session-http' });
    expect(res.status).toBe(200);
  });
});

describe('readiness-retry cap — counter semantics (recordReadinessRetryAttempt / resetReadinessRetryCount)', () => {
  it('resets the counter once the violation set changes (progress)', () => {
    const sessionId = 'session-progress';
    const taskId = 'notion:retry-progress';

    expect(recordReadinessRetryAttempt(sessionId, taskId, 'hash-a', 1)).toBe(1);
    expect(recordReadinessRetryAttempt(sessionId, taskId, 'hash-a', 2)).toBe(2);
    // A different violation set (one violation fixed) hashes differently —
    // the counter resets to 1 rather than continuing to 3.
    expect(recordReadinessRetryAttempt(sessionId, taskId, 'hash-b', 3)).toBe(1);
    expect(recordReadinessRetryAttempt(sessionId, taskId, 'hash-b', 4)).toBe(2);
    expect(recordReadinessRetryAttempt(sessionId, taskId, 'hash-b', 5)).toBe(3);
  });

  it('resets the counter once a body edit for the task commits', () => {
    const sessionId = 'session-edit';
    const taskId = 'notion:retry-body-edit-reset';

    expect(recordReadinessRetryAttempt(sessionId, taskId, 'hash-a', 1)).toBe(1);
    expect(recordReadinessRetryAttempt(sessionId, taskId, 'hash-a', 2)).toBe(2);

    resetReadinessRetryCount(taskId);

    // Even the exact same violations_hash starts back at 1 post-reset.
    expect(recordReadinessRetryAttempt(sessionId, taskId, 'hash-a', 3)).toBe(1);
  });

  it('clears every session tracking the task, not just the one that committed the edit', () => {
    const taskId = 'notion:retry-body-edit-reset-multi-session';
    recordReadinessRetryAttempt('session-x', taskId, 'hash-a', 1);
    recordReadinessRetryAttempt('session-x', taskId, 'hash-a', 2);
    recordReadinessRetryAttempt('session-y', taskId, 'hash-a', 1);
    recordReadinessRetryAttempt('session-y', taskId, 'hash-a', 2);

    resetReadinessRetryCount(taskId);

    expect(recordReadinessRetryAttempt('session-x', taskId, 'hash-a', 3)).toBe(
      1,
    );
    expect(recordReadinessRetryAttempt('session-y', taskId, 'hash-a', 3)).toBe(
      1,
    );
  });

  it('keys the cap per session — a new session on the same task starts at zero', () => {
    const taskId = 'notion:retry-per-session';

    expect(recordReadinessRetryAttempt('session-a', taskId, 'hash-a', 1)).toBe(
      1,
    );
    expect(recordReadinessRetryAttempt('session-a', taskId, 'hash-a', 2)).toBe(
      2,
    );
    expect(recordReadinessRetryAttempt('session-a', taskId, 'hash-a', 3)).toBe(
      3,
    );

    // A different session re-staging the exact same violation set on the
    // same task starts its own count at 1, unaffected by session-a's count.
    expect(recordReadinessRetryAttempt('session-b', taskId, 'hash-a', 4)).toBe(
      1,
    );
  });
});

describe('readiness-retry cap — never caps a human-staged intent (no originating session)', () => {
  it('routeStageTimeBlock never terminates a session-less stage regardless of repeated identical violations', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    const taskId = 'notion:retry-human';
    const groupId = 'group-retry-human';
    recordAccretion(taskId);

    for (let attempt = 1; attempt <= 4; attempt++) {
      const intent = stageReadyAttempt(null, taskId, groupId);
      const checked = await routeStageTimeBlock(intent, undefined);
      expect(checked.state).not.toBe('rejected');
    }

    const auditRows = db
      .prepare(`SELECT * FROM audit_log WHERE event_type = ?`)
      .all('groom_readiness_retry_capped');
    expect(auditRows).toHaveLength(0);
  });
});
