import { describe, it, expect } from 'vitest';
import {
  computePhaseBurndown,
  phaseForTask,
  phaseTotal,
  flaggedTasksForPhase,
  isGatePhase,
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
        bespokeCount: 3,
        blocking: [],
      },
      seed: { status: 'green', blockingCount: 0, blocking: [] },
      ops: { status: 'green', blockingCount: 0, blocking: [] },
    },
    ...overrides,
  };
}

describe('computePhaseBurndown', () => {
  it('gives the Grooming bar more than one state for a mixed pre-Ready population, summing to its total', () => {
    const tasks = [
      makeTask({
        taskId: 'blocked-1',
        displayStatus: 'backlog',
        blocked: true,
      }),
      makeTask({
        taskId: 'in-grooming-1',
        displayStatus: 'backlog',
        blocked: false,
        planningSession: {
          sessionId: 's1',
          status: 'running',
          sessionType: 'groom',
          startedAt: 1,
          endedAt: null,
          inputTokens: 0,
          outputTokens: 0,
        },
      }),
      makeTask({
        taskId: 'untouched-1',
        displayStatus: 'backlog',
        blocked: false,
      }),
      makeTask({
        taskId: 'untouched-2',
        displayStatus: 'backlog',
        blocked: false,
      }),
    ];

    const result = computePhaseBurndown(tasks, null);

    expect(result.grooming.counts).toEqual({
      blocked: 1,
      inGrooming: 1,
      untouched: 2,
    });
    const states = Object.keys(result.grooming.counts).filter(
      (k) => (result.grooming.counts as Record<string, number>)[k] > 0,
    );
    expect(states.length).toBeGreaterThan(1);
    expect(
      Object.values(result.grooming.counts).reduce(
        (sum, n) => sum + (n ?? 0),
        0,
      ),
    ).toBe(4);
  });

  it('a completed groom session (endedAt set) does not count as in grooming', () => {
    const tasks = [
      makeTask({
        taskId: 'ended-groom',
        displayStatus: 'backlog',
        blocked: false,
        planningSession: {
          sessionId: 's1',
          status: 'done',
          sessionType: 'groom',
          startedAt: 1,
          endedAt: 2,
          inputTokens: 0,
          outputTokens: 0,
        },
      }),
    ];
    const result = computePhaseBurndown(tasks, null);
    expect(result.grooming.counts.untouched).toBe(1);
    expect(result.grooming.counts.inGrooming ?? 0).toBe(0);
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

  it('derives the gate bar warning from a different quantity than its total', () => {
    const result = computePhaseBurndown([], makeConvergence());
    expect(phaseTotal(result.gate.counts)).toBe(121);
    expect(result.gate.blockerCount).toBe(3);
    expect(result.gate.blockerCount).not.toBe(phaseTotal(result.gate.counts));
  });

  it('counts blockers per phase for task-backed phases', () => {
    const tasks = [
      makeTask({ taskId: 'c1', taskType: '💻 Code', blocked: true }),
      makeTask({ taskId: 'c2', taskType: '💻 Code', blocked: false }),
    ];
    const result = computePhaseBurndown(tasks, null);
    expect(result.code.blockerCount).toBe(1);
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
