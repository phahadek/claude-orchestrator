/**
 * Tests for the milestone decision-inbox's unblock-impact ranking
 * (packages/backend/src/convergence/decisionRanking.ts).
 *
 * AC: blocking-axis membership outranks kind/direction, which outranks
 * needs-attention boosts — a flat list, no separate partition — and the
 * "rank by distance reduction" anti-pattern (a setStatus->Ready doesn't
 * itself change ranking beyond its progress-tier classification) is not
 * implemented.
 */

import { describe, it, expect } from 'vitest';
import {
  rankDecisions,
  classifyKindDirection,
  hasNeedsAttentionBoost,
  buildBlockingTaskIdSet,
} from '../decisionRanking';
import type { StagedIntentRow } from '../../db/types';
import type { MilestoneConvergence } from '../convergenceService';
import { normalizeTaskId } from '../../tasks/taskId';

let counter = 0;
function row(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
  counter += 1;
  return {
    id: `intent-${counter}`,
    kind: 'task.updateBody',
    payload: '{}',
    payload_hash: `hash-${counter}`,
    task_id: `task-${counter}`,
    project_id: 'proj-1',
    session_id: null,
    group_id: null,
    milestone: 'M12',
    state: 'staged',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    created_at: counter,
    updated_at: counter,
    ...overrides,
  };
}

function convergence(blockingTaskIds: string[]): MilestoneConvergence {
  return {
    project: 'proj-1',
    milestone: 'M12',
    status: 'blocked',
    distanceToGreen: blockingTaskIds.length,
    axes: {
      tasks: {
        status: blockingTaskIds.length ? 'blocked' : 'green',
        open: blockingTaskIds.length,
        closed: 0,
        blocking: blockingTaskIds.map((id) => ({
          id,
          title: id,
          status: 'Backlog',
        })),
      },
      gate: { status: 'green', blockingCount: 0, blocking: [] },
      seed: { status: 'green', blockingCount: 0, blocking: [] },
      ops: { status: 'green', blockingCount: 0, blocking: [] },
    },
  };
}

describe('classifyKindDirection', () => {
  it('classifies setStatus as progress', () => {
    expect(classifyKindDirection('task.setStatus')).toBe('progress');
  });

  it('classifies updateBody and setDependsOn as structural', () => {
    expect(classifyKindDirection('task.updateBody')).toBe('structural');
    expect(classifyKindDirection('task.setDependsOn')).toBe('structural');
  });

  it('classifies task.create as scope_add', () => {
    expect(classifyKindDirection('task.create')).toBe('scope_add');
  });

  it('classifies an unrecognized/advisory kind as advisory_only', () => {
    expect(classifyKindDirection('decision.pickOne')).toBe('advisory_only');
    expect(classifyKindDirection('session.requestCapability')).toBe(
      'advisory_only',
    );
  });
});

describe('hasNeedsAttentionBoost', () => {
  it('boosts a row with a blocking annotation', () => {
    const r = row({
      annotation: JSON.stringify({ blocked: true, violations: [] }),
    });
    expect(hasNeedsAttentionBoost(r)).toBe(true);
  });

  it('boosts a row with a flagged Tier-3 advisory', () => {
    const r = row({
      advisory: JSON.stringify({
        tier: 'semantic',
        status: 'flagged',
        confidence: 0.9,
        findings: [],
        model: 'x',
        checkedAt: 0,
      }),
    });
    expect(hasNeedsAttentionBoost(r)).toBe(true);
  });

  it('boosts an unanswered decision.pickOne', () => {
    const r = row({ kind: 'decision.pickOne', task_id: null, answer: null });
    expect(hasNeedsAttentionBoost(r)).toBe(true);
  });

  it('does not boost an answered decision.pickOne', () => {
    const r = row({
      kind: 'decision.pickOne',
      task_id: null,
      answer: JSON.stringify({ chosenLabel: 'a', freeForm: null }),
    });
    expect(hasNeedsAttentionBoost(r)).toBe(false);
  });

  it('does not boost a plain unblocked, unflagged, unannotated row', () => {
    expect(hasNeedsAttentionBoost(row())).toBe(false);
  });
});

