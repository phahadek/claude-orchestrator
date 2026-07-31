import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskView } from '../../types/taskView';
import type { MilestoneConvergence } from '@claude-orchestrator/backend/src/convergence/convergenceService';

const useConvergenceHistoryMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useConvergenceHistory', () => ({
  useConvergenceHistory: useConvergenceHistoryMock,
}));

import { MilestoneBurndown } from '../MilestoneBurndown';

beforeEach(() => {
  useConvergenceHistoryMock.mockReturnValue({
    history: [],
    loading: false,
    error: null,
  });
});

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

describe('MilestoneBurndown convergence header', () => {
  it('renders overall status, distanceToGreen, and one chip per axis with its blocking count', () => {
    render(
      <MilestoneBurndown
        tasks={[]}
        convergence={makeConvergence()}
        activePhase={null}
        onPhaseSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId('convergence-header')).toBeDefined();
    expect(screen.getByTestId('convergence-status')).toBeDefined();
    expect(screen.getByTestId('convergence-distance').textContent).toBe('1');
    expect(screen.getByTestId('convergence-chip-tasks').textContent).toContain(
      '1',
    );
    expect(screen.getByTestId('convergence-chip-gate').textContent).toContain(
      '2',
    );
    expect(screen.getByTestId('convergence-chip-seed').textContent).toContain(
      '0',
    );
    expect(screen.getByTestId('convergence-chip-ops').textContent).toContain(
      '0',
    );
  });

  it('labels distanceToGreen so its exclusion of the ops axis is legible, using the backend value verbatim', () => {
    render(
      <MilestoneBurndown
        tasks={[]}
        convergence={makeConvergence({ distanceToGreen: 42 })}
        activePhase={null}
        onPhaseSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId('convergence-distance').textContent).toBe('42');
    const header = screen.getByTestId('convergence-header');
    expect(header.textContent).toMatch(/ops/i);
  });

  it('renders the task axis "unavailable" distinctly, never as green', () => {
    render(
      <MilestoneBurndown
        tasks={[]}
        convergence={makeConvergence({
          axes: {
            tasks: { status: 'unavailable', open: 0, closed: 0, blocking: [] },
            gate: {
              status: 'green',
              blockingCount: 0,
              bespokeCount: 0,
              blocking: [],
            },
            seed: { status: 'green', blockingCount: 0, blocking: [] },
            ops: { status: 'green', blockingCount: 0, blocking: [] },
          },
        })}
        activePhase={null}
        onPhaseSelect={vi.fn()}
      />,
    );

    const chip = screen.getByTestId('convergence-chip-tasks');
    expect(chip.textContent).toContain('Unavailable');
    expect(chip.className).not.toMatch(/axisChip_green/);
  });

  it('activating the gate chip invokes onPhaseSelect with the gate phase', () => {
    const onPhaseSelect = vi.fn();
    render(
      <MilestoneBurndown
        tasks={[]}
        convergence={makeConvergence()}
        activePhase={null}
        onPhaseSelect={onPhaseSelect}
      />,
    );

    fireEvent.click(screen.getByTestId('convergence-chip-gate'));
    expect(onPhaseSelect).toHaveBeenCalledWith('gate');
  });

  it('renders the seed and ops chips as non-interactive counts', () => {
    render(
      <MilestoneBurndown
        tasks={[]}
        convergence={makeConvergence()}
        activePhase={null}
        onPhaseSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId('convergence-chip-seed').tagName).not.toBe(
      'BUTTON',
    );
    expect(screen.getByTestId('convergence-chip-ops').tagName).not.toBe(
      'BUTTON',
    );
  });

  it('renders a sparkline with per-axis series when history is available', () => {
    useConvergenceHistoryMock.mockReturnValue({
      history: [
        {
          id: 's1',
          project: 'proj',
          milestone: 'M1',
          ts: '2026-07-01T00:00:00.000Z',
          tasks_open: 5,
          tasks_closed: 1,
          gate_open: 150,
          gate_closed: 2,
          seed_open: 3,
          seed_closed: 0,
          ops_open: 0,
          ops_closed: 0,
          total_scope: 160,
          distance_to_green: 158,
          status: 'blocked',
        },
        {
          id: 's2',
          project: 'proj',
          milestone: 'M1',
          ts: '2026-07-02T00:00:00.000Z',
          tasks_open: 3,
          tasks_closed: 3,
          gate_open: 149,
          gate_closed: 3,
          seed_open: 2,
          seed_closed: 1,
          ops_open: 0,
          ops_closed: 0,
          total_scope: 160,
          distance_to_green: 154,
          status: 'blocked',
        },
      ],
      loading: false,
      error: null,
    });

    render(
      <MilestoneBurndown
        tasks={[]}
        convergence={makeConvergence()}
        activePhase={null}
        onPhaseSelect={vi.fn()}
        projectId="proj"
        milestoneId="M1"
      />,
    );

    expect(screen.getByTestId('convergence-sparkline')).toBeDefined();
    expect(
      screen.getByTestId('convergence-sparkline-series-tasks_open'),
    ).toBeDefined();
    expect(
      screen.getByTestId('convergence-sparkline-series-gate_open'),
    ).toBeDefined();
    expect(
      screen.getByTestId('convergence-sparkline-series-seed_open'),
    ).toBeDefined();
  });

  it('renders the header without a sparkline and without error when there is no snapshot history', () => {
    useConvergenceHistoryMock.mockReturnValue({
      history: [],
      loading: false,
      error: null,
    });

    render(
      <MilestoneBurndown
        tasks={[]}
        convergence={makeConvergence()}
        activePhase={null}
        onPhaseSelect={vi.fn()}
        projectId="proj"
        milestoneId="M1"
      />,
    );

    expect(screen.getByTestId('convergence-header')).toBeDefined();
    expect(screen.queryByTestId('convergence-sparkline')).toBeNull();
  });

  it('leaves the phase rows unchanged alongside the convergence header', () => {
    render(
      <MilestoneBurndown
        tasks={[]}
        convergence={makeConvergence()}
        activePhase={null}
        onPhaseSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId('convergence-header')).toBeDefined();
    expect(screen.getByTestId('phase-segment-code')).toBeDefined();
    expect(screen.getByTestId('phase-segment-gate')).toBeDefined();
  });
});
