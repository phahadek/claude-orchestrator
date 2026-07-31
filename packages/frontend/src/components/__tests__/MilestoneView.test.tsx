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
  MilestoneDecisionStack: ({ phaseFilter }: { phaseFilter: string | null }) => (
    <div data-testid="milestone-decision-stack">
      filtered: {phaseFilter ?? 'none'}
    </div>
  ),
}));

vi.mock('../MilestoneDrilldown', () => ({
  MilestoneDrilldown: () => <div data-testid="milestone-drilldown" />,
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

    expect(
      screen.getByTestId('gate-readiness-panel').textContent,
    ).toContain('scoped to M1');
    expect(screen.queryByTestId('milestone-decision-stack')).toBeNull();
    expect(screen.getByTestId('active-phase').textContent).toBe('gate');
  });
});
