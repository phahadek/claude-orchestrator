import { describe, it, expect } from 'vitest';
import {
  computePhaseBurndown,
  phaseForTask,
  phaseTotal,
  flaggedTasksForPhase,
  isGatePhase,
  GATE_STATE_KEY,
  PHASE_ORDER,
} from '../phaseBurndown';
import type { TaskView } from '../../types/taskView';
import type { MilestoneConvergence } from '@claude-orchestrator/backend/src/convergence/convergenceService';

function makeTask(overrides: Partial<TaskView> = {}): TaskView {
  return {
    taskId: 't1',
    taskName: 'Task 1',
    notionStatus: '✅ Done',
    displayStatus: 'done',
    pauseReason: null,
    priority: 'P2',
    notionUrl: '',
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: null,
    planningSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
    assignedRepo: null,
    hasAwaitingDispositionIntent: false,
    ...overrides,
  };
}

function makeConvergence(
  overrides: Partial<MilestoneConvergence> = {},
): MilestoneConvergence {
  return {
    project: 'proj',
    milestone: 'M1',
    status: 'blocked',
    distanceToGreen: 1,
    axes: {
      tasks: { status: 'blocked', open: 1, closed: 0, blocking: [] },
      gate: {
        status: 'blocked',
        blockingCount: 121,
        parkedCount: 0,
        bespokeCount: 3,
        counts: {
          open: 100,
          runnable: 20,
          'pending-approval': 1,
          pass: 200,
          fail: 5,
          deferred: 3,
        },
      },
      seed: { status: 'green', blockingCount: 0, blocking: [] },
      ops: { status: 'green', blockingCount: 0, blocking: [] },
      investigationReport: { status: 'green', blockingCount: 0, blocking: [] },
    },
    ...overrides,
  };
}

