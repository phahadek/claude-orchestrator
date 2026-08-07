/**
 * Tests for computeProposedBody / runStageTimeReadyChecks folding an active
 * same-task body patch into the Ready-flip preview even when that patch was
 * staged with no group (or a different group) than the flip itself — see
 * the "body patch staged outside the group is invisible to the Ready-flip
 * preview" fix.
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
import { stageIntent, runStageTimeReadyChecks } from '../stagedIntents';
import { recordAccretionMarker } from '../../gate/gateStore';
import { recordAccretionMarker as recordSeedAccretionMarker } from '../../seed/seedStore';

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

async function stageReadyFlip(
  taskId: string,
  groupId: string,
  groomingGate: unknown = wellFormedGroomingGate(),
) {
  const staged = stageIntent(
    'task.setStatus',
    {
      taskId,
      status: 'Ready',
      groomingGate,
    },
    'proj-1',
    groupId,
  );
  return runStageTimeReadyChecks(staged);
}

beforeEach(() => {
  mockGetTaskBackend.mockReset();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM gate_accretion').run();
  db.prepare('DELETE FROM seed_accretion').run();
});

describe('Ready-flip preview folds same-task body patches staged outside the group', () => {
  it('folds an active ungrouped task.patchBodySection for the same task into the preview', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    recordAccretion('notion:ungrouped-patch');

    // Staged with no groupId at all — the exact shape of the reported bug.
    stageIntent(
      'task.patchBodySection',
      {
        taskId: 'notion:ungrouped-patch',
        section: 'Open Questions',
        operation: 'remove',
      },
      'proj-1',
    );

    const checked = await stageReadyFlip('notion:ungrouped-patch', 'group-1');

    expect(checked.annotation).toBeNull();
  });

  it('folds an active ungrouped task.updateBody for the same task into the preview', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    recordAccretion('notion:ungrouped-updatebody');

    stageIntent(
      'task.updateBody',
      {
        taskId: 'notion:ungrouped-updatebody',
        sections: { Summary: 'Clean rewrite.' },
      },
      'proj-1',
    );

    const checked = await stageReadyFlip(
      'notion:ungrouped-updatebody',
      'group-1',
    );

    expect(checked.annotation).toBeNull();
  });

  it('still folds a same-group task.patchBodySection (regression)', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    recordAccretion('notion:grouped-patch');

    stageIntent(
      'task.patchBodySection',
      {
        taskId: 'notion:grouped-patch',
        section: 'Open Questions',
        operation: 'remove',
      },
      'proj-1',
      'group-1',
    );

    const checked = await stageReadyFlip('notion:grouped-patch', 'group-1');

    expect(checked.annotation).toBeNull();
  });

  it('never folds a same-task-id-looking patch belonging to a different task', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    recordAccretion('notion:target-task');

    stageIntent(
      'task.patchBodySection',
      {
        taskId: 'notion:other-task',
        section: 'Open Questions',
        operation: 'remove',
      },
      'proj-1',
    );

    const checked = await stageReadyFlip('notion:target-task', 'group-1');

    expect(checked.annotation).toBeTruthy();
    expect(checked.annotation && 'violations' in checked.annotation).toBe(
      true,
    );
  });

  it('names an active same-task body patch parked in a different group when the gate blocks', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    const otherGroupPatch = stageIntent(
      'task.patchBodySection',
      {
        taskId: 'notion:cross-group',
        section: 'Open Questions',
        operation: 'remove',
      },
      'proj-1',
      'group-other',
    );

    // Missing filesPathsEntries — the grooming-promotion gate blocks on this
    // before the readiness gate is even reached, even though the flip is
    // grouped (so gate/seed-contribution checks are deferred).
    const checked = await stageReadyFlip('notion:cross-group', 'group-1', {
      size_check: { decision: 'n/a' },
      type_check: { decision: 'none' },
      type: '💻 Code',
    });

    expect(checked.annotation).toBeTruthy();
    const reasons =
      checked.annotation && 'reasons' in checked.annotation
        ? checked.annotation.reasons
        : [];
    expect(
      reasons.some(
        (r) => r.includes(otherGroupPatch.id) && r.includes('not applied'),
      ),
    ).toBe(true);
  });
});
