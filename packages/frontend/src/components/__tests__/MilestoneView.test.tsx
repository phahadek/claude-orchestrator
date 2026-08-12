import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MilestoneView } from '../MilestoneView';
import { apiRequest } from '../../api/projects';
import type { TaskView } from '../../types/taskView';

vi.mock('../../api/projects', () => ({
  apiRequest: vi.fn().mockResolvedValue([]),
}));

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
  MilestoneDrilldown: ({
    mode,
    depthDispositions,
  }: {
    mode: string;
    depthDispositions?: Array<{
      prNumber: number;
      taskName: string | null;
      failingDimensions: Array<{ name: string; notes: string }>;
      escalated: boolean;
    }>;
  }) => (
    <div data-testid="milestone-drilldown">
      mode: {mode}
      <div data-testid="milestone-drilldown-depth">
        {(depthDispositions ?? []).map((d) => (
          <div key={d.prNumber} data-testid={`depth-disposition-${d.prNumber}`}>
            PR #{d.prNumber} — {d.taskName} —{' '}
            {d.failingDimensions.map((dim) => dim.name).join(', ')} —{' '}
            {d.escalated ? 'escalated' : 'routed'}
          </div>
        ))}
      </div>
    </div>
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

  const depthTask: TaskView = {
    taskId: 'task-a',
    taskName: 'Fix the thing',
    notionStatus: '🔄 In Progress',
    displayStatus: 'in_progress',
    pauseReason: null,
    priority: '🟡 Medium',
    notionUrl: '',
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: null,
    planningSession: null,
    pr: {
      prNumber: 915,
      prUrl: 'https://github.com/org/repo/pull/915',
      title: 'Fix the thing',
      headBranch: 'feature/fix',
      baseBranch: 'dev',
      state: 'open',
      draft: false,
      mergeState: null,
    },
    review: null,
    totalTokens: { input: 0, output: 0 },
    assignedRepo: null,
  };

  it('renders a failing depth verdict for the milestone in the panel, naming the dimension and PR', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce([
      {
        prNumber: 915,
        prUrl: 'https://github.com/org/repo/pull/915',
        repo: 'org/repo',
        depthVerdict: {
          verdict: 'fail',
          dimensions: [
            { name: 'reliability', passed: false, notes: 'Retries unbounded' },
          ],
          summary: 'Found a defect',
          escalated: true,
        },
      },
    ]);

    render(<MilestoneView {...baseProps} tasks={[depthTask]} />);

    await waitFor(() =>
      expect(screen.getByTestId('depth-disposition-915')).toBeTruthy(),
    );
    const entry = screen.getByTestId('depth-disposition-915');
    expect(entry.textContent).toContain('reliability');
    expect(entry.textContent).toContain('915');
    expect(entry.textContent).toContain('escalated');
  });

  it('distinguishes an escalated finding from a routed finding', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce([
      {
        prNumber: 915,
        prUrl: 'https://github.com/org/repo/pull/915',
        repo: 'org/repo',
        depthVerdict: {
          verdict: 'fail',
          dimensions: [{ name: 'reliability', passed: false, notes: 'bad' }],
          summary: 'Escalated',
          escalated: true,
        },
      },
    ]);
    const { rerender } = render(
      <MilestoneView {...baseProps} tasks={[depthTask]} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('depth-disposition-915').textContent).toContain(
        'escalated',
      ),
    );

    vi.mocked(apiRequest).mockResolvedValueOnce([
      {
        prNumber: 915,
        prUrl: 'https://github.com/org/repo/pull/915',
        repo: 'org/repo',
        depthVerdict: {
          verdict: 'fail',
          dimensions: [
            { name: 'size-proportionality', passed: false, notes: 'big' },
          ],
          summary: 'Routed',
          escalated: false,
        },
      },
    ]);
    rerender(<MilestoneView {...baseProps} tasks={[{ ...depthTask }]} />);
    await waitFor(() =>
      expect(screen.getByTestId('depth-disposition-915').textContent).toContain(
        'routed',
      ),
    );
  });

  it('does not surface a passing depth verdict as an action item', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce([
      {
        prNumber: 915,
        prUrl: 'https://github.com/org/repo/pull/915',
        repo: 'org/repo',
        depthVerdict: {
          verdict: 'pass',
          dimensions: [{ name: 'reliability', passed: true, notes: 'ok' }],
          summary: 'All good',
          escalated: false,
        },
      },
    ]);

    render(<MilestoneView {...baseProps} tasks={[depthTask]} />);

    await waitFor(() => expect(vi.mocked(apiRequest)).toHaveBeenCalled());
    expect(screen.queryByTestId('depth-disposition-915')).toBeNull();
  });

  it('renders unchanged for a milestone with no depth verdicts', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce([
      {
        prNumber: 915,
        prUrl: 'https://github.com/org/repo/pull/915',
        repo: 'org/repo',
        depthVerdict: null,
      },
    ]);

    render(<MilestoneView {...baseProps} tasks={[depthTask]} />);

    await waitFor(() => expect(vi.mocked(apiRequest)).toHaveBeenCalled());
    expect(
      screen.getByTestId('milestone-drilldown-depth').children.length,
    ).toBe(0);
  });

  it('does not thread depth dispositions into the decision stack — the staged-intent query stays untouched', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce([
      {
        prNumber: 915,
        prUrl: 'https://github.com/org/repo/pull/915',
        repo: 'org/repo',
        depthVerdict: {
          verdict: 'fail',
          dimensions: [{ name: 'reliability', passed: false, notes: 'bad' }],
          summary: 'Escalated',
          escalated: true,
        },
      },
    ]);

    render(<MilestoneView {...baseProps} tasks={[depthTask]} />);

    await waitFor(() =>
      expect(screen.getByTestId('depth-disposition-915')).toBeTruthy(),
    );
    expect(
      screen.getByTestId('milestone-decision-stack').textContent,
    ).not.toContain('reliability');
  });

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