describe('buildBlockingTaskIdSet', () => {
  it('joins the tasks and ops axes, ignoring gate/seed (not task-id-keyed)', () => {
    const conv = convergence(['task-a']);
    conv.axes.ops.blocking = [{ task_id: 'task-b', state: 'staged-proposal' }];
    const set = buildBlockingTaskIdSet(conv);
    expect(set.has(normalizeTaskId('task-a'))).toBe(true);
    expect(set.has(normalizeTaskId('task-b'))).toBe(true);
  });

  it('returns an empty set for null convergence', () => {
    expect(buildBlockingTaskIdSet(null).size).toBe(0);
  });
});

describe('rankDecisions', () => {
  it('ranks blocking-axis membership above non-membership, all else equal', () => {
    const blocked = row({ task_id: 'task-blocked', kind: 'task.updateBody' });
    const satisfied = row({
      task_id: 'task-satisfied',
      kind: 'task.updateBody',
    });
    const ranked = rankDecisions(
      [satisfied, blocked],
      convergence(['task-blocked']),
    );
    expect(ranked.map((r) => r.id)).toEqual([blocked.id, satisfied.id]);
  });

  it('ranks kind/direction progress > structural > scope-add > advisory-only, blocking membership held equal', () => {
    const progress = row({ task_id: 'task-a', kind: 'task.setStatus' });
    const structural = row({ task_id: 'task-b', kind: 'task.updateBody' });
    const scopeAdd = row({ task_id: null, kind: 'task.create' });
    const advisory = row({
      task_id: null,
      kind: 'session.requestCapability',
    });
    const ranked = rankDecisions(
      [advisory, scopeAdd, structural, progress],
      null,
    );
    expect(ranked.map((r) => r.id)).toEqual([
      progress.id,
      structural.id,
      scopeAdd.id,
      advisory.id,
    ]);
  });

  it('a blocking-axis member outranks a higher-kind-tier non-member', () => {
    const blockedStructural = row({
      task_id: 'task-blocked',
      kind: 'task.updateBody',
    });
    const unblockedProgress = row({
      task_id: 'task-unblocked',
      kind: 'task.setStatus',
    });
    const ranked = rankDecisions(
      [unblockedProgress, blockedStructural],
      convergence(['task-blocked']),
    );
    expect(ranked.map((r) => r.id)).toEqual([
      blockedStructural.id,
      unblockedProgress.id,
    ]);
  });

  it('needs-attention boosts float an item up among same blocking+kind-tier peers', () => {
    const plain = row({ task_id: 'task-a', kind: 'task.updateBody' });
    const flagged = row({
      task_id: 'task-b',
      kind: 'task.updateBody',
      advisory: JSON.stringify({
        tier: 'semantic',
        status: 'flagged',
        confidence: 0.5,
        findings: [],
        model: 'x',
        checkedAt: 0,
      }),
    });
    const ranked = rankDecisions([plain, flagged], null);
    expect(ranked.map((r) => r.id)).toEqual([flagged.id, plain.id]);
  });

  it('does not partition — a needs-attention boost never outranks a higher blocking/kind tier', () => {
    const boostedAdvisory = row({
      task_id: null,
      kind: 'decision.pickOne',
      answer: null,
    });
    const plainProgress = row({ task_id: 'task-a', kind: 'task.setStatus' });
    const ranked = rankDecisions([boostedAdvisory, plainProgress], null);
    expect(ranked.map((r) => r.id)).toEqual([
      plainProgress.id,
      boostedAdvisory.id,
    ]);
  });

  it('does not rank by distanceToGreen/Δdistance — status change direction is irrelevant to blocking membership', () => {
    const readyFlip = row({ task_id: 'task-a', kind: 'task.setStatus' });
    const conv = convergence(['task-a']);
    const ranked = rankDecisions([readyFlip], conv);
    expect(ranked).toHaveLength(1);
    expect(conv.distanceToGreen).toBe(1);
  });
});
