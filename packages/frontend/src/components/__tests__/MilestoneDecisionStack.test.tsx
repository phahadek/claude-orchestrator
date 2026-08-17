import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
  act,
} from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MilestoneDecisionStack } from '../MilestoneDecisionStack';
import { stagedIntentsApi } from '../../api/stagedIntents';
import type { StagedIntent } from '../../api/stagedIntents';
import { reportsApi } from '../../api/reports';
import type { InvestigationReport } from '../../api/reports';
import type { DisplayStatus, TaskView } from '../../types/taskView';
import { computePhaseBurndown } from '../../utils/phaseBurndown';
import type { PanelKeyboardDeclaration } from '../../types/panelKeyboard';

function makeReport(
  overrides: Partial<InvestigationReport> & { id: string },
): InvestigationReport {
  return {
    project_id: 'proj-1',
    milestone_id: 'M1',
    title: 'Untitled report',
    symptom_text: 'Something looked wrong',
    evidence_text: null,
    state: 'committed',
    source: 'operator',
    origin_session_id: null,
    origin_task_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    inFlight: false,
    resolveEligible: false,
    dispatchedSessions: [],
    ...overrides,
  };
}

const RUNNING_CODE_SESSION = {
  sessionId: 'sess-1',
  status: 'running',
  startedAt: 1,
  endedAt: null,
  lastMessage: '',
  inputTokens: 0,
  outputTokens: 0,
};

const RUNNING_PLANNING_SESSION = {
  sessionId: 'plan-sess-1',
  status: 'running',
  sessionType: 'design',
  startedAt: 1,
  endedAt: null,
  inputTokens: 0,
  outputTokens: 0,
};

vi.mock('../../hooks/stagedIntentBus', () => ({
  subscribeStagedIntentChange: () => () => {},
}));

function makeTask(overrides: Partial<TaskView>): TaskView {
  return {
    taskId: 'task-1',
    taskName: 'Do the thing',
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
    pr: null,
    review: null,
    depthReview: null,
    totalTokens: { input: 0, output: 0 },
    assignedRepo: null,
    ...overrides,
  };
}

