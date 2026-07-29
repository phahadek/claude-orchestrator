import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MilestoneBurndown, computePhaseBurndown } from '../MilestoneBurndown';
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
      gate: { status: 'blocked', blockingCount: 2, blocking: [] },
      seed: { status: 'green', blockingCount: 0, blocking: [] },
      ops: { status: 'green', blockingCount: 0, blocking: [] },
    },
    ...overrides,
  };
}

describe('computePhaseBurndown', () => {
  it('buckets tasks by phase and state', () => {
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
        taskId: 'g1',
        taskType: '💻 Code',
        displayStatus: 'backlog',
      }),
      makeTask({
        taskId: 'g2',
        taskType: '📐 Design',
        displayStatus: 'backlog',
      }),
      makeTask({
        taskId: 'x1',
        taskType: '💻 Code',
        displayStatus: 'deferred',
      }),
    ];

    const result = computePhaseBurndown(tasks, makeConvergence());

    expect(result.design.counts).toEqual({ pending: 1, staged: 0, done: 0 });
    expect(result.code.counts).toEqual({ pending: 0, staged: 1, done: 1 });
    // Backlog tasks of any type land in grooming, not their eventual type phase.
    expect(result.grooming.counts).toEqual({ pending: 0, staged: 2, done: 0 });
    // Deferred tasks are excluded entirely.
    expect(
      result.design.counts.pending +
        result.design.counts.staged +
        result.design.counts.done,
    ).toBe(1);
    expect(result.gate.counts.pending).toBe(2);
  });

  it('counts blockers per phase', () => {
    const tasks = [
      makeTask({ taskId: 'c1', taskType: '💻 Code', blocked: true }),
      makeTask({ taskId: 'c2', taskType: '💻 Code', blocked: false }),
    ];
    const result = computePhaseBurndown(tasks, null);
    expect(result.code.blockerCount).toBe(1);
  });
});

describe('MilestoneBurndown', () => {
  const tasks = [
    makeTask({
      taskId: 'c1',
      taskType: '💻 Code',
      displayStatus: 'ready',
      blocked: true,
    }),
    makeTask({ taskId: 'c2', taskType: '💻 Code', displayStatus: 'done' }),
  ];

  it('renders a segment per phase with colour-by-state fills', () => {
    render(
      <MilestoneBurndown
        tasks={tasks}
        convergence={makeConvergence()}
        activePhase={null}
        onPhaseSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId('phase-segment-code')).toBeDefined();
    expect(screen.getByTestId('phase-segment-design')).toBeDefined();
    expect(screen.getByTestId('phase-segment-grooming')).toBeDefined();
    expect(screen.getByTestId('phase-segment-investigation')).toBeDefined();
    expect(screen.getByTestId('phase-segment-ops')).toBeDefined();
    expect(screen.getByTestId('phase-segment-gate')).toBeDefined();

    expect(screen.getByTestId('phase-segment-code').textContent).toContain('2');
    expect(screen.getByTestId('phase-blockers-code')).toBeDefined();
  });

  it('clicking a phase segment invokes the shell phase filter callback', () => {
    const onPhaseSelect = vi.fn();
    render(
      <MilestoneBurndown
        tasks={tasks}
        convergence={makeConvergence()}
        activePhase={null}
        onPhaseSelect={onPhaseSelect}
      />,
    );

    fireEvent.click(screen.getByTestId('phase-segment-code'));
    expect(onPhaseSelect).toHaveBeenCalledWith('code');
  });

  it('marks the active phase segment as pressed', () => {
    render(
      <MilestoneBurndown
        tasks={tasks}
        convergence={makeConvergence()}
        activePhase="code"
        onPhaseSelect={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId('phase-segment-code').getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
