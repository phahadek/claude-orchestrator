import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MilestoneView } from '../MilestoneView';
import { apiRequest } from '../../api/projects';
import type { TaskView } from '../../types/taskView';
import type { TaskView as BackendTaskView } from '@claude-orchestrator/backend/src/routes/tasks';
import type { StagedIntent } from '../../api/stagedIntents';

// MilestoneView fires apiRequest calls from more than one caller on mount
// (the /api/prs depth-dispositions fetch, and LaneHealthPanel's
// /api/milestones/.../lane-health fetch) — a single un-keyed
// mockResolvedValueOnce queue would be consumed by whichever caller's
// effect happens to run first. Route queued "once" responses by URL prefix
// instead, so pushOnce('/api/prs', ...) always answers the prs fetch
// regardless of mount-order races with other apiRequest callers.
const prsResponses: unknown[] = [];
function pushPrsResponseOnce(value: unknown): void {
  prsResponses.push(value);
}

vi.mock('../../api/projects', () => ({
  apiRequest: vi.fn((url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/prs')) {
      return Promise.resolve(
        prsResponses.length > 0 ? prsResponses.shift() : [],
      );
    }
    return Promise.resolve([]);
  }),
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
  FlowArmToggle: () => <div data-testid="flow-arm-toggle" />,
}));

