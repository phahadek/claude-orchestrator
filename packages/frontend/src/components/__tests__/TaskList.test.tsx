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

function mockFetch(tasks: TaskView[]) {
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => tasks,
  });
}

describe('TaskList', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a loading indicator while tasks are being fetched', () => {
    (fetch as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {
        /* never resolves */
      }),
    );
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    expect(screen.getByTestId('task-list-loading')).toBeDefined();
  });

  it('renders an empty state when no active tasks exist', async () => {
    mockFetch([]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('task-list-empty')).toBeDefined();
    });
  });

  it('renders section headers for each non-empty display status group', async () => {
    mockFetch([
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
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    // Status badges inside task cards also contain status text, so target the
    // dedicated group-header testids rather than free-text matches.
    await waitFor(() => {
      expect(screen.getByTestId('group-header-in_progress')).toBeDefined();
      expect(screen.getByTestId('group-header-in_review')).toBeDefined();
    });
    // No header for groups with no tasks
    expect(screen.queryByTestId('group-header-needs_attention')).toBeNull();
    expect(screen.queryByTestId('group-header-ready_to_merge')).toBeNull();
  });

  it('shows Ready section header when there are ready tasks', async () => {
    mockFetch([
      makeTask({ taskId: 't1', taskName: 'Only Task', displayStatus: 'ready' }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('ready-section')).toBeDefined();
      expect(screen.getByText(/ready/i)).toBeDefined();
    });
    expect(screen.queryByText(/in progress/i)).toBeNull();
  });

  it('renders ready tasks in compact row format (CompactTaskCard), not full TaskCard', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Ready Task',
        displayStatus: 'ready',
        wave: 1,
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('compact-task-card')).toBeDefined();
      expect(screen.getByText('Ready Task')).toBeDefined();
    });
  });

  it('groups ready code tasks under correct wave headers', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Wave 1 Task',
        displayStatus: 'ready',
        wave: 1,
        blocked: false,
      }),
      makeTask({
        taskId: 't2',
        taskName: 'Wave 2 Task',
        displayStatus: 'ready',
        wave: 2,
        blocked: true,
        blockerNames: ['Wave 1 Task'],
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('wave-group-1')).toBeDefined();
      expect(screen.getByTestId('wave-group-2')).toBeDefined();
    });
    // Wave 2+ groups start collapsed — expand to verify the task is grouped under it
    fireEvent.click(screen.getByTestId('wave-header-2'));
    expect(screen.getByTestId('wave-group-1').textContent).toContain(
      'Wave 1 Task',
    );
    expect(screen.getByTestId('wave-group-2').textContent).toContain(
      'Wave 2 Task',
    );
  });

  it('Wave 2+ tasks render with blocked CSS class', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Blocked Task',
        displayStatus: 'ready',
        wave: 2,
        blocked: true,
        blockerNames: ['Other'],
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('wave-header-2')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('wave-header-2'));
    expect(screen.getByTestId('compact-task-card').className).toContain(
      'blocked',
    );
  });

  it('Wave 2+ tasks show blocker names', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Blocked Task',
        displayStatus: 'ready',
        wave: 2,
        blocked: true,
        blockerNames: ['Task Alpha'],
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('wave-header-2')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('wave-header-2'));
    expect(screen.getByTestId('blocker-names').textContent).toContain(
      'Task Alpha',
    );
  });

  it('Wave 2+ tasks do NOT render checkboxes', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Blocked Task',
        displayStatus: 'ready',
        wave: 2,
        blocked: true,
        blockerNames: ['Other'],
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('wave-header-2')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('wave-header-2'));
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('Wave 1 code tasks render with a checkbox', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Launchable Task',
        displayStatus: 'ready',
        wave: 1,
        blocked: false,
        taskType: '💻 Code',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('checkbox')).toBeDefined();
    });
  });

  it('non-code ready tasks are in the Non-Code sub-group within the Ready section with no checkboxes', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Code Task',
        displayStatus: 'ready',
        taskType: '💻 Code',
        wave: 1,
      }),
      makeTask({
        taskId: 't2',
        taskName: 'Planning Task',
        displayStatus: 'ready',
        taskType: '📋 Planning',
        notionStatus: '🗂️ Ready',
        wave: 1,
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('non-code-wave-group')).toBeDefined();
    });
    const nonCodeGroup = screen.getByTestId('non-code-wave-group');
    expect(nonCodeGroup.textContent).toContain('Planning Task');
    expect(nonCodeGroup.textContent).not.toContain('Code Task');
    // No checkbox inside the non-code sub-group's task cards
    // (only wave-1 code task has a checkbox)
    const checkboxes = screen.getAllByRole('checkbox');
    // Only the code task should have a checkbox
    expect(checkboxes).toHaveLength(1);
  });

  it('renders non-ready non-code tasks in a separate section at the bottom', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Code Task',
        displayStatus: 'in_progress',
        taskType: '💻 Code',
      }),
      makeTask({
        taskId: 't2',
        taskName: 'Planning Task',
        displayStatus: 'in_progress',
        taskType: '📋 Planning',
        notionStatus: '🔄 In Progress',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('non-code-section')).toBeDefined();
    });
    const nonCodeSection = screen.getByTestId('non-code-section');
    expect(nonCodeSection.textContent).toContain('Planning Task');
    expect(nonCodeSection.textContent).not.toContain('Code Task');
  });

  it('"Select All" button only selects Wave 1 code tasks', async () => {
    mockFetch([
      makeTask({
        taskId: 'w1-1',
        taskName: 'Wave 1 Task',
        displayStatus: 'ready',
        wave: 1,
        blocked: false,
        taskType: '💻 Code',
      }),
      makeTask({
        taskId: 'w2-1',
        taskName: 'Wave 2 Task',
        displayStatus: 'ready',
        wave: 2,
        blocked: true,
        blockerNames: ['Other'],
        taskType: '💻 Code',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('select-all-btn')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('select-all-btn'));
    // Only wave 1 checkbox should be checked
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(1); // only wave 1 has a checkbox
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
  });

  it('"Launch (N)" button is disabled when no tasks are checked', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Task',
        displayStatus: 'ready',
        wave: 1,
        blocked: false,
        taskType: '💻 Code',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('launch-btn')).toBeDefined();
    });
    const launchBtn = screen.getByTestId('launch-btn') as HTMLButtonElement;
    expect(launchBtn.disabled).toBe(true);
  });

  it('"Launch (N)" button becomes enabled and shows count when tasks are checked', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Task',
        displayStatus: 'ready',
        wave: 1,
        blocked: false,
        taskType: '💻 Code',
        notionUrl: 'https://notion.so/t1',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('checkbox')).toBeDefined();
    });
    fireEvent.click(screen.getByRole('checkbox'));
    const launchBtn = screen.getByTestId('launch-btn') as HTMLButtonElement;
    expect(launchBtn.disabled).toBe(false);
    expect(launchBtn.textContent).toContain('1');
  });

  it('sorts ready tasks within a wave by priority — High first', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Low Priority Task',
        displayStatus: 'ready',
        priority: '🟢 Low',
        wave: 1,
      }),
      makeTask({
        taskId: 't2',
        taskName: 'High Priority Task',
        displayStatus: 'ready',
        priority: '🔴 High',
        wave: 1,
      }),
      makeTask({
        taskId: 't3',
        taskName: 'Medium Priority Task',
        displayStatus: 'ready',
        priority: '🟡 Medium',
        wave: 1,
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('High Priority Task')).toBeDefined();
    });
    const cards = screen.getAllByTestId('compact-task-card');
    // Wave 1 tasks sorted by priority
    expect(cards[0].textContent).toContain('High Priority Task');
    expect(cards[1].textContent).toContain('Medium Priority Task');
    expect(cards[2].textContent).toContain('Low Priority Task');
  });

  it('clicking a non-done group header collapses it (toggles collapsed state)', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Running Task',
        displayStatus: 'in_progress',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('group-header-in_progress')).toBeDefined();
    });
    // Initially expanded
    const header = screen.getByTestId('group-header-in_progress');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Running Task')).toBeDefined();
    // Click to collapse
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Running Task')).toBeNull();
    // Click again to expand
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Running Task')).toBeDefined();
  });

  it('collapsed group does not render its task list children', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'In Review Task',
        displayStatus: 'in_review',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('group-header-in_review')).toBeDefined();
    });
    // Collapse the group
    fireEvent.click(screen.getByTestId('group-header-in_review'));
    // Task card should not be rendered
    expect(screen.queryByText('In Review Task')).toBeNull();
  });

  it('expanded group renders all task items', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Task Alpha',
        displayStatus: 'in_progress',
      }),
      makeTask({
        taskId: 't2',
        taskName: 'Task Beta',
        displayStatus: 'in_progress',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Task Alpha')).toBeDefined();
      expect(screen.getByText('Task Beta')).toBeDefined();
    });
  });

  it('toggle icon changes between expanded and collapsed states', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Some Task',
        displayStatus: 'in_progress',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('group-header-in_progress')).toBeDefined();
    });
    const header = screen.getByTestId('group-header-in_progress');
    // Expanded by default: shows ▼
    expect(header.textContent).toContain('▼');
    // Collapse: shows ▶
    fireEvent.click(header);
    expect(header.textContent).toContain('▶');
    expect(header.textContent).not.toContain('▼');
  });

  it('collapses the Done group by default', async () => {
    mockFetch([
      makeTask({ taskId: 't1', taskName: 'Done Task', displayStatus: 'done' }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      // The header should exist
      expect(screen.getByText(/done/i)).toBeDefined();
    });
    // But the task card itself should not be visible
    expect(screen.queryByText('Done Task')).toBeNull();
  });

  it('expands the Done group when the header is clicked', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Completed Work',
        displayStatus: 'done',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('group-header-done')).toBeDefined();
    });
    fireEvent.click(screen.getByTestId('group-header-done'));
    expect(screen.getByText('Completed Work')).toBeDefined();
  });

  it('calls onSelectTask with the task id when a ready card is clicked', async () => {
    const onSelectTask = vi.fn();
    mockFetch([
      makeTask({
        taskId: 'task-abc',
        taskName: 'Clickable Task',
        displayStatus: 'ready',
        wave: 1,
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={onSelectTask}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Clickable Task')).toBeDefined();
    });
    fireEvent.click(screen.getByText('Clickable Task'));
    expect(onSelectTask).toHaveBeenCalledWith('task-abc');
  });

  it('calls onSelectTask with the task id when an in-progress card is clicked', async () => {
    const onSelectTask = vi.fn();
    mockFetch([
      makeTask({
        taskId: 'task-abc',
        taskName: 'Clickable Task',
        displayStatus: 'in_progress',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={onSelectTask}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Clickable Task')).toBeDefined();
    });
    fireEvent.click(screen.getByText('Clickable Task'));
    expect(onSelectTask).toHaveBeenCalledWith('task-abc');
  });

  it('renders the empty state when activeProjectId is null', async () => {
    render(
      <TaskList
        activeProjectId={null}
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('task-list-empty')).toBeDefined();
    });
  });

  it('triggers a re-fetch when reviewRefreshTrigger changes (pr_review_complete scenario)', async () => {
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

    // First fetch returns initial task list
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [task],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [updatedTask],
      });

    const { rerender } = render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        reviewRefreshTrigger={0}
        send={noop}
        project={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Task A')).toBeDefined();
    });

    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(
        <TaskList
          activeProjectId="proj-1"
          boardId={null}
          selectedTaskId={null}
          onSelectTask={vi.fn()}
          reviewRefreshTrigger={1}
          send={noop}
          project={null}
        />,
      );
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Task A (reviewed)')).toBeDefined();
    });
  });

  it('triggers a re-fetch when reviewRefreshTrigger changes (session_started review scenario)', async () => {
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

    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [task],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [withReview],
      });

    const { rerender } = render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        reviewRefreshTrigger={0}
        send={noop}
        project={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Task B')).toBeDefined();
    });

    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(
        <TaskList
          activeProjectId="proj-1"
          boardId={null}
          selectedTaskId={null}
          onSelectTask={vi.fn()}
          reviewRefreshTrigger={1}
          send={noop}
          project={null}
        />,
      );
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  it('Ready group header renders with role="button" and aria-expanded', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Ready Task',
        displayStatus: 'ready',
        wave: 1,
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('group-header-ready')).toBeDefined();
    });
    const header = screen.getByTestId('group-header-ready');
    expect(header.getAttribute('role')).toBe('button');
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('clicking Ready group header toggles aria-expanded between true and false', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Ready Task',
        displayStatus: 'ready',
        wave: 1,
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('group-header-ready')).toBeDefined();
    });
    const header = screen.getByTestId('group-header-ready');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('when Ready is collapsed, wave cards are not rendered', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Ready Task',
        displayStatus: 'ready',
        wave: 1,
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('group-header-ready')).toBeDefined();
    });
    // Initially visible
    expect(screen.getByText('Ready Task')).toBeDefined();
    // Collapse
    fireEvent.click(screen.getByTestId('group-header-ready'));
    expect(screen.queryByText('Ready Task')).toBeNull();
  });

  it('Launch button click does NOT trigger collapse toggle (stopPropagation)', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Ready Task',
        displayStatus: 'ready',
        wave: 1,
        taskType: '💻 Code',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('launch-btn')).toBeDefined();
    });
    const header = screen.getByTestId('group-header-ready');
    // Initially expanded
    expect(header.getAttribute('aria-expanded')).toBe('true');
    // Click the launch button — should NOT collapse
    fireEvent.click(screen.getByTestId('launch-btn'));
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('Planning/Testing group header renders with role="button" and aria-expanded', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Planning Task',
        displayStatus: 'in_progress',
        taskType: '📋 Planning',
        notionStatus: '🔄 In Progress',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('group-header-planning')).toBeDefined();
    });
    const header = screen.getByTestId('group-header-planning');
    expect(header.getAttribute('role')).toBe('button');
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('clicking Planning/Testing header toggles visibility of its task cards', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Planning Task',
        displayStatus: 'in_progress',
        taskType: '📋 Planning',
        notionStatus: '🔄 In Progress',
      }),
    ]);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={noop}
        project={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('group-header-planning')).toBeDefined();
    });
    expect(screen.getByText('Planning Task')).toBeDefined();
    fireEvent.click(screen.getByTestId('group-header-planning'));
    expect(screen.queryByText('Planning Task')).toBeNull();
    fireEvent.click(screen.getByTestId('group-header-planning'));
    expect(screen.getByText('Planning Task')).toBeDefined();
  });

  it('patches an existing task in-place when lastTaskUpdate changes', async () => {
    const initial = makeTask({
      taskId: 't1',
      taskName: 'Old Name',
      displayStatus: 'ready',
      wave: 1,
    });
    mockFetch([initial]);

    const updated = makeTask({
      taskId: 't1',
      taskName: 'Updated Name',
      displayStatus: 'in_progress',
      wave: 1,
    });

    const { rerender } = render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        lastTaskUpdate={null}
        send={noop}
        project={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Old Name')).toBeDefined();
    });

    act(() => {
      rerender(
        <TaskList
          activeProjectId="proj-1"
          boardId={null}
          selectedTaskId={null}
          onSelectTask={vi.fn()}
          lastTaskUpdate={updated}
          send={noop}
          project={null}
        />,
      );
    });

    expect(screen.getByText('Updated Name')).toBeDefined();
    expect(screen.queryByText('Old Name')).toBeNull();
  });

  it('task_updated for an unknown task ID does not crash or add a phantom entry', async () => {
    const initial = makeTask({
      taskId: 't1',
      taskName: 'Known Task',
      displayStatus: 'in_progress',
    });
    mockFetch([initial]);

    const phantom = makeTask({
      taskId: 'unknown-id',
      taskName: 'Phantom Task',
      displayStatus: 'in_progress',
    });

    const { rerender } = render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        lastTaskUpdate={null}
        send={noop}
        project={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Known Task')).toBeDefined();
    });

    act(() => {
      rerender(
        <TaskList
          activeProjectId="proj-1"
          boardId={null}
          selectedTaskId={null}
          onSelectTask={vi.fn()}
          lastTaskUpdate={phantom}
          send={noop}
          project={null}
        />,
      );
    });

    // Phantom task should not appear in the list
    expect(screen.queryByText('Phantom Task')).toBeNull();
    // Known task is still present
    expect(screen.getByText('Known Task')).toBeDefined();
  });

  it('dispatching tasks updates local state to In Progress immediately', async () => {
    const task = makeTask({
      taskId: 't1',
      taskName: 'Ready Task',
      displayStatus: 'ready',
      wave: 1,
      blocked: false,
      taskType: '💻 Code',
      notionUrl: 'https://notion.so/t1',
    });
    mockFetch([task]);
    const sendFn = vi.fn();
    const project: ProjectConfig = {
      id: 'proj-1',
      name: 'Test',
      projectDir: '/tmp/test',
      contextUrl: 'https://notion.so/ctx',
      boardId: 'board-1',
      taskSource: 'notion',
      autoLaunchEnabled: false,
      autoLaunchMilestoneId: null,
    };

    render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={sendFn}
        project={project}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('checkbox')).toBeDefined();
    });

    // Check the task and launch
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('launch-btn'));

    // Ready section should disappear (task moved to in_progress)
    await waitFor(() => {
      expect(screen.queryByTestId('ready-section')).toBeNull();
    });
    // Task should appear in the In Progress group header
    expect(screen.getByTestId('group-header-in_progress')).toBeDefined();
  });

  it('Sync button sends fetch_tasks WS message on click', async () => {
    mockFetch([
      makeTask({
        taskId: 't1',
        taskName: 'Task',
        displayStatus: 'in_progress',
      }),
    ]);
    const sendFn = vi.fn().mockReturnValue(true);
    render(
      <TaskList
        activeProjectId="proj-1"
        boardId="board-1"
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={sendFn}
        project={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('sync-btn')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('sync-btn'));

    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'fetch_tasks', projectId: 'proj-1' }),
    );
  });

  it('Sync button shows loading state while fetch is in flight', async () => {
    // First fetch resolves (initial load)
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] })
      // Second fetch (triggered by sync) never resolves — keeps syncing state
      .mockReturnValueOnce(
        new Promise(() => {
          /* never resolves */
        }),
      );

    render(
      <TaskList
        activeProjectId="proj-1"
        boardId="board-1"
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        send={vi.fn().mockReturnValue(true)}
        project={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('sync-btn')).toBeDefined();
    });

    const syncBtn = screen.getByTestId('sync-btn') as HTMLButtonElement;
    expect(syncBtn.getAttribute('aria-busy')).toBe('false');

    fireEvent.click(syncBtn);

    // aria-busy should be true while fetch is pending
    expect(syncBtn.getAttribute('aria-busy')).toBe('true');
    expect(syncBtn.disabled).toBe(true);
  });

  it('task_updated WS message updates the matching task status in local state', async () => {
    const initial = makeTask({
      taskId: 't1',
      taskName: 'Task Alpha',
      displayStatus: 'ready',
      wave: 1,
    });
    mockFetch([initial]);

    const updated: TaskView = {
      ...initial,
      notionStatus: '🔄 In Progress',
      displayStatus: 'in_progress',
    };

    const { rerender } = render(
      <TaskList
        activeProjectId="proj-1"
        boardId={null}
        selectedTaskId={null}
        onSelectTask={vi.fn()}
        lastTaskUpdate={null}
        send={noop}
        project={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('ready-section')).toBeDefined();
    });

    act(() => {
      rerender(
        <TaskList
          activeProjectId="proj-1"
          boardId={null}
          selectedTaskId={null}
          onSelectTask={vi.fn()}
          lastTaskUpdate={updated}
          send={noop}
          project={null}
        />,
      );
    });

    // Task moved from Ready to In Progress — ready section gone, in_progress group visible
    expect(screen.queryByTestId('ready-section')).toBeNull();
    expect(screen.getByTestId('group-header-in_progress')).toBeDefined();
    expect(screen.getByText('Task Alpha')).toBeDefined();
  });

  describe('Sync button — send() boolean return and safety timeout', () => {
    it('clears syncing immediately when send() returns false (WS disconnected)', async () => {
      mockFetch([
        makeTask({
          taskId: 't1',
          taskName: 'Task',
          displayStatus: 'in_progress',
        }),
      ]);
      const disconnectedSend = vi.fn().mockReturnValue(false);

      render(
        <TaskList
          activeProjectId="proj-1"
          boardId={null}
          selectedTaskId={null}
          onSelectTask={vi.fn()}
          send={disconnectedSend}
          project={null}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('sync-btn')).toBeDefined();
      });

      const syncBtn = screen.getByTestId('sync-btn') as HTMLButtonElement;
      await act(async () => {
        fireEvent.click(syncBtn);
      });

      // send() returned false — syncing cleared immediately, button not stuck
      expect(syncBtn.getAttribute('aria-busy')).toBe('false');
      expect(syncBtn.disabled).toBe(false);
    });

    it('clears syncing after 5-second safety timeout when no tasks_ready arrives', async () => {
      mockFetch([
        makeTask({
          taskId: 't1',
          taskName: 'Task',
          displayStatus: 'in_progress',
        }),
      ]);
      const connectedSend = vi.fn().mockReturnValue(true);

      render(
        <TaskList
          activeProjectId="proj-1"
          boardId="board-1"
          selectedTaskId={null}
          onSelectTask={vi.fn()}
          send={connectedSend}
          project={null}
        />,
      );

      // Wait for initial render with real timers
      await waitFor(() => {
        expect(screen.getByTestId('sync-btn')).toBeDefined();
      });

      const syncBtn = screen.getByTestId('sync-btn') as HTMLButtonElement;

      // Switch to fake timers only after component is ready
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
  });
});
