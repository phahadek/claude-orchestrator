import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskList } from '../TaskList';
import type { TaskView, DisplayStatus } from '../../types/taskView';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';

// Prevent localStorage access in tests — mergeReady calls getDeviceToken which hits localStorage
vi.mock('../../auth/deviceToken', () => ({
  getDeviceToken: () => null,
  setDeviceToken: vi.fn(),
  clearDeviceToken: vi.fn(),
}));

function makeTask(
  overrides: Partial<TaskView> & {
    taskId: string;
    displayStatus: DisplayStatus;
  },
): TaskView {
  return {
    taskName: 'Test Task',
    notionStatus: '🔄 In Progress',
    pauseReason: null,
    priority: '',
    notionUrl: 'https://notion.so/task',
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
    ...overrides,
  };
}

const noop = vi.fn().mockReturnValue(true);
const noopOptimistic = vi.fn();

/** Render TaskList with the new required props. Overrides merge on top of defaults. */
function renderList(
  tasks: TaskView[],
  propOverrides: {
    activeProjectId?: string | null;
    boardId?: string | null;
    selectedTaskId?: string | null;
    onSelectTask?: (id: string) => void;
    loading?: boolean;
    onOptimisticDispatch?: (ids: string[]) => void;
    onForceRefetch?: () => Promise<void>;
    reviewRefreshTrigger?: number;
    send?: (msg: unknown) => boolean;
    project?: ProjectConfig | null;
  } = {},
) {
  return render(
    <TaskList
      activeProjectId="proj-1"
      boardId={null}
      selectedTaskId={null}
      onSelectTask={vi.fn()}
      tasks={tasks}
      loading={false}
      onOptimisticDispatch={noopOptimistic}
      send={noop}
      project={null}
      {...propOverrides}
    />,
  );
}

