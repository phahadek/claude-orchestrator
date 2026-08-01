import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MilestoneView } from '../MilestoneView';

vi.mock('../../hooks/useMilestoneConvergence', () => ({
  useMilestoneConvergence: () => ({
    convergence: { milestone: 'M1', axes: {} },
    loading: false,
    error: null,
    refetch: () => {},
  }),
}));

vi.mock('../MilestoneBurndown', () => ({
  MilestoneBurndown: ({
    activePhase,
    onPhaseSelect,
  }: {
    activePhase: string | null;
    onPhaseSelect: (phase: string | null) => void;
  }) => (
    <div data-testid="milestone-burndown">
      <span data-testid="active-phase">{activePhase ?? ''}</span>
      <button
        type="button"
        data-testid="phase-segment-gate"
        onClick={() => onPhaseSelect('gate')}
      >
        Gate items
      </button>
      <button
        type="button"
        data-testid="phase-segment-code"
        onClick={() => onPhaseSelect('code')}
      >
        Code
      </button>
    </div>
  ),
}));

vi.mock('../FlowArmToggle', () => ({
  FlowArmToggle: () => null,
}));

vi.mock('../MilestoneDecisionStack', () => ({
  MilestoneDecisionStack: ({
    phaseFilter,
    onSelect,
    onViewSession,
  }: {
    phaseFilter: string | null;
    onSelect: (selection: unknown) => void;
    onViewSession?: (selection: unknown) => void;
  }) => (
    <div data-testid="milestone-decision-stack">
      filtered: {phaseFilter ?? 'none'}
      <button
        type="button"
        data-testid="select-task-a"
        onClick={() => onSelect({ type: 'task', task: { taskId: 'task-a' } })}
      >
        select task a
      </button>
      <button
        type="button"
        data-testid="select-task-b"
        onClick={() => onSelect({ type: 'task', task: { taskId: 'task-b' } })}
      >
        select task b
      </button>
      <button
        type="button"
        data-testid="view-session-task-a"
        onClick={() =>
          onViewSession?.({ type: 'task', task: { taskId: 'task-a' } })
        }
      >
        view session
      </button>
    </div>
  ),
}));

vi.mock('../MilestoneDrilldown', () => ({
  MilestoneDrilldown: ({ mode }: { mode: string }) => (
    <div data-testid="milestone-drilldown">mode: {mode}</div>
  ),
}));

vi.mock('../GateReadinessPanel', () => ({
  GateReadinessPanel: ({
    activeBoardMilestone,
  }: {
    activeBoardMilestone: string | null;
  }) => (
    <div data-testid="gate-readiness-panel">
      scoped to {activeBoardMilestone}
    </div>
  ),
}));

function mockMatchMedia(isMobile: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: isMobile,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('MilestoneView', () => {
  const baseProps = {
    activeProjectId: 'proj-1',
    activeBoardId: 'board-1',
    activeBoardMilestone: 'M1',
    tasks: [],
    lastTaskUpdate: null,
    lastStagedIntentChange: null,
    sessions: [],
    send: vi.fn(),
    setSessionArchived: vi.fn(),
    setSessionFavorited: vi.fn(),
  };

  it('renders the decision stack, filtered by phase, when a task phase is selected', () => {
    render(<MilestoneView {...baseProps} />);

    fireEvent.click(screen.getByTestId('phase-segment-code'));

    expect(
      screen.getByTestId('milestone-decision-stack').textContent,
    ).toContain('filtered: code');
    expect(screen.queryByTestId('gate-readiness-panel')).toBeNull();
  });

  it('routes the gate-items bar to the gate panel, scoped to the milestone, instead of the task stack', () => {
    render(<MilestoneView {...baseProps} />);

    fireEvent.click(screen.getByTestId('phase-segment-gate'));

    expect(screen.getByTestId('gate-readiness-panel').textContent).toContain(
      'scoped to M1',
    );
    expect(screen.queryByTestId('milestone-decision-stack')).toBeNull();
    expect(screen.getByTestId('active-phase').textContent).toBe('gate');
  });

  it('defaults the drill-down to task mode and switches it to session mode when the stack requests a view-session', () => {
    render(<MilestoneView {...baseProps} />);

    expect(screen.getByTestId('milestone-drilldown').textContent).toBe(
      'mode: task',
    );

    fireEvent.click(screen.getByTestId('view-session-task-a'));

    expect(screen.getByTestId('milestone-drilldown').textContent).toBe(
      'mode: session',
    );
  });

  it('does not reset session mode when the stack re-selects the same card (scroll-follow), but does reset it on a genuinely different selection', () => {
    render(<MilestoneView {...baseProps} />);

    fireEvent.click(screen.getByTestId('view-session-task-a'));
    expect(screen.getByTestId('milestone-drilldown').textContent).toBe(
      'mode: session',
    );

    // Scroll-follow re-selecting the already-selected card — an equivalent
    // selection, not a switch.
    fireEvent.click(screen.getByTestId('select-task-a'));
    expect(screen.getByTestId('milestone-drilldown').textContent).toBe(
      'mode: session',
    );

    // A deliberate scroll/click to a different card does reset the mode.
    fireEvent.click(screen.getByTestId('select-task-b'));
    expect(screen.getByTestId('milestone-drilldown').textContent).toBe(
      'mode: task',
    );
  });

  it('switches the active mobile region to the drill-down when view-session is requested on a mobile viewport', () => {
    mockMatchMedia(true);
    render(<MilestoneView {...baseProps} />);

    fireEvent.click(screen.getByTestId('phase-segment-code'));
    // On mobile the stack lives behind the "Decisions" tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Decisions' }));
    expect(screen.getByTestId('milestone-decision-stack-mount')).toBeTruthy();

    fireEvent.click(screen.getByTestId('view-session-task-a'));

    expect(screen.getByTestId('milestone-drilldown-mount')).toBeTruthy();
    expect(screen.getByTestId('milestone-drilldown').textContent).toBe(
      'mode: session',
    );
  });
});
