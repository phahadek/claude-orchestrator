/**
 * Readiness-retry cap: bounds how many times a groom session may re-stage a
 * task.setStatus -> Ready that the readiness gate (checkReadiness) rejects
 * for the exact same violation set — see evaluateReadinessRetryCap in
 * stagedIntents.ts. Regression coverage for groom session 27841dfd, which
 * re-staged the same rejected flip 57 times in one turn because each retry
 * opened a fresh group (so routeStageTimeBlock's existing per-group
 * groupRevisionRounds budget never accumulated against it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { stageIntent, routeStageTimeBlock } from '../stagedIntents';
import { recordAccretionMarker } from '../../gate/gateStore';
import { recordAccretionMarker as recordSeedAccretionMarker } from '../../seed/seedStore';

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

/** Each call stages a fresh task.setStatus in its own fresh group, id'd by
 * `attempt` — mirrors the incident: each rejected re-stage opened a new
 * group rather than revising in place, so groupRevisionRounds (keyed by
 * groupId) never engages across attempts. */
function stageReadyAttempt(
  sessionId: string | null,
  taskId: string,
  attempt: number,
) {
  return stageIntent(
    'task.setStatus',
    {
      taskId,
      status: 'Ready',
      groomingGate: wellFormedGroomingGate(),
    },
    'proj-1',
    `group-${taskId}-${attempt}`,
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

describe('readiness-retry cap', () => {
  it('rejects the 3rd consecutive identical-violation task.setStatus stage with a terminal readiness_retry_cap annotation, and a 4th is also refused', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    const taskId = 'notion:retry-cap';
    recordAccretion(taskId);

    const first = stageReadyAttempt('session-cap', taskId, 1);
    const checkedFirst = await routeStageTimeBlock(first, undefined);
    expect(checkedFirst.state).not.toBe('rejected');
    expect(checkedFirst.annotation).toEqual(
      expect.objectContaining({ blocked: true }),
    );

    const second = stageReadyAttempt('session-cap', taskId, 2);
    const checkedSecond = await routeStageTimeBlock(second, undefined);
    expect(checkedSecond.state).not.toBe('rejected');

    const third = stageReadyAttempt('session-cap', taskId, 3);
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

    // A 4th identical attempt is also refused, not reset.
    const fourth = stageReadyAttempt('session-cap', taskId, 4);
    const checkedFourth = await routeStageTimeBlock(fourth, undefined);
    expect(checkedFourth.state).toBe('rejected');
    expect(checkedFourth.annotation).toEqual(
      expect.objectContaining({
        terminalReason: 'readiness_retry_cap',
        attempts: 4,
      }),
    );
  });

  it('resets the counter once the violation set changes (progress)', async () => {
    const taskId = 'notion:retry-progress';
    recordAccretion(taskId);

    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    const first = stageReadyAttempt('session-progress', taskId, 1);
    await routeStageTimeBlock(first, undefined);
    const second = stageReadyAttempt('session-progress', taskId, 2);
    await routeStageTimeBlock(second, undefined);

    // Different violation now (deferral phrase instead of Open Questions) —
    // the hash changes, so this should NOT be the 3rd strike against the
    // old hash.
    mockGetTaskBackend.mockReturnValue(
      makeBackend('The retry policy will be decide during implementation.'),
    );
    const third = stageReadyAttempt('session-progress', taskId, 3);
    const checkedThird = await routeStageTimeBlock(third, undefined);
    expect(checkedThird.state).not.toBe('rejected');

    const fourth = stageReadyAttempt('session-progress', taskId, 4);
    const checkedFourth = await routeStageTimeBlock(fourth, undefined);
    expect(checkedFourth.state).not.toBe('rejected');

    const fifth = stageReadyAttempt('session-progress', taskId, 5);
    const checkedFifth = await routeStageTimeBlock(fifth, undefined);
    expect(checkedFifth.state).toBe('rejected');
  });

  it('resets the counter once a body edit for the task commits', async () => {
    const taskId = 'notion:retry-body-edit-reset';
    recordAccretion(taskId);
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );

    const first = stageReadyAttempt('session-edit', taskId, 1);
    await routeStageTimeBlock(first, undefined);
    const second = stageReadyAttempt('session-edit', taskId, 2);
    await routeStageTimeBlock(second, undefined);

    // A task.updateBody for the same task commits (standalone apply route
    // semantics are exercised indirectly here via the DB helper the route
    // itself calls — see resetReadinessRetryCapOnBodyCommit).
    const { resetReadinessRetryCount } = await import('../../db/queries');
    resetReadinessRetryCount(taskId);

    const third = stageReadyAttempt('session-edit', taskId, 3);
    const checkedThird = await routeStageTimeBlock(third, undefined);
    expect(checkedThird.state).not.toBe('rejected');
  });

  it('keys the cap per session — a new session on the same task starts at zero', async () => {
    const taskId = 'notion:retry-per-session';
    recordAccretion(taskId);
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );

    const first = stageReadyAttempt('session-a', taskId, 1);
    await routeStageTimeBlock(first, undefined);
    const second = stageReadyAttempt('session-a', taskId, 2);
    await routeStageTimeBlock(second, undefined);
    const third = stageReadyAttempt('session-a', taskId, 3);
    const checkedThird = await routeStageTimeBlock(third, undefined);
    expect(checkedThird.state).toBe('rejected');

    // A different session re-staging the same task's identical violation
    // starts its own count at zero.
    const otherFirst = stageReadyAttempt('session-b', taskId, 4);
    const checkedOtherFirst = await routeStageTimeBlock(otherFirst, undefined);
    expect(checkedOtherFirst.state).not.toBe('rejected');
  });

  it('never caps a human-staged intent (no originating session)', async () => {
    const taskId = 'notion:retry-human';
    recordAccretion(taskId);
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );

    for (let attempt = 1; attempt <= 4; attempt++) {
      const intent = stageReadyAttempt(null, taskId, attempt);
      const checked = await routeStageTimeBlock(intent, undefined);
      expect(checked.state).not.toBe('rejected');
    }
  });
});