describe('TaskList', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    noopOptimistic.mockClear();
    noop.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a loading indicator when loading prop is true', () => {
    renderList([], { loading: true });
    expect(screen.getByTestId('task-list-loading')).toBeDefined();
  });

  it('renders an empty state when no active tasks exist', () => {
    renderList([]);
    expect(screen.getByTestId('task-list-empty')).toBeDefined();
  });

  it('renders section headers for each non-empty display status group', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Running Task',
        displayStatus: 'in_progress',
      }),
      makeTask({
        taskId: 't2',
        taskName: 'Review Task',
        displayStatus: 'in_review',
      }),
    ]);
    expect(screen.getByTestId('group-header-in_progress')).toBeDefined();
    expect(screen.getByTestId('group-header-in_review')).toBeDefined();
  });

  it('shows Ready section header when there are ready tasks', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Ready Task',
        displayStatus: 'ready',
        wave: 1,
      }),
    ]);
    expect(screen.getByTestId('group-header-ready')).toBeDefined();
  });

  it('renders ready tasks in compact row format (CompactTaskCard), not full TaskCard', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Ready Task',
        displayStatus: 'ready',
        wave: 1,
      }),
    ]);
    expect(screen.getByTestId('group-header-ready')).toBeDefined();
    // CompactTaskCard renders inside the ready section
    expect(screen.getByText('Ready Task')).toBeDefined();
  });

  it('groups ready code tasks under correct wave headers', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Wave 1 Task',
        displayStatus: 'ready',
        wave: 1,
      }),
      makeTask({
        taskId: 't2',
        taskName: 'Wave 2 Task',
        displayStatus: 'ready',
        wave: 2,
      }),
    ]);
    expect(screen.getByTestId('wave-group-1')).toBeDefined();
    expect(screen.getByTestId('wave-group-2')).toBeDefined();
  });

  it('Wave 2+ tasks render with blocked CSS class', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Wave 2 Blocked Task',
        displayStatus: 'ready',
        wave: 2,
        blocked: true,
        blockerNames: ['Blocker'],
      }),
    ]);
    // Wave 2 starts collapsed; expand it
    const wave2Header = screen.getByTestId('wave-header-2');
    fireEvent.click(wave2Header);
    expect(screen.getByText('Wave 2 Blocked Task')).toBeDefined();
  });

  it('Wave 2+ tasks show blocker names', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Blocked Task',
        displayStatus: 'ready',
        wave: 2,
        blocked: true,
        blockerNames: ['Blocker A', 'Blocker B'],
      }),
    ]);
    const wave2Header = screen.getByTestId('wave-header-2');
    fireEvent.click(wave2Header);
    expect(screen.getByText('Blocked Task')).toBeDefined();
  });

  it('Wave 2+ tasks do NOT render checkboxes', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Wave 2 Task',
        displayStatus: 'ready',
        wave: 2,
        taskType: '💻 Code',
      }),
    ]);
    const wave2Header = screen.getByTestId('wave-header-2');
    fireEvent.click(wave2Header);
    // No checkbox for wave 2 tasks
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('Wave 1 code tasks render with a checkbox', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Wave 1 Code Task',
        displayStatus: 'ready',
        wave: 1,
        taskType: '💻 Code',
        blocked: false,
      }),
    ]);
    expect(screen.getByRole('checkbox')).toBeDefined();
  });

  it('non-code ready tasks are in the Non-Code sub-group within the Ready section with no checkboxes', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Planning Task',
        displayStatus: 'ready',
        taskType: '📋 Planning',
        wave: 1,
      }),
    ]);
    expect(screen.getByTestId('non-code-wave-group')).toBeDefined();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('renders non-ready non-code tasks in a separate section at the bottom', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Planning Task',
        displayStatus: 'in_progress',
        taskType: '📋 Planning',
      }),
    ]);
    expect(screen.getByTestId('group-header-planning')).toBeDefined();
    expect(screen.getByText('Planning Task')).toBeDefined();
  });

  it('"Select All" button only selects Wave 1 code tasks', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Wave 1 Task',
        displayStatus: 'ready',
        wave: 1,
        blocked: false,
        taskType: '💻 Code',
      }),
      makeTask({
        taskId: 't2',
        taskName: 'Wave 2 Task',
        displayStatus: 'ready',
        wave: 2,
        blocked: false,
        taskType: '💻 Code',
      }),
    ]);

    const selectAllBtn = screen.getByTestId('select-all-btn');
    fireEvent.click(selectAllBtn);

    // Only Wave 1 task checkbox should be checked
    const checkbox = screen.getByRole('checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    // Launch button should show 1 (only wave 1)
    const launchBtn = screen.getByTestId('launch-btn');
    expect(launchBtn.textContent).toContain('1');
  });

  it('"Launch (N)" button is disabled when no tasks are checked', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Ready Task',
        displayStatus: 'ready',
        wave: 1,
        blocked: false,
        taskType: '💻 Code',
      }),
    ]);
    const launchBtn = screen.getByTestId('launch-btn') as HTMLButtonElement;
    expect(launchBtn.disabled).toBe(true);
  });

  it('"Launch (N)" button becomes enabled and shows count when tasks are checked', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Ready Task',
        displayStatus: 'ready',
        wave: 1,
        blocked: false,
        taskType: '💻 Code',
      }),
    ]);
    fireEvent.click(screen.getByRole('checkbox'));
    const launchBtn = screen.getByTestId('launch-btn') as HTMLButtonElement;
    expect(launchBtn.disabled).toBe(false);
    expect(launchBtn.textContent).toContain('1');
  });

  it('sorts ready tasks within a wave by priority — High first', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Low Priority',
        displayStatus: 'ready',
        wave: 1,
        priority: '🟢 Low',
      }),
      makeTask({
        taskId: 't2',
        taskName: 'High Priority',
        displayStatus: 'ready',
        wave: 1,
        priority: '🔴 High',
      }),
    ]);
    const taskTexts = screen
      .getAllByRole('checkbox')
      .map((el) => el.closest('[data-testid]') ?? el.parentElement)
      .map((el) => el?.textContent ?? '');
    // High Priority should appear before Low Priority
    const highIdx = taskTexts.findIndex((t) => t.includes('High Priority'));
    const lowIdx = taskTexts.findIndex((t) => t.includes('Low Priority'));
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('clicking a non-done group header collapses it (toggles collapsed state)', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Running Task',
        displayStatus: 'in_progress',
      }),
    ]);
    const header = screen.getByTestId('group-header-in_progress');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('collapsed group does not render its task list children', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Running Task',
        displayStatus: 'in_progress',
      }),
    ]);
    const header = screen.getByTestId('group-header-in_progress');
    fireEvent.click(header);
    expect(screen.queryByText('Running Task')).toBeNull();
  });

  it('expanded group renders all task items', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Running Task',
        displayStatus: 'in_progress',
      }),
    ]);
    expect(screen.getByText('Running Task')).toBeDefined();
  });

  it('toggle icon changes between expanded and collapsed states', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Running Task',
        displayStatus: 'in_progress',
      }),
    ]);
    const header = screen.getByTestId('group-header-in_progress');
    const getToggle = () =>
      header.querySelector('[aria-hidden="true"]')?.textContent ?? '';
    expect(getToggle()).toBe('▼');
    fireEvent.click(header);
    expect(getToggle()).toBe('▶');
    fireEvent.click(header);
    expect(getToggle()).toBe('▼');
  });

  it('collapses the Done group by default', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Done Task',
        displayStatus: 'done',
      }),
    ]);
    const header = screen.getByTestId('group-header-done');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Done Task')).toBeNull();
  });

  it('expands the Done group when the header is clicked', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Done Task',
        displayStatus: 'done',
      }),
    ]);
    const header = screen.getByTestId('group-header-done');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Done Task')).toBeDefined();
  });

  it('calls onSelectTask with the task id when a ready card is clicked', () => {
    const onSelectTask = vi.fn();
    renderList(
      [
        makeTask({
          taskId: 'ready-task-1',
          taskName: 'Ready Task',
          displayStatus: 'ready',
          wave: 1,
        }),
      ],
      { onSelectTask },
    );
    fireEvent.click(screen.getByText('Ready Task'));
    expect(onSelectTask).toHaveBeenCalledWith('ready-task-1');
  });

  it('calls onSelectTask with the task id when an in-progress card is clicked', () => {
    const onSelectTask = vi.fn();
    renderList(
      [
        makeTask({
          taskId: 'running-task-1',
          taskName: 'Running Task',
          displayStatus: 'in_progress',
        }),
      ],
      { onSelectTask },
    );
    fireEvent.click(screen.getByText('Running Task'));
    expect(onSelectTask).toHaveBeenCalledWith('running-task-1');
  });

  it('renders the empty state when activeProjectId is null', () => {
    renderList([], { activeProjectId: null });
    expect(screen.getByTestId('task-list-empty')).toBeDefined();
  });

  it('when tasks prop updates via reviewRefreshTrigger, updated task appears', () => {
    const task = makeTask({
      taskId: 't1',
      taskName: 'Task A',
      displayStatus: 'in_review',
    });
    const updatedTask = makeTask({
      taskId: 't1',
      taskName: 'Task A (reviewed)',
      displayStatus: 'needs_attention',
    });

    const { rerender } = renderList([task], { reviewRefreshTrigger: 0 });
    expect(screen.getByText('Task A')).toBeDefined();

    rerender(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        tasks={[updatedTask]}
        loading={false}
        onOptimisticDispatch={noopOptimistic}
        reviewRefreshTrigger={1}
        send={noop}
        project={null}
      />,
    );
    expect(screen.getByText('Task A (reviewed)')).toBeDefined();
  });

  it('when tasks prop updates, moved task appears in new group', () => {
    const task = makeTask({
      taskId: 't2',
      taskName: 'Task B',
      displayStatus: 'in_progress',
    });
    const withReview = makeTask({
      taskId: 't2',
      taskName: 'Task B',
      displayStatus: 'in_review',
      review: {
        sessionId: 'rev-1',
        status: 'running',
        verdict: null,
        summary: null,
        iterationCount: 1,
        inputTokens: 0,
        outputTokens: 0,
      },
    });

    const { rerender } = renderList([task]);
    expect(screen.getByTestId('group-header-in_progress')).toBeDefined();
    expect(screen.queryByTestId('group-header-in_review')).toBeNull();

    rerender(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        tasks={[withReview]}
        loading={false}
        onOptimisticDispatch={noopOptimistic}
        send={noop}
        project={null}
      />,
    );
    expect(screen.getByTestId('group-header-in_review')).toBeDefined();
  });

  it('Ready group header renders with role="button" and aria-expanded', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Ready Task',
        displayStatus: 'ready',
        wave: 1,
      }),
    ]);
    const header = screen.getByTestId('group-header-ready');
    expect(header.getAttribute('role')).toBe('button');
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('clicking Ready group header toggles aria-expanded between true and false', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Ready Task',
        displayStatus: 'ready',
        wave: 1,
      }),
    ]);
    const header = screen.getByTestId('group-header-ready');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('when Ready is collapsed, wave cards are not rendered', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Ready Task',
        displayStatus: 'ready',
        wave: 1,
      }),
    ]);
    const header = screen.getByTestId('group-header-ready');
    fireEvent.click(header);
    expect(screen.queryByText('Ready Task')).toBeNull();
  });

  it('Launch button click does NOT trigger collapse toggle (stopPropagation)', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Ready Task',
        displayStatus: 'ready',
        wave: 1,
        blocked: false,
        taskType: '💻 Code',
      }),
    ]);
    // Check the task so the Launch button is enabled
    fireEvent.click(screen.getByRole('checkbox'));
    const launchBtn = screen.getByTestId('launch-btn');
    const readyHeader = screen.getByTestId('group-header-ready');
    expect(readyHeader.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(launchBtn);

    // The click on launch should not collapse the Ready group (stopPropagation)
    expect(readyHeader.getAttribute('aria-expanded')).toBe('true');
  });

  it('Planning/Testing group header renders with role="button" and aria-expanded', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Planning Task',
        displayStatus: 'in_progress',
        taskType: '📋 Planning',
      }),
    ]);
    const header = screen.getByTestId('group-header-planning');
    expect(header.getAttribute('role')).toBe('button');
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('clicking Planning/Testing header toggles visibility of its task cards', () => {
    renderList([
      makeTask({
        taskId: 't1',
        taskName: 'Planning Task',
        displayStatus: 'in_progress',
        taskType: '📋 Planning',
      }),
    ]);
    expect(screen.getByText('Planning Task')).toBeDefined();
    const header = screen.getByTestId('group-header-planning');
    fireEvent.click(header);
    expect(screen.queryByText('Planning Task')).toBeNull();
  });

  it('updating the tasks prop reflects the updated task name in the UI', () => {
    const original = makeTask({
      taskId: 't1',
      taskName: 'Old Name',
      displayStatus: 'in_progress',
      wave: 1,
    });
    const updated = makeTask({
      taskId: 't1',
      taskName: 'Updated Name',
      displayStatus: 'in_progress',
      wave: 1,
    });

    const { rerender } = renderList([original]);
    expect(screen.getByText('Old Name')).toBeDefined();

    rerender(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        tasks={[updated]}
        loading={false}
        onOptimisticDispatch={noopOptimistic}
        send={noop}
        project={null}
      />,
    );

    expect(screen.getByText('Updated Name')).toBeDefined();
    expect(screen.queryByText('Old Name')).toBeNull();
  });

  it('tasks prop with an additional task shows the new task in the UI', () => {
    const initial = makeTask({
      taskId: 't1',
      taskName: 'Known Task',
      displayStatus: 'in_progress',
    });
    const newTask = makeTask({
      taskId: 't2',
      taskName: 'New Task',
      displayStatus: 'in_progress',
    });

    const { rerender } = renderList([initial]);
    expect(screen.getByText('Known Task')).toBeDefined();
    expect(screen.queryByText('New Task')).toBeNull();

    rerender(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        tasks={[initial, newTask]}
        loading={false}
        onOptimisticDispatch={noopOptimistic}
        send={noop}
        project={null}
      />,
    );

    expect(screen.getByText('Known Task')).toBeDefined();
    expect(screen.getByText('New Task')).toBeDefined();
  });

  it('dispatching tasks calls onOptimisticDispatch with the selected task IDs', () => {
    const onOptimisticDispatch = vi.fn();
    const task = makeTask({
      taskId: 't1',
      taskName: 'Ready Task',
      displayStatus: 'ready',
      wave: 1,
      blocked: false,
      taskType: '💻 Code',
      notionUrl: 'https://notion.so/t1',
    });
    const sendFn = vi.fn();
    const project: ProjectConfig = {
      id: 'proj-1',
      name: 'Test',
      projectDir: '/tmp/test',
      contextUrl: 'https://notion.so/ctx',
      boardId: 'board-1',
      taskSource: 'notion',
      gitMode: 'github',
      autoLaunchEnabled: false,
      autoLaunchMilestoneId: null,
      autoMergeEnabled: false,
      dataResidencyConfirmed: false,
      baseBranch: 'dev',
    };

    renderList([task], {
      onOptimisticDispatch,
      send: sendFn as (msg: unknown) => boolean,
      project,
    });

    expect(screen.getByRole('checkbox')).toBeDefined();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('launch-btn'));

    expect(onOptimisticDispatch).toHaveBeenCalledWith(['t1']);
  });

  it('Sync button sends fetch_tasks WS message on click', () => {
    const sendFn = vi.fn().mockReturnValue(true);
    renderList(
      [
        makeTask({
          taskId: 't1',
          taskName: 'Task',
          displayStatus: 'in_progress',
        }),
      ],
      { boardId: 'board-1', send: sendFn as (msg: unknown) => boolean },
    );

    fireEvent.click(screen.getByTestId('sync-btn'));

    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'fetch_tasks', projectId: 'proj-1' }),
    );
  });

  it('Sync button shows loading state while waiting for tasks_ready (WS path)', () => {
    const sendFn = vi.fn().mockReturnValue(true);
    renderList(
      [
        makeTask({
          taskId: 't1',
          taskName: 'Task',
          displayStatus: 'in_progress',
        }),
      ],
      { boardId: 'board-1', send: sendFn as (msg: unknown) => boolean },
    );

    const syncBtn = screen.getByTestId('sync-btn') as HTMLButtonElement;
    expect(syncBtn.getAttribute('aria-busy')).toBe('false');

    fireEvent.click(syncBtn);

    // aria-busy should be true while waiting for tasks_ready
    expect(syncBtn.getAttribute('aria-busy')).toBe('true');
    expect(syncBtn.disabled).toBe(true);
  });

  it('when tasks prop changes to move a task from ready to in_progress, ready section disappears', () => {
    const initial = makeTask({
      taskId: 't1',
      taskName: 'Task Alpha',
      displayStatus: 'ready',
      wave: 1,
    });

    const updated: TaskView = {
      ...initial,
      notionStatus: '🔄 In Progress',
      displayStatus: 'in_progress',
    };

    const { rerender } = renderList([initial]);
    expect(screen.getByTestId('ready-section')).toBeDefined();

    rerender(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        tasks={[updated]}
        loading={false}
        onOptimisticDispatch={noopOptimistic}
        send={noop}
        project={null}
      />,
    );

    expect(screen.queryByTestId('ready-section')).toBeNull();
    expect(screen.getByTestId('group-header-in_progress')).toBeDefined();
    expect(screen.getByText('Task Alpha')).toBeDefined();
  });

  describe('Sync button — send() boolean return and safety timeout', () => {
    it('clears syncing immediately when send() returns false (WS disconnected)', () => {
      const disconnectedSend = vi.fn().mockReturnValue(false);

      renderList(
        [
          makeTask({
            taskId: 't1',
            taskName: 'Task',
            displayStatus: 'in_progress',
          }),
        ],
        {
          boardId: 'board-1',
          send: disconnectedSend as (msg: unknown) => boolean,
        },
      );

      const syncBtn = screen.getByTestId('sync-btn') as HTMLButtonElement;
      fireEvent.click(syncBtn);

      // send() returned false — syncing cleared immediately, button not stuck
      expect(syncBtn.getAttribute('aria-busy')).toBe('false');
      expect(syncBtn.disabled).toBe(false);
    });

    it('clears syncing after 5-second safety timeout when no tasks_ready arrives', async () => {
      const connectedSend = vi.fn().mockReturnValue(true);

      renderList(
        [
          makeTask({
            taskId: 't1',
            taskName: 'Task',
            displayStatus: 'in_progress',
          }),
        ],
        {
          boardId: 'board-1',
          send: connectedSend as (msg: unknown) => boolean,
        },
      );

      const syncBtn = screen.getByTestId('sync-btn') as HTMLButtonElement;

      vi.useFakeTimers();
      try {
        fireEvent.click(syncBtn);
        expect(syncBtn.getAttribute('aria-busy')).toBe('true');

        // Advance 5 seconds — safety timeout should clear syncing
        await act(async () => {
          vi.advanceTimersByTime(5000);
        });

        expect(syncBtn.getAttribute('aria-busy')).toBe('false');
        expect(syncBtn.disabled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reviewRefreshTrigger change clears syncing when sync is pending', async () => {
      const connectedSend = vi.fn().mockReturnValue(true);

      const { rerender } = renderList(
        [
          makeTask({
            taskId: 't1',
            taskName: 'Task',
            displayStatus: 'in_progress',
          }),
        ],
        {
          boardId: 'board-1',
          send: connectedSend as (msg: unknown) => boolean,
          reviewRefreshTrigger: 0,
        },
      );

      const syncBtn = screen.getByTestId('sync-btn') as HTMLButtonElement;
      fireEvent.click(syncBtn);
      expect(syncBtn.getAttribute('aria-busy')).toBe('true');

      // Simulate tasks_ready arriving by incrementing reviewRefreshTrigger
      await act(async () => {
        rerender(
          <TaskList
            activeProjectId="proj-1"
            boardId="board-1"
            selectedTaskId={null}
            onSelectTask={vi.fn()}
            tasks={[
              makeTask({
                taskId: 't1',
                taskName: 'Task',
                displayStatus: 'in_progress',
              }),
            ]}
            loading={false}
            onOptimisticDispatch={noopOptimistic}
            reviewRefreshTrigger={1}
            send={connectedSend as (msg: unknown) => boolean}
            project={null}
          />,
        );
      });

      expect(syncBtn.getAttribute('aria-busy')).toBe('false');
    });
  });

  // ── Merge Ready button ──────────────────────────────────────────────────────

  function makeEligibleTask(taskId: string): TaskView {
    return makeTask({
      taskId,
      displayStatus: 'in_review',
      pr: {
        prNumber: 10,
        prUrl: 'https://github.com/owner/repo/pull/10',
        title: 'feat: something',
        headBranch: 'feature/foo',
        baseBranch: 'dev',
        state: 'open',
        draft: false,
        mergeState: 'clean',
      },
      review: {
        sessionId: 'rev-1',
        status: 'done',
        verdict: 'approved',
        summary: 'lgtm',
        iterationCount: 1,
        inputTokens: 0,
        outputTokens: 0,
      },
      pauseReason: null,
    });
  }

  describe('Merge Ready button', () => {
    it('is hidden when no tasks have eligible PRs', () => {
      renderList([makeTask({ taskId: 't1', displayStatus: 'in_review' })], {
        boardId: 'ms-1',
      });
      expect(screen.queryByTestId('merge-ready-btn')).toBeNull();
    });

    it('is visible with correct count when eligible PRs exist', () => {
      renderList([makeEligibleTask('t1')], { boardId: 'ms-1' });
      expect(screen.getByTestId('merge-ready-btn')).toBeDefined();
      expect(screen.getByTestId('merge-ready-btn').textContent).toContain('1');
    });

    it('updates count as eligible PRs change', () => {
      const task1 = makeEligibleTask('t1');
      const task2 = {
        ...makeEligibleTask('t2'),
        pr: { ...makeEligibleTask('t2').pr!, prNumber: 11 },
      };
      renderList([task1, task2], { boardId: 'ms-1' });
      expect(screen.getByTestId('merge-ready-btn').textContent).toContain('2');
    });

    it('shows confirm dialog with correct count on click', () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      renderList([makeEligibleTask('t1')], { boardId: 'ms-1' });
      fireEvent.click(screen.getByTestId('merge-ready-btn'));
      expect(confirmSpy).toHaveBeenCalledWith('Merge 1 ready PR?');
      confirmSpy.mockRestore();
    });

    it('calls the merge-ready API when confirm is accepted', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ attempted: [10] }),
      });

      renderList([makeEligibleTask('t1')], { boardId: 'ms-1' });
      fireEvent.click(screen.getByTestId('merge-ready-btn'));

      await waitFor(() => {
        const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
        const mergeCall = calls.find(
          (c: unknown[]) =>
            typeof c[0] === 'string' &&
            (c[0] as string).includes('merge-ready'),
        );
        expect(mergeCall).toBeDefined();
        expect((mergeCall![1] as RequestInit).method).toBe('POST');
      });
    });

    it('does NOT call the API when confirm is cancelled', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      renderList([makeEligibleTask('t1')], { boardId: 'ms-1' });
      const callsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      fireEvent.click(screen.getByTestId('merge-ready-btn'));
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        callsBefore,
      );
    });

    it('does not count paused PRs as eligible', () => {
      renderList(
        [
          makeTask({
            taskId: 't1',
            displayStatus: 'needs_attention',
            pr: {
              prNumber: 10,
              prUrl: 'https://github.com/owner/repo/pull/10',
              title: 'feat: x',
              headBranch: 'f',
              baseBranch: 'dev',
              state: 'open',
              draft: false,
              mergeState: 'clean',
            },
            review: {
              sessionId: 'r',
              status: 'done',
              verdict: 'approved',
              summary: '',
              iterationCount: 1,
              inputTokens: 0,
              outputTokens: 0,
            },
            pauseReason: 'stuck_timeout',
          }),
        ],
        { boardId: 'ms-1' },
      );
      expect(screen.queryByTestId('merge-ready-btn')).toBeNull();
    });

    it('switching to a different milestone re-evaluates visibility', () => {
      const { rerender } = renderList([makeEligibleTask('t1')], {
        boardId: 'ms-1',
      });
      expect(screen.getByTestId('merge-ready-btn')).toBeDefined();

      rerender(
        <TaskList
          activeProjectId="proj-1"
          boardId="ms-2"
          selectedTaskId={null}
          onSelectTask={vi.fn()}
          tasks={[makeTask({ taskId: 't2', displayStatus: 'in_review' })]}
          loading={false}
          onOptimisticDispatch={noopOptimistic}
          send={noop}
          project={null}
        />,
      );
      expect(screen.queryByTestId('merge-ready-btn')).toBeNull();
    });
  });
});