describe('computePhaseBurndown', () => {
  it('has no grooming or investigation phase', () => {
    expect([...PHASE_ORDER]).toEqual(['design', 'code', 'ops', 'gate']);
    const result = computePhaseBurndown([], null);
    expect(Object.keys(result).sort()).toEqual(
      ['code', 'design', 'gate', 'ops'].sort(),
    );
  });

  it('counts Backlog tasks as grooming inside their own type bar', () => {
    const tasks = [
      makeTask({ taskId: 'c1', taskType: '💻 Code', displayStatus: 'backlog' }),
      makeTask({
        taskId: 'd1',
        taskType: '📐 Design',
        displayStatus: 'backlog',
      }),
    ];
    const result = computePhaseBurndown(tasks, null);
    expect(result.code.counts).toEqual({ grooming: 1 });
    expect(result.design.counts).toEqual({ grooming: 1 });
  });

  it('buckets non-grooming tasks by phase and pending/staged/done state', () => {
    const tasks = [
      makeTask({
        taskId: 'd1',
        taskType: '📐 Design',
        displayStatus: 'ready',
      }),
      makeTask({
        taskId: 'c1',
        taskType: '💻 Code',
        displayStatus: 'in_progress',
      }),
      makeTask({
        taskId: 'c2',
        taskType: '💻 Code',
        displayStatus: 'done',
      }),
      makeTask({
        taskId: 'x1',
        taskType: '💻 Code',
        displayStatus: 'deferred',
      }),
    ];

    const result = computePhaseBurndown(tasks, makeConvergence());

    expect(result.design.counts).toEqual({ pending: 1 });
    expect(result.code.counts).toEqual({ staged: 1, done: 1 });
    expect(phaseTotal(result.design.counts)).toBe(1);
  });

  it('merges Investigation and Operational into ops with a per-kind breakdown', () => {
    const inv = makeTask({
      taskId: 'i1',
      taskType: '🔎 Investigation',
      displayStatus: 'done',
    });
    const op1 = makeTask({
      taskId: 'o1',
      taskType: '🔧 Operational',
      displayStatus: 'ready',
    });
    const op2 = makeTask({
      taskId: 'o2',
      taskType: '🔧 Operational',
      displayStatus: 'backlog',
    });
    expect(phaseForTask(inv)).toBe('ops');
    expect(phaseForTask(op1)).toBe('ops');

    const result = computePhaseBurndown([inv, op1, op2], null);
    expect(result.ops.byKind?.investigation).toEqual({ done: 1 });
    expect(result.ops.byKind?.operational).toEqual({ pending: 1, grooming: 1 });
    expect(result.ops.counts).toEqual({ done: 1, pending: 1, grooming: 1 });
  });

  it('counts a blocked Backlog Code task as a blocker and flags it', () => {
    const task = makeTask({
      taskId: 'b1',
      taskType: '💻 Code',
      displayStatus: 'backlog',
      blocked: true,
    });
    const result = computePhaseBurndown([task], null);
    expect(result.code.blockerCount).toBe(1);
    expect(flaggedTasksForPhase('code', [task])).toEqual([task]);
  });

  it('puts a Backlog Docs task in no phase', () => {
    const task = makeTask({ taskType: '📝 Docs', displayStatus: 'backlog' });
    expect(phaseForTask(task)).toBeNull();
    const result = computePhaseBurndown([task], null);
    for (const phase of PHASE_ORDER) {
      if (phase !== 'gate') expect(phaseTotal(result[phase].counts)).toBe(0);
    }
  });

  it('derives the gate bar warning from a different quantity than its total', () => {
    const result = computePhaseBurndown([], makeConvergence());
    expect(phaseTotal(result.gate.counts)).toBe(329);
    expect(result.gate.blockerCount).toBe(3);
    expect(result.gate.blockerCount).not.toBe(phaseTotal(result.gate.counts));
  });

  it('carries per-state gate counts through, including resolved states', () => {
    const result = computePhaseBurndown([], makeConvergence());
    expect(result.gate.counts).toEqual({
      open: 100,
      runnable: 20,
      pendingApproval: 1,
      pass: 200,
      fail: 5,
      deferred: 3,
    });
  });

  it('counts blockers per phase for task-backed phases', () => {
    const tasks = [
      makeTask({ taskId: 'c1', taskType: '💻 Code', blocked: true }),
      makeTask({ taskId: 'c2', taskType: '💻 Code', blocked: false }),
    ];
    const result = computePhaseBurndown(tasks, null);
    expect(result.code.blockerCount).toBe(1);
  });

  it('maps pending gate counts to the pending segment, not open', () => {
    const convergence = makeConvergence({
      axes: {
        tasks: { status: 'blocked', open: 1, closed: 0, blocking: [] },
        gate: {
          status: 'blocked',
          blockingCount: 121,
          parkedCount: 7,
          bespokeCount: 3,
          counts: {
            open: 100,
            runnable: 20,
            'pending-approval': 1,
            pending: 7,
            pass: 200,
            fail: 5,
            deferred: 3,
          },
        },
        seed: { status: 'green', blockingCount: 0, blocking: [] },
        ops: { status: 'green', blockingCount: 0, blocking: [] },
        investigationReport: {
          status: 'green',
          blockingCount: 0,
          blocking: [],
        },
      },
    });

    const result = computePhaseBurndown([], convergence);

    expect(result.gate.counts.pending).toBe(7);
    expect(result.gate.counts.open).toBe(100);
  });

  it('has a GATE_STATE_KEY entry for every state in the backend gate vocabulary', () => {
    const BACKEND_GATE_STATES = [
      'open',
      'runnable',
      'pass',
      'fail',
      'deferred',
      'pending-approval',
      'pending',
      'discarded',
    ];
    for (const state of BACKEND_GATE_STATES) {
      expect(GATE_STATE_KEY[state]).toBeDefined();
    }
  });
});

describe('flaggedTasksForPhase', () => {
  it('returns exactly the blocked tasks in a phase', () => {
    const tasks = [
      makeTask({ taskId: 'c1', taskType: '💻 Code', blocked: true }),
      makeTask({ taskId: 'c2', taskType: '💻 Code', blocked: false }),
      makeTask({ taskId: 'd1', taskType: '📐 Design', blocked: true }),
    ];
    const flagged = flaggedTasksForPhase('code', tasks);
    expect(flagged.map((t) => t.taskId)).toEqual(['c1']);
  });
});

describe('isGatePhase', () => {
  it('is true only for the gate phase, which has no corresponding phaseForTask result', () => {
    expect(isGatePhase('gate')).toBe(true);
    expect(isGatePhase('code')).toBe(false);
    const task = makeTask({ taskType: '💻 Code' });
    expect(phaseForTask(task)).not.toBe('gate');
  });
});
