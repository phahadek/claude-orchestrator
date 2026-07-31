import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MilestoneDecisionStack } from '../MilestoneDecisionStack';
import { stagedIntentsApi } from '../../api/stagedIntents';
import type { StagedIntent } from '../../api/stagedIntents';
import type { TaskView } from '../../types/taskView';

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
    totalTokens: { input: 0, output: 0 },
    assignedRepo: null,
    ...overrides,
  };
}

describe('MilestoneDecisionStack', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sorts tasks into not-yet-launched vs done, honouring the phase filter', async () => {
    vi.spyOn(stagedIntentsApi, 'listByMilestone').mockResolvedValue([]);
    const tasks: TaskView[] = [
      makeTask({ taskId: 'code-open', taskName: 'Code open' }),
      makeTask({
        taskId: 'code-launched',
        taskName: 'Code launched',
        codeSession: {
          sessionId: 'sess-1',
          status: 'running',
          startedAt: 1,
          endedAt: null,
          lastMessage: '',
          inputTokens: 0,
          outputTokens: 0,
        },
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
    expect(screen.getByTestId('milestone-task-row-code-done')).toBeTruthy();
    expect(screen.queryByTestId('milestone-task-row-code-launched')).toBeNull();
    expect(screen.queryByTestId('milestone-task-row-design-open')).toBeNull();

    // Renders through the shared CompactTaskCard, not bespoke row markup.
    expect(screen.getAllByTestId('compact-task-card')).toHaveLength(2);

    fireEvent.click(screen.getByText('Code open'));
    expect(onSelect).toHaveBeenCalledWith({
      type: 'task',
      task: tasks[0],
    });
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
      },
      {
        id: 'design-intent',
        kind: 'task.setStatus',
        payload: { taskId: 'design-open', status: 'Ready' },
        projectId: 'proj-1',
        createdAt: 0,
        milestone: 'M1',
        state: 'staged',
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
});