describe('MilestoneDecisionStack', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sorts tasks into not-yet-launched vs in-flight vs done, honouring the phase filter', async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
    const tasks: TaskView[] = [
      makeTask({ taskId: 'code-open', taskName: 'Code open' }),
      makeTask({
        taskId: 'code-launched',
        taskName: 'Code launched',
        codeSession: RUNNING_CODE_SESSION,
      }),
      makeTask({
        taskId: 'code-done',
        taskName: 'Code done',
        displayStatus: 'done',
        notionStatus: '✅ Done',
      }),
      makeTask({
        taskId: 'design-open',
        taskName: 'Design open',
        taskType: '📐 Design',
      }),
    ];

    const onSelect = vi.fn();
    render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={tasks}
        phaseFilter="code"
        selection={null}
        onSelect={onSelect}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('milestone-decision-stack')).toBeTruthy(),
    );

    expect(screen.getByTestId('milestone-task-row-code-open')).toBeTruthy();
    // A code session in progress now renders under "In flight" rather than
    // disappearing.
    expect(screen.getByTestId('milestone-task-row-code-launched')).toBeTruthy();
    // Done is collapsed by default, so its rows are not rendered yet.
    expect(screen.queryByTestId('milestone-task-row-code-done')).toBeNull();
    expect(screen.queryByTestId('milestone-task-row-design-open')).toBeNull();

    expect(screen.getByText(/In flight \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Done \(1\)/)).toBeTruthy();

    fireEvent.click(screen.getByText(/Done \(1\)/));
    expect(screen.getByTestId('milestone-task-row-code-done')).toBeTruthy();

    // Renders through the shared CompactTaskCard, not bespoke row markup.
    expect(screen.getAllByTestId('compact-task-card')).toHaveLength(3);

    fireEvent.click(screen.getByText('Code open'));
    expect(onSelect).toHaveBeenCalledWith({
      type: 'task',
      task: tasks[0],
    });

    fireEvent.click(screen.getByText('Code launched'));
    expect(onSelect).toHaveBeenCalledWith({
      type: 'task',
      task: tasks[1],
    });

    fireEvent.click(screen.getByText('Code done'));
    expect(onSelect).toHaveBeenCalledWith({
      type: 'task',
      task: tasks[2],
    });
  });

  it('renders a task in every non-done DisplayStatus paired with a code session under "In flight", exhaustively', async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
    const nonDoneStatuses: DisplayStatus[] = [
      'ready',
      'in_progress',
      'in_review',
      'needs_attention',
      'ready_to_merge',
      'backlog',
      'blocked',
      'deferred',
    ];
    const tasks: TaskView[] = nonDoneStatuses.map((status) =>
      makeTask({
        taskId: `task-${status}`,
        taskName: `Task ${status}`,
        displayStatus: status,
        codeSession: RUNNING_CODE_SESSION,
      }),
    );

    render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={tasks}
        phaseFilter={null}
        selection={null}
        onSelect={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('milestone-decision-stack')).toBeTruthy(),
    );

    // Every status lands in "In flight" — none silently dropped, none
    // duplicated into "Not yet launched" or "Done".
    expect(
      screen.getByText(new RegExp(`In flight \\(${nonDoneStatuses.length}\\)`)),
    ).toBeTruthy();
    for (const status of nonDoneStatuses) {
      expect(
        screen.getByTestId(`milestone-task-row-task-${status}`),
      ).toBeTruthy();
    }
    expect(screen.queryByText(/Not yet launched/)).toBeNull();
    expect(screen.queryByText(/Done \(/)).toBeNull();
  });

  it('renders in_review, needs_attention, ready_to_merge and blocked tasks holding a code session', async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
    const tasks: TaskView[] = [
      makeTask({
        taskId: 'in-review',
        taskName: 'In review',
        displayStatus: 'in_review',
        codeSession: RUNNING_CODE_SESSION,
      }),
      makeTask({
        taskId: 'needs-attention',
        taskName: 'Needs attention',
        displayStatus: 'needs_attention',
        codeSession: RUNNING_CODE_SESSION,
      }),
      makeTask({
        taskId: 'ready-to-merge',
        taskName: 'Ready to merge',
        displayStatus: 'ready_to_merge',
        codeSession: RUNNING_CODE_SESSION,
      }),
      makeTask({
        taskId: 'blocked-task',
        taskName: 'Blocked task',
        displayStatus: 'blocked',
        blocked: true,
        codeSession: RUNNING_CODE_SESSION,
      }),
    ];

    render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={tasks}
        phaseFilter={null}
        selection={null}
        onSelect={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('milestone-decision-stack')).toBeTruthy(),
    );

    expect(screen.getByTestId('milestone-task-row-in-review')).toBeTruthy();
    expect(
      screen.getByTestId('milestone-task-row-needs-attention'),
    ).toBeTruthy();
    expect(
      screen.getByTestId('milestone-task-row-ready-to-merge'),
    ).toBeTruthy();
    expect(screen.getByTestId('milestone-task-row-blocked-task')).toBeTruthy();
  });

  it("agrees with the phase bar's Staged count for the number of rows rendered in that phase", async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
    const tasks: TaskView[] = [
      makeTask({ taskId: 'staged-open', taskName: 'Staged open' }),
      makeTask({
        taskId: 'staged-launched',
        taskName: 'Staged launched',
        displayStatus: 'in_review',
        codeSession: RUNNING_CODE_SESSION,
      }),
      makeTask({
        taskId: 'staged-blocked',
        taskName: 'Staged blocked',
        displayStatus: 'blocked',
        blocked: true,
        codeSession: RUNNING_CODE_SESSION,
      }),
    ];

    const burndown = computePhaseBurndown(tasks, null);
    const stagedCount = burndown.code.counts.staged ?? 0;

    render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={tasks}
        phaseFilter="code"
        selection={null}
        onSelect={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('milestone-decision-stack')).toBeTruthy(),
    );

    const renderedRows = screen.getAllByTestId(/^milestone-task-row-/).length;
    expect(stagedCount).toBe(3);
    expect(renderedRows).toBe(stagedCount);
  });

  it('no longer labels an in-progress Design task "Not yet launched" once it holds a planning session', async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
    const tasks: TaskView[] = [
      makeTask({
        taskId: 'design-in-flight',
        taskName: 'Design in flight',
        taskType: '📐 Design',
        planningSession: RUNNING_PLANNING_SESSION,
      }),
      makeTask({
        taskId: 'ops-in-flight',
        taskName: 'Ops in flight',
        taskType: '🔧 Operational',
        planningSession: RUNNING_PLANNING_SESSION,
      }),
    ];

    render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={tasks}
        phaseFilter={null}
        selection={null}
        onSelect={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('milestone-decision-stack')).toBeTruthy(),
    );

    expect(
      screen.getByTestId('milestone-task-row-design-in-flight'),
    ).toBeTruthy();
    expect(screen.getByTestId('milestone-task-row-ops-in-flight')).toBeTruthy();
    expect(screen.queryByText(/Not yet launched/)).toBeNull();
    expect(screen.getByText(/In flight \(2\)/)).toBeTruthy();
  });

  it('narrows to blocked tasks only when flaggedOnly is set, showing exactly the flagged items', async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
    const tasks: TaskView[] = [
      makeTask({
        taskId: 'code-blocked',
        taskName: 'Code blocked',
        blocked: true,
      }),
      makeTask({
        taskId: 'code-open',
        taskName: 'Code open',
        blocked: false,
      }),
      makeTask({
        taskId: 'code-blocked-done',
        taskName: 'Code blocked done',
        displayStatus: 'done',
        notionStatus: '✅ Done',
        blocked: true,
      }),
    ];

    render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={tasks}
        phaseFilter="code"
        flaggedOnly
        selection={null}
        onSelect={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('milestone-decision-stack')).toBeTruthy(),
    );

    expect(screen.getByTestId('milestone-task-row-code-blocked')).toBeTruthy();
    expect(
      screen.queryByTestId('milestone-task-row-code-blocked-done'),
    ).toBeNull();

    fireEvent.click(screen.getByText(/Done \(1\)/));
    expect(
      screen.getByTestId('milestone-task-row-code-blocked-done'),
    ).toBeTruthy();
    expect(screen.queryByTestId('milestone-task-row-code-open')).toBeNull();
  });

  it('narrows both the decision inbox and the task rows together when a phase is selected, in one render', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'code-intent',
        kind: 'task.setStatus',
        payload: { taskId: 'code-open', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 1,
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
      {
        id: 'design-intent',
        kind: 'task.setStatus',
        payload: { taskId: 'design-open', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 0,
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);
    const tasks: TaskView[] = [
      makeTask({ taskId: 'code-open', taskName: 'Code open' }),
      makeTask({
        taskId: 'design-open',
        taskName: 'Design open',
        taskType: '📐 Design',
      }),
    ];

    render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={tasks}
        phaseFilter="code"
        selection={null}
        onSelect={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId('milestone-decision-card-code-intent'),
      ).toBeTruthy(),
    );

    // Both panels narrow together in the same render pass.
    expect(screen.getByTestId('milestone-task-row-code-open')).toBeTruthy();
    expect(screen.queryByTestId('milestone-task-row-design-open')).toBeNull();
    expect(
      screen.queryByTestId('milestone-decision-card-design-intent'),
    ).toBeNull();
  });

  it('follows the scroll container: scrolling to a task row selects it, but ignores the scroll event a click itself suppresses', async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
    const tasks: TaskView[] = [
      makeTask({ taskId: 'task-a', taskName: 'Task A' }),
      makeTask({ taskId: 'task-b', taskName: 'Task B' }),
    ];

    // Mount directly into a container we control, so it's both the DOM
    // ancestor React's event delegation attaches to (clicks keep working)
    // and the node the scroll-follow handler observes.
    const container = document.body.appendChild(document.createElement('div'));
    const scrollContainerRef = { current: container };

    const onSelect = vi.fn();
    render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={tasks}
        phaseFilter={null}
        selection={null}
        onSelect={onSelect}
        scrollContainerRef={scrollContainerRef}
      />,
      { container },
    );

    await waitFor(() =>
      expect(screen.getByTestId('milestone-decision-stack')).toBeTruthy(),
    );

    const rowA = screen.getByTestId('milestone-task-row-task-a');
    const rowB = screen.getByTestId('milestone-task-row-task-b');

    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      top: 0,
    } as DOMRect);
    vi.spyOn(rowA, 'getBoundingClientRect').mockReturnValue({
      top: -50,
    } as DOMRect);
    vi.spyOn(rowB, 'getBoundingClientRect').mockReturnValue({
      top: 4,
    } as DOMRect);

    fireEvent.scroll(container);

    expect(onSelect).toHaveBeenCalledWith({ type: 'task', task: tasks[1] });

    // An explicit click sets the selection and suppresses the very next
    // scroll event (e.g. one the click's own layout shift triggers).
    onSelect.mockClear();
    fireEvent.click(screen.getByText('Task A'));
    expect(onSelect).toHaveBeenCalledWith({ type: 'task', task: tasks[0] });

    onSelect.mockClear();
    fireEvent.scroll(container);
    expect(onSelect).not.toHaveBeenCalled();

    // A subsequent, independent scroll resumes normal follow behaviour.
    fireEvent.scroll(container);
    expect(onSelect).toHaveBeenCalledWith({ type: 'task', task: tasks[1] });
  });

  it('drives selection from a pending intent card in the composed MilestoneDecisionInbox', async () => {
    const intents: StagedIntent[] = [
      {
        id: 'intent-1',
        kind: 'task.setStatus',
        payload: { taskId: 'task-1', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 100,
        sessionId: 'session-1',
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
      },
    ];
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue(intents);

    const onSelect = vi.fn();
    render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={[]}
        phaseFilter={null}
        selection={null}
        onSelect={onSelect}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId('milestone-decision-card-intent-1'),
      ).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId('milestone-decision-card-intent-1'));
    expect(onSelect).toHaveBeenCalledWith({
      type: 'intent',
      intent: intents[0],
    });
  });

  it('selects a dispatched report card and jumps straight to session mode in one click, via onViewSession', async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
    const report = makeReport({
      id: 'report-1',
      inFlight: true,
      dispatchedSessions: [
        {
          sessionId: 'sess-report-1',
          sessionStatus: 'running',
          dispatchedAt: '2026-01-01T00:00:01Z',
        },
      ],
    });
    vi.spyOn(reportsApi, 'list').mockResolvedValue({
      items: [report],
      total: 1,
      page: 1,
    });

    const onSelect = vi.fn();
    const onViewSession = vi.fn();
    render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={[]}
        phaseFilter={null}
        selection={null}
        onSelect={onSelect}
        onViewSession={onViewSession}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('report-card-report-1')).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId('report-card-report-1'));

    expect(onSelect).toHaveBeenCalledWith({ type: 'report', report });
    expect(onViewSession).toHaveBeenCalledWith({ type: 'report', report });
  });

  it("the declared panel's onApprove fires the same primary-action handler the highlighted card's own button uses", async () => {
    const intent: StagedIntent = {
      id: 'intent-1',
      kind: 'task.setStatus',
      payload: { taskId: 'task-1', status: 'Ready' },
      projectId: 'proj-1',
      createdAt: 1,
      milestone: 'M1',
      state: 'staged',
      sessionComplete: true,
    };
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([intent]);
    const apply = vi
      .spyOn(stagedIntentsApi, 'apply')
      .mockResolvedValue({ ok: true, result: {} });

    let declaration: PanelKeyboardDeclaration | null = null;
    render(
      <MilestoneDecisionStack
        projectId="proj-1"
        milestone="M1"
        tasks={[]}
        phaseFilter={null}
        selection={null}
        onSelect={vi.fn()}
        keyboardHighlightedId="intent-1"
        onDeclarationChange={(d) => {
          declaration = d;
        }}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId('milestone-decision-card-intent-1'),
      ).toBeTruthy(),
    );
    expect(declaration).not.toBeNull();
    expect(declaration!.onApprove).toBeDefined();

    act(() => declaration!.onApprove?.({ id: 'intent-1' }));

    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith('intent-1', {
        override: false,
        reason: undefined,
        mirrorDisposition: undefined,
      }),
    );
  });

  describe('re-selecting the topmost card after a disposition', () => {
    function makeIntent(overrides: Partial<StagedIntent>): StagedIntent {
      return {
        id: 'intent',
        kind: 'task.setStatus',
        payload: { taskId: 'task-x', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 1,
        milestone: 'M1',
        state: 'staged',
        sessionComplete: true,
        ...overrides,
      };
    }

    it('selects the card now topmost when the selected card is dispositioned via commit, and reuses the scroll-follow ordering (no second refetch)', async () => {
      const intentA = makeIntent({ id: 'intent-a', createdAt: 2 });
      const intentB = makeIntent({ id: 'intent-b', createdAt: 1 });
      const listByMilestone = vi
        .spyOn(stagedIntentsApi, 'listByMilestone')
        .mockResolvedValue([intentA, intentB]);
      vi.spyOn(stagedIntentsApi, 'apply').mockResolvedValue({
        ok: true,
        result: {},
      });

      const onSelect = vi.fn();
      render(
        <MilestoneDecisionStack
          projectId="proj-1"
          milestone="M1"
          tasks={[]}
          phaseFilter={null}
          selection={{ type: 'intent', intent: intentA }}
          onSelect={onSelect}
        />,
      );

      await waitFor(() =>
        expect(
          screen.getByTestId('milestone-decision-card-intent-a'),
        ).toBeTruthy(),
      );

      const cardA = screen.getByTestId('milestone-decision-card-intent-a');
      fireEvent.click(within(cardA).getByText('✓ Commit'));

      await waitFor(() =>
        expect(onSelect).toHaveBeenCalledWith({
          type: 'intent',
          intent: intentB,
        }),
      );

      // The reselect reused the fetched-order card list — no second fetch.
      expect(listByMilestone).toHaveBeenCalledTimes(1);
    });

    it('leaves the current selection unchanged when a different (non-selected) card is dispositioned', async () => {
      const groupAIntent = makeIntent({
        id: 'a1',
        groupId: 'group-a',
        createdAt: 2,
      });
      const groupBIntent = makeIntent({
        id: 'b1',
        groupId: 'group-b',
        createdAt: 1,
      });
      vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
        groupAIntent,
        groupBIntent,
      ]);
      vi.spyOn(stagedIntentsApi, 'listGroup').mockResolvedValue({
        groupId: 'group-b',
        intents: [],
        wedged: false,
      });
      const approveGroup = vi
        .spyOn(stagedIntentsApi, 'approveGroup')
        .mockResolvedValue({ ok: true, committed: ['group-b'] });

      const onSelect = vi.fn();
      render(
        <MilestoneDecisionStack
          projectId="proj-1"
          milestone="M1"
          tasks={[]}
          phaseFilter={null}
          selection={{ type: 'intent', intent: groupAIntent }}
          onSelect={onSelect}
        />,
      );

      await waitFor(() =>
        expect(
          screen.getByTestId('milestone-decision-card-group-b'),
        ).toBeTruthy(),
      );

      const cardB = screen.getByTestId('milestone-decision-card-group-b');
      // The group actions bar stops click propagation, so this exercises
      // the disposition path without also triggering a click-to-select.
      fireEvent.click(within(cardB).getByText(/✓ Approve/));

      await waitFor(() => expect(approveGroup).toHaveBeenCalledWith('group-b'));

      expect(onSelect).not.toHaveBeenCalled();
    });

    it('re-selects the new topmost card exactly once when a group approve removes several cards', async () => {
      const member1 = makeIntent({
        id: 'g1',
        groupId: 'group-x',
        createdAt: 3,
      });
      const member2 = makeIntent({
        id: 'g2',
        kind: 'task.setDependsOn',
        payload: { taskId: 'task-x', dependsOn: [] },
        groupId: 'group-x',
        createdAt: 2,
      });
      const other = makeIntent({ id: 'other-1', createdAt: 1 });
      vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
        member1,
        member2,
        other,
      ]);
      vi.spyOn(stagedIntentsApi, 'listGroup').mockResolvedValue({
        groupId: 'group-x',
        intents: [],
        wedged: false,
      });
      vi.spyOn(stagedIntentsApi, 'approveGroup').mockResolvedValue({
        ok: true,
        committed: ['group-x'],
      });

      const onSelect = vi.fn();
      render(
        <MilestoneDecisionStack
          projectId="proj-1"
          milestone="M1"
          tasks={[]}
          phaseFilter={null}
          selection={{ type: 'intent', intent: member1 }}
          onSelect={onSelect}
        />,
      );

      await waitFor(() =>
        expect(
          screen.getByTestId('milestone-decision-card-group-x'),
        ).toBeTruthy(),
      );

      const groupCard = screen.getByTestId('milestone-decision-card-group-x');
      fireEvent.click(within(groupCard).getByText(/✓ Approve/));

      await waitFor(() =>
        expect(onSelect).toHaveBeenCalledWith({
          type: 'intent',
          intent: other,
        }),
      );
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('clears the selection to the defined empty state when the last remaining card is dispositioned', async () => {
      const onlyIntent = makeIntent({ id: 'only-1' });
      vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
        onlyIntent,
      ]);
      vi.spyOn(stagedIntentsApi, 'apply').mockResolvedValue({
        ok: true,
        result: {},
      });

      const onSelect = vi.fn();
      render(
        <MilestoneDecisionStack
          projectId="proj-1"
          milestone="M1"
          tasks={[]}
          phaseFilter={null}
          selection={{ type: 'intent', intent: onlyIntent }}
          onSelect={onSelect}
        />,
      );

      await waitFor(() =>
        expect(
          screen.getByTestId('milestone-decision-card-only-1'),
        ).toBeTruthy(),
      );

      const card = screen.getByTestId('milestone-decision-card-only-1');
      fireEvent.click(within(card).getByText('✓ Commit'));

      await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
    });

    it('advances to the new topmost card when a decision.pickOne card is answered, not only via approve/reject', async () => {
      const pickOne = makeIntent({
        id: 'pick-1',
        kind: 'decision.pickOne',
        payload: {
          prompt: 'Which approach?',
          options: [{ label: 'A', description: 'Option A' }],
          allowFreeForm: false,
        },
        createdAt: 2,
      });
      const other = makeIntent({ id: 'other-2', createdAt: 1 });
      vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([
        pickOne,
        other,
      ]);
      vi.spyOn(stagedIntentsApi, 'answer').mockResolvedValue({
        ok: true,
        intent: { ...pickOne, state: 'committed' },
      });

      const onSelect = vi.fn();
      render(
        <MilestoneDecisionStack
          projectId="proj-1"
          milestone="M1"
          tasks={[]}
          phaseFilter={null}
          selection={{ type: 'intent', intent: pickOne }}
          onSelect={onSelect}
        />,
      );

      await waitFor(() =>
        expect(screen.getByTestId('decision-pick-one-panel')).toBeTruthy(),
      );

      const pickOnePanel = screen.getByTestId('decision-pick-one-panel');
      fireEvent.click(within(pickOnePanel).getByRole('radio'));
      fireEvent.click(within(pickOnePanel).getByText('✓ Submit'));

      await waitFor(() =>
        expect(onSelect).toHaveBeenCalledWith({
          type: 'intent',
          intent: other,
        }),
      );
    });
  });
});
