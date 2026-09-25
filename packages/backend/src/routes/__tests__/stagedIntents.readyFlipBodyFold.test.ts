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

  it('folds BOTH a same-group task.updateBody and a same-group task.patchBodySection into the preview — replay shape of groom-3db22f91-xdist-crash: a task.updateBody rewriting the body (which still leaves a deferral phrase in its Context) coexisting with a task.patchBodySection that fixes that phrase must not have the patch silently dropped just because a sibling task.updateBody also targets the task (task.updateBody replacing the whole body used to make computeProposedBody pick ONE of the two live body-edit intents and ignore the other outright)', async () => {
    mockGetTaskBackend.mockReturnValue(makeBackend('## Summary\nOld.\n'));
    recordAccretion('notion:updatebody-plus-patch');

    // Rewrites the whole body via the fixed TaskBodySections schema — its
    // Context still carries an unresolved deferral phrase (Tier 2), which
    // needs a follow-up patch rather than a second updateBody to fix.
    stageIntent(
      'task.updateBody',
      {
        taskId: 'notion:updatebody-plus-patch',
        sections: {
          summary: 'Clean rewrite.',
          dependencies: [],
          context: [
            {
              type: 'paragraph',
              text: 'The retry policy will be decide during implementation.',
            },
          ],
          automatedCriteria: ['Covers the retry path.'],
          manualCriteria: [],
        },
      },
      'proj-1',
      'group-1',
    );
    // Fixes the deferral phrase the updateBody's own Context still carries —
    // this is the intent the pre-fix code silently dropped from the preview
    // whenever a sibling task.updateBody for the same task was also live.
    stageIntent(
      'task.patchBodySection',
      {
        taskId: 'notion:updatebody-plus-patch',
        section: 'Context',
        operation: 'replace',
        find: 'The retry policy will be decide during implementation.',
        replaceWith: 'The retry policy is exponential backoff, capped at 30s.',
      },
      'proj-1',
      'group-1',
    );

    const checked = await stageReadyFlip(
      'notion:updatebody-plus-patch',
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
    expect(checked.annotation && 'violations' in checked.annotation).toBe(true);
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
      seam_check: { decision: 'n/a' },
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

describe('computeProposedBody surfaces non-composing patches instead of silently discarding them', () => {
  it('names an ungrouped non-composing patch (find-text absent) in the blocked reason while a composing sibling still applies', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    recordAccretion('notion:mixed-ungrouped');

    // Composes cleanly.
    stageIntent(
      'task.patchBodySection',
      {
        taskId: 'notion:mixed-ungrouped',
        section: 'Open Questions',
        operation: 'append',
        content: '- a new question',
      },
      'proj-1',
    );
    // Does not compose: find-text is not present in the section.
    const nonComposing = stageIntent(
      'task.patchBodySection',
      {
        taskId: 'notion:mixed-ungrouped',
        section: 'Open Questions',
        operation: 'replace',
        find: 'text that is not there',
        replaceWith: 'replacement',
      },
      'proj-1',
    );

    const checked = await stageReadyFlip('notion:mixed-ungrouped', 'group-1');

    expect(checked.annotation).toBeTruthy();
    const reasons =
      checked.annotation && 'reasons' in checked.annotation
        ? checked.annotation.reasons
        : [];
    expect(
      reasons.some(
        (r) => r.includes(nonComposing.id) && r.includes('did not compose'),
      ),
    ).toBe(true);
  });

  it('names a grouped non-composing patch (missing target section) in the blocked reason for the Ready flip it shares a group with', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend('## Open Questions\n- Still unresolved?\n'),
    );
    recordAccretion('notion:mixed-grouped');

    const nonComposing = stageIntent(
      'task.patchBodySection',
      {
        taskId: 'notion:mixed-grouped',
        section: 'Nonexistent Section',
        operation: 'remove',
      },
      'proj-1',
      'group-1',
    );

    const checked = await stageReadyFlip('notion:mixed-grouped', 'group-1');

    expect(checked.annotation).toBeTruthy();
    const reasons =
      checked.annotation && 'reasons' in checked.annotation
        ? checked.annotation.reasons
        : [];
    expect(
      reasons.some(
        (r) => r.includes(nonComposing.id) && r.includes('did not compose'),
      ),
    ).toBe(true);
  });
});

describe('a same-group replace patch that inserts a missing required section lets the Ready flip pass', () => {
  function investigationGroomingGate() {
    return {
      size_check: { decision: 'n/a' },
      type_check: { decision: 'n/a' },
      seam_check: { decision: 'n/a' },
      type: '🔎 Investigation',
      triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
    };
  }

  it('a same-group Context decision-branch-list patch makes checkInvestigationDecisionBranchStructure pass without a committed Notion write', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend(
        '## Deliverables\n- Investigation report\n\n## Context\nSome background with no enumerated branches.\n',
      ),
    );

    stageIntent(
      'task.patchBodySection',
      {
        taskId: 'notion:investigation-context-branches',
        section: 'Context',
        operation: 'append',
        content:
          '- If the retry storm is caused by X, then file a Code fix.\n' +
          '- If it is caused by Y, then file an Operational task.',
      },
      'proj-1',
      'group-1',
    );

    const checked = await stageReadyFlip(
      'notion:investigation-context-branches',
      'group-1',
      investigationGroomingGate(),
    );

    expect(checked.annotation).toBeNull();
  });

  function operationalGroomingGate() {
    return {
      size_check: { decision: 'n/a' },
      type_check: { decision: 'n/a' },
      seam_check: { decision: 'n/a' },
      type: '🔧 Operational',
      triage: { proposedVerdict: 'clean', hasOpenQuestionsHeading: true },
    };
  }

  it('a same-group replace patch that inserts a missing "Manual verification" section makes checkOperationalReconcileCapture pass without a committed Notion write', async () => {
    mockGetTaskBackend.mockReturnValue(
      makeBackend(
        '## Targets / surfaces affected\n- prod worker config\n\n## Context\nBackground.\n',
      ),
    );

    // The stored page has no "Manual verification" heading at all — replace
    // against a missing heading must insert it (rather than no-op) for this
    // patch's reconcile-and-capture language to reach the readiness scan.
    stageIntent(
      'task.patchBodySection',
      {
        taskId: 'notion:operational-reconcile-capture',
        section: 'Manual verification',
        operation: 'replace',
        find: 'placeholder',
        replaceWith:
          'Reconcile the worker state against the new config and capture confirmation the change landed.',
      },
      'proj-1',
      'group-1',
    );

    const checked = await stageReadyFlip(
      'notion:operational-reconcile-capture',
      'group-1',
      operationalGroomingGate(),
    );

    expect(checked.annotation).toBeNull();
  });
});