vi.mock('../DeploySection', () => ({
  DeploySection: ({ activeProjectId }: { activeProjectId: string | null }) => (
    <div data-testid="deploy-launch-section">deploy for {activeProjectId}</div>
  ),
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
    depthReviewStatusBySessionId,
  }: {
    mode: string;
    depthReviewStatusBySessionId?: Record<
      string,
      { escalated: boolean; routeCount: number }
    >;
  }) => (
    <div data-testid="milestone-drilldown">
      mode: {mode}
      <div data-testid="milestone-drilldown-depth">
        {Object.entries(depthReviewStatusBySessionId ?? {}).map(
          ([sessionId, status]) => (
            <div key={sessionId} data-testid={`depth-status-${sessionId}`}>
              {sessionId} — {status.escalated ? 'escalated' : 'routed'} — ×
              {status.routeCount}
            </div>
          ),
        )}
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
    depthReview: null,
    totalTokens: { input: 0, output: 0 },
    assignedRepo: null,
  };

  it('builds a depth-review status map keyed by session id, for a failing verdict on the milestone', async () => {
    pushPrsResponseOnce([
      {
        prNumber: 915,
        depthVerdict: {
          verdict: 'fail',
          escalated: true,
          sessionId: 'sess-depth-a',
          routeCount: 0,
        },
      },
    ]);

    render(<MilestoneView {...baseProps} tasks={[depthTask]} />);

    await waitFor(() =>
      expect(screen.getByTestId('depth-status-sess-depth-a')).toBeTruthy(),
    );
    expect(
      screen.getByTestId('depth-status-sess-depth-a').textContent,
    ).toContain('escalated');
  });

  it('distinguishes an escalated finding from a routed finding', async () => {
    pushPrsResponseOnce([
      {
        prNumber: 915,
        depthVerdict: {
          verdict: 'fail',
          escalated: true,
          sessionId: 'sess-depth-a',
          routeCount: 0,
        },
      },
    ]);
    const { rerender } = render(
      <MilestoneView {...baseProps} tasks={[depthTask]} />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('depth-status-sess-depth-a').textContent,
      ).toContain('escalated'),
    );

    pushPrsResponseOnce([
      {
        prNumber: 915,
        depthVerdict: {
          verdict: 'fail',
          escalated: false,
          sessionId: 'sess-depth-a',
          routeCount: 1,
        },
      },
    ]);
    rerender(<MilestoneView {...baseProps} tasks={[{ ...depthTask }]} />);
    await waitFor(() =>
      expect(
        screen.getByTestId('depth-status-sess-depth-a').textContent,
      ).toContain('routed'),
    );
  });

  it('does not surface a passing depth verdict as an action item', async () => {
    pushPrsResponseOnce([
      {
        prNumber: 915,
        depthVerdict: {
          verdict: 'pass',
          escalated: false,
          sessionId: 'sess-depth-a',
          routeCount: 0,
        },
      },
    ]);

    render(<MilestoneView {...baseProps} tasks={[depthTask]} />);

    await waitFor(() => expect(vi.mocked(apiRequest)).toHaveBeenCalled());
    expect(screen.queryByTestId('depth-status-sess-depth-a')).toBeNull();
  });

  it('renders unchanged for a milestone with no depth verdicts', async () => {
    pushPrsResponseOnce([
      {
        prNumber: 915,
        depthVerdict: null,
      },
    ]);

    render(<MilestoneView {...baseProps} tasks={[depthTask]} />);

    await waitFor(() => expect(vi.mocked(apiRequest)).toHaveBeenCalled());
    expect(
      screen.getByTestId('milestone-drilldown-depth').children.length,
    ).toBe(0);
  });

  it('does not thread depth-review status into the decision stack — the staged-intent query stays untouched', async () => {
    pushPrsResponseOnce([
      {
        prNumber: 915,
        depthVerdict: {
          verdict: 'fail',
          escalated: true,
          sessionId: 'sess-depth-a',
          routeCount: 0,
        },
      },
    ]);

    render(<MilestoneView {...baseProps} tasks={[depthTask]} />);

    await waitFor(() =>
      expect(screen.getByTestId('depth-status-sess-depth-a')).toBeTruthy(),
    );
    expect(
      screen.getByTestId('milestone-decision-stack').textContent,
    ).not.toContain('sess-depth-a');
  });

  it('fetches PR depth dispositions from the DB-only endpoint, never the project-wide live-GitHub /api/prs list', async () => {
    pushPrsResponseOnce([]);

    render(<MilestoneView {...baseProps} tasks={[depthTask]} />);

    await waitFor(() => expect(vi.mocked(apiRequest)).toHaveBeenCalled());
    const urls = vi
      .mocked(apiRequest)
      .mock.calls.map((call) => call[0])
      .filter((u): u is string => typeof u === 'string');
    expect(urls.some((u) => u.startsWith('/api/prs/depth-dispositions'))).toBe(
      true,
    );
    expect(urls.some((u) => /^\/api\/prs\?/.test(u))).toBe(false);
  });

  it('does not re-fetch depth dispositions when a task/staged-intent change belongs to a different milestone', async () => {
    pushPrsResponseOnce([]);
    // Same array reference across renders — mirrors the real component tree,
    // where `tasks` is already scoped to the active milestone upstream and
    // is unaffected by a change belonging to a different milestone's board.
    const sameTasks = [depthTask];

    const { rerender } = render(
      <MilestoneView {...baseProps} tasks={sameTasks} />,
    );
    await waitFor(() => expect(vi.mocked(apiRequest)).toHaveBeenCalled());
    const countBefore = vi
      .mocked(apiRequest)
      .mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].startsWith('/api/prs/depth-dispositions'),
      ).length;

    rerender(
      <MilestoneView
        {...baseProps}
        tasks={sameTasks}
        lastTaskUpdate={
          { taskId: 'other-milestone-task' } as unknown as BackendTaskView
        }
        lastStagedIntentChange={
          { id: 'other-milestone-intent' } as unknown as StagedIntent
        }
      />,
    );

    const countAfter = vi
      .mocked(apiRequest)
      .mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].startsWith('/api/prs/depth-dispositions'),
      ).length;
    expect(countAfter).toBe(countBefore);
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

  it('renders Deploy in the left column between MilestoneBurndown and FlowArmToggle for every phaseFilter, not only the gate phase', () => {
    render(<MilestoneView {...baseProps} />);

    function assertDeployBetweenBurndownAndFlowArm() {
      const leftColumn = screen.getByTestId('milestone-burndown-mount');
      const html = leftColumn.innerHTML;
      const burndownIdx = html.indexOf('data-testid="milestone-burndown"');
      const deployIdx = html.indexOf('data-testid="deploy-launch-section"');
      const flowArmIdx = html.indexOf('data-testid="flow-arm-toggle"');
      expect(burndownIdx).toBeGreaterThan(-1);
      expect(deployIdx).toBeGreaterThan(burndownIdx);
      expect(flowArmIdx).toBeGreaterThan(deployIdx);
    }

    // Default (no phase selected).
    assertDeployBetweenBurndownAndFlowArm();
    expect(screen.getByTestId('deploy-launch-section').textContent).toContain(
      'proj-1',
    );

    // Non-gate phase.
    fireEvent.click(screen.getByTestId('phase-segment-code'));
    assertDeployBetweenBurndownAndFlowArm();

    // Gate phase — Deploy still lives in the left column, not in the gate panel.
    fireEvent.click(screen.getByTestId('phase-segment-gate'));
    assertDeployBetweenBurndownAndFlowArm();
  });

  describe('resize handle', () => {
    // Mirrors the real desktop layout: container 1000px wide starting at
    // x=0, with .leftColumn's fixed 300px rendered before .middlePanel — so
    // the handle's true on-screen x is leftColumnWidth + middlePanel's
    // current pixel width, not the container's own x=0 origin.
    const CONTAINER_WIDTH = 1000;
    const LEFT_COLUMN_WIDTH = 300;

    function mockLayout() {
      const shell = screen.getByTestId('milestone-view-shell');
      const leftColumn = screen.getByTestId('milestone-burndown-mount');
      vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        width: CONTAINER_WIDTH,
      } as DOMRect);
      vi.spyOn(leftColumn, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        width: LEFT_COLUMN_WIDTH,
      } as DOMRect);
    }

    function middleWidthPct(): number {
      const middlePanel = screen.getByTestId('milestone-decision-stack-mount');
      return parseFloat(middlePanel.style.width);
    }

    it('does not jump toward the max width on the first drag pixel from the handle actual on-screen position', () => {
      render(<MilestoneView {...baseProps} />);
      mockLayout();

      const preDragPct = middleWidthPct(); // DEFAULT_MIDDLE_WIDTH_PCT (55)
      const handleX = LEFT_COLUMN_WIDTH + (preDragPct / 100) * CONTAINER_WIDTH;

      fireEvent.mouseDown(screen.getByTestId('milestone-resize-handle'));
      fireEvent.mouseMove(window, { clientX: handleX });

      expect(middleWidthPct()).toBeCloseTo(preDragPct, 0);
    });

    it('tracks the cursor 1:1 — a known clientX delta moves middleWidthPct by the proportional amount', () => {
      render(<MilestoneView {...baseProps} />);
      mockLayout();

      const preDragPct = middleWidthPct();
      const handleX = LEFT_COLUMN_WIDTH + (preDragPct / 100) * CONTAINER_WIDTH;
      const deltaPx = 50;
      const expectedDeltaPct = (deltaPx / CONTAINER_WIDTH) * 100;

      fireEvent.mouseDown(screen.getByTestId('milestone-resize-handle'));
      fireEvent.mouseMove(window, { clientX: handleX + deltaPx });

      expect(middleWidthPct() - preDragPct).toBeCloseTo(expectedDeltaPct, 5);
    });
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
