import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRecordEvent } = vi.hoisted(() => ({ mockRecordEvent: vi.fn() }));

vi.mock('../../audit/AuditLog', () => ({ recordEvent: mockRecordEvent }));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { stageIntent } from '../stagedIntents';
import { StageGuardRejectionError } from '../stageGuard';
import { checkCandidateDispositions } from '../../groom/groomGate';

const TASK = '11111111-1111-1111-1111-111111111111';
const CAND = '22222222-2222-2222-2222-222222222222';
const GROUP = 'group-1';

function stageReady() {
  return stageIntent(
    'task.setStatus',
    {
      taskId: TASK,
      status: 'Ready',
      groomingGate: { dependencyCandidateIds: [CAND] },
    },
    'proj-1',
    GROUP,
    null,
  );
}

function stageDeps(extra: Record<string, unknown>) {
  return stageIntent(
    'task.setDependsOn',
    { taskId: TASK, dependsOn: [], ...extra },
    'proj-1',
    GROUP,
    null,
  );
}

beforeEach(() => {
  mockRecordEvent.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('Ready group dependency candidate dispositions', () => {
  it('rejects a dependency write that omits a candidate, with one audit event', () => {
    stageReady();
    expect(() => stageDeps({})).toThrow(StageGuardRejectionError);
    const guardEvents = mockRecordEvent.mock.calls.filter(
      ([e]) => e.event_type === 'stage_guard_rejected',
    );
    expect(guardEvents).toHaveLength(1);
  });

  it('rejects not-blocking without a reason', () => {
    stageReady();
    expect(() =>
      stageDeps({
        candidateDispositions: [{ taskId: CAND, disposition: 'not-blocking' }],
      }),
    ).toThrow(StageGuardRejectionError);
  });

  it('applies a fully dispositioned group', () => {
    stageReady();
    const intent = stageDeps({
      candidateDispositions: [
        { taskId: CAND, disposition: 'not-blocking', reason: 'soft ordering' },
      ],
    });
    expect(intent.kind).toBe('task.setDependsOn');
  });
});

describe('Ready group with notion:-prefixed stored dependsOn', () => {
  const prefixed = { dependsOn: [`notion:${CAND}`] };

  it('accepts a bare depend disposition, dependsOn staged first', () => {
    stageDeps({
      ...prefixed,
      candidateDispositions: [{ taskId: CAND, disposition: 'depend' }],
    });
    expect(stageReady().kind).toBe('task.setStatus');
  });

  it('accepts a bare depend disposition, Ready staged first', () => {
    stageReady();
    const intent = stageDeps({
      ...prefixed,
      candidateDispositions: [{ taskId: CAND, disposition: 'depend' }],
    });
    expect(intent.kind).toBe('task.setDependsOn');
  });
});

describe('checkCandidateDispositions id forms', () => {
  it('accepts bare candidate, bare disposition, prefixed dependsOn', () => {
    expect(
      checkCandidateDispositions(
        [CAND],
        [{ taskId: CAND, disposition: 'depend' }],
        [`notion:${CAND}`],
      ),
    ).toEqual([]);
  });

  it('accepts bare candidate, prefixed disposition, prefixed dependsOn', () => {
    expect(
      checkCandidateDispositions(
        [CAND],
        [{ taskId: `notion:${CAND}`, disposition: 'depend' }],
        [`notion:${CAND}`],
      ),
    ).toEqual([]);
  });

  it('still rejects a depend disposition absent from dependsOn', () => {
    expect(
      checkCandidateDispositions(
        [CAND],
        [{ taskId: `notion:${CAND}`, disposition: 'depend' }],
        [`notion:${TASK}`],
      ),
    ).toHaveLength(1);
  });
});

describe('checkCandidateDispositions', () => {
  it('is clear when there are no candidates', () => {
    expect(checkCandidateDispositions(undefined, undefined, [])).toEqual([]);
  });

  it('requires a depend disposition to appear in dependsOn', () => {
    expect(
      checkCandidateDispositions(
        [CAND],
        [{ taskId: CAND, disposition: 'depend' }],
        [],
      ),
    ).toHaveLength(1);
  });
});
