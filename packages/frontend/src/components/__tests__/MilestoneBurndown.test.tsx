import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MilestoneBurndown } from '../MilestoneBurndown';
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
        blockingCount: 2,
        bespokeCount: 1,
        blocking: [],
      },
      seed: { status: 'green', blockingCount: 0, blocking: [] },
      ops: { status: 'green', blockingCount: 0, blocking: [] },
    },
    ...overrides,
  };
}

describe('MilestoneBurndown', () => {
  const tasks = [
    makeTask({
      taskId: 'c1',
      taskType: '💻 Code',
      displayStatus: 'ready',
      blocked: true,
    }),
    makeTask({ taskId: 'c2', taskType: '💻 Code', displayStatus: 'done' }),
    makeTask({
      taskId: 'g1',
      taskType: '💻 Code',
      displayStatus: 'backlog',
      blocked: true,
    }),
    makeTask({
      taskId: 'g2',
      taskType: '📐 Design',
      displayStatus: 'backlog',
      blocked: false,
    }),
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

  it('renders more than one fill in the Grooming bar for a mixed pre-Ready population', () => {
    render(
      <MilestoneBurndown
        tasks={tasks}
        convergence={makeConvergence()}
        activePhase={null}
        onPhaseSelect={vi.fn()}
      />,
    );

    const groomingRow = screen.getByTestId('phase-segment-grooming');
    const fills = groomingRow.querySelectorAll('[class*="fill"]');
    expect(fills.length).toBeGreaterThan(1);
  });

  it('the gate bar renders a different number for its total and its warning', () => {
    render(
      <MilestoneBurndown
        tasks={[]}
        convergence={makeConvergence()}
        activePhase={null}
        onPhaseSelect={vi.fn()}
      />,
    );

    const gateRow = screen.getByTestId('phase-segment-gate');
    expect(gateRow.textContent).toContain('2');
    const gateWarning = screen.getByTestId('phase-blockers-gate');
    expect(gateWarning.textContent).toContain('1');
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

  it('clicking a warning badge invokes onWarningSelect instead of onPhaseSelect', () => {
    const onPhaseSelect = vi.fn();
    const onWarningSelect = vi.fn();
    render(
      <MilestoneBurndown
        tasks={tasks}
        convergence={makeConvergence()}
        activePhase={null}
        onPhaseSelect={onPhaseSelect}
        onWarningSelect={onWarningSelect}
      />,
    );

    fireEvent.click(screen.getByTestId('phase-blockers-code'));
    expect(onWarningSelect).toHaveBeenCalledWith('code');
    expect(onPhaseSelect).not.toHaveBeenCalled();
  });

  it('marks the active warning badge as pressed', () => {
    render(
      <MilestoneBurndown
        tasks={tasks}
        convergence={makeConvergence()}
        activePhase="code"
        activeWarningPhase="code"
        onPhaseSelect={vi.fn()}
        onWarningSelect={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId('phase-blockers-code').getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
