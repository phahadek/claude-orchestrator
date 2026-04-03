import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskList } from '../TaskList';
import type { TaskView, DisplayStatus } from '../../types/taskView';

function makeTask(overrides: Partial<TaskView> & { taskId: string; displayStatus: DisplayStatus }): TaskView {
  return {
    taskName: 'Test Task',
    notionStatus: '🔄 In Progress',
    priority: '',
    notionUrl: '',
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    codeSession: null,
    pr: null,
    review: null,
    ...overrides,
  };
}

const noop = vi.fn();

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
    (fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => { /* never resolves */ }));
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} send={noop} project={null} />);
    expect(screen.getByTestId('task-list-loading')).toBeDefined();
  });

  it('renders an empty state when no active tasks exist', async () => {
    mockFetch([]);
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} send={noop} project={null} />);
    await waitFor(() => {
      expect(screen.getByTestId('task-list-empty')).toBeDefined();
    });
  });

  it('renders section headers for each non-empty display status group', async () => {
    mockFetch([
      makeTask({ taskId: 't1', taskName: 'Running Task', displayStatus: 'in_progress' }),
      makeTask({ taskId: 't2', taskName: 'Review Task',  displayStatus: 'in_review' }),
    ]);
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} send={noop} project={null} />);
    await waitFor(() => {
      expect(screen.getByText(/in progress/i)).toBeDefined();
      expect(screen.getByText(/in review/i)).toBeDefined();
    });
    // No header for groups with no tasks
    expect(screen.queryByText(/needs attention/i)).toBeNull();
    expect(screen.queryByText(/ready to merge/i)).toBeNull();
  });

  it('does not render a section header for empty groups', async () => {
    mockFetch([
      makeTask({ taskId: 't1', taskName: 'Only Task', displayStatus: 'ready' }),
    ]);
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} send={noop} project={null} />);
    await waitFor(() => {
      expect(screen.getByText(/ready/i)).toBeDefined();
    });
    expect(screen.queryByText(/in progress/i)).toBeNull();
  });

  it('sorts tasks within a group by priority — High first', async () => {
    mockFetch([
      makeTask({ taskId: 't1', taskName: 'Low Priority Task',    displayStatus: 'ready', priority: '🟢 Low' }),
      makeTask({ taskId: 't2', taskName: 'High Priority Task',   displayStatus: 'ready', priority: '🔴 High' }),
      makeTask({ taskId: 't3', taskName: 'Medium Priority Task', displayStatus: 'ready', priority: '🟡 Medium' }),
    ]);
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} send={noop} project={null} />);
    await waitFor(() => {
      expect(screen.getByText('High Priority Task')).toBeDefined();
    });
    const cards = screen.getAllByRole('generic').filter(
      (el) => el.getAttribute('data-status') === 'ready',
    );
    expect(cards[0].textContent).toContain('High Priority Task');
    expect(cards[1].textContent).toContain('Medium Priority Task');
    expect(cards[2].textContent).toContain('Low Priority Task');
  });

  it('collapses the Done group by default', async () => {
    mockFetch([
      makeTask({ taskId: 't1', taskName: 'Done Task', displayStatus: 'done' }),
    ]);
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} send={noop} project={null} />);
    await waitFor(() => {
      // The header should exist
      expect(screen.getByText(/done/i)).toBeDefined();
    });
    // But the task card itself should not be visible
    expect(screen.queryByText('Done Task')).toBeNull();
  });

  it('expands the Done group when the header is clicked', async () => {
    mockFetch([
      makeTask({ taskId: 't1', taskName: 'Completed Work', displayStatus: 'done' }),
    ]);
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} send={noop} project={null} />);
    await waitFor(() => {
      expect(screen.getByRole('button')).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Completed Work')).toBeDefined();
  });

  it('calls onSelectTask with the task id when a card is clicked', async () => {
    const onSelectTask = vi.fn();
    mockFetch([
      makeTask({ taskId: 'task-abc', taskName: 'Clickable Task', displayStatus: 'in_progress' }),
    ]);
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={onSelectTask} send={noop} project={null} />);
    await waitFor(() => {
      expect(screen.getByText('Clickable Task')).toBeDefined();
    });
    fireEvent.click(screen.getByText('Clickable Task'));
    expect(onSelectTask).toHaveBeenCalledWith('task-abc');
  });

  it('renders the empty state when activeProjectId is null', async () => {
    render(<TaskList activeProjectId={null} boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} send={noop} project={null} />);
    await waitFor(() => {
      expect(screen.getByTestId('task-list-empty')).toBeDefined();
    });
  });

  it('renders non-code tasks in a separate section, not mixed with code tasks', async () => {
    mockFetch([
      makeTask({ taskId: 't1', taskName: 'Code Task', displayStatus: 'ready', taskType: '💻 Code', notionStatus: '🗂️ Ready' }),
      makeTask({ taskId: 't2', taskName: 'Planning Task', displayStatus: 'ready', taskType: '📋 Planning', notionStatus: '🗂️ Ready' }),
    ]);
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} send={noop} project={null} />);
    await waitFor(() => {
      expect(screen.getByText('Code Task')).toBeDefined();
      expect(screen.getByText('Planning Task')).toBeDefined();
    });
    const nonCodeSection = screen.getByTestId('non-code-section');
    expect(nonCodeSection.textContent).toContain('Planning Task');
    expect(nonCodeSection.textContent).not.toContain('Code Task');
  });

  it('non-code tasks in separate section do not render a Launch button', async () => {
    mockFetch([
      makeTask({ taskId: 't1', taskName: 'Planning Task', displayStatus: 'ready', taskType: '📋 Planning', notionStatus: '🗂️ Ready' }),
    ]);
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} send={noop} project={null} />);
    await waitFor(() => {
      expect(screen.getByTestId('non-code-section')).toBeDefined();
    });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('non-code task section header shows the count', async () => {
    mockFetch([
      makeTask({ taskId: 't1', taskName: 'Planning Task 1', displayStatus: 'ready', taskType: '📋 Planning', notionStatus: '🗂️ Ready' }),
      makeTask({ taskId: 't2', taskName: 'Testing Task', displayStatus: 'ready', taskType: '🧪 Testing', notionStatus: '🗂️ Ready' }),
    ]);
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} send={noop} project={null} />);
    await waitFor(() => {
      const nonCodeSection = screen.getByTestId('non-code-section');
      expect(nonCodeSection.textContent).toContain('2');
    });
  });

  it('triggers a re-fetch when reviewRefreshTrigger changes (pr_review_complete scenario)', async () => {
    const task = makeTask({ taskId: 't1', taskName: 'Task A', displayStatus: 'in_review' });
    const updatedTask = makeTask({ taskId: 't1', taskName: 'Task A (reviewed)', displayStatus: 'needs_attention' });

    // First fetch returns initial task list
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [task] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [updatedTask] });

    const { rerender } = render(
      <TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} reviewRefreshTrigger={0} send={noop} project={null} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Task A')).toBeDefined();
    });

    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(
        <TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} reviewRefreshTrigger={1} send={noop} project={null} />,
      );
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Task A (reviewed)')).toBeDefined();
    });
  });

  it('triggers a re-fetch when reviewRefreshTrigger changes (session_started review scenario)', async () => {
    const task = makeTask({ taskId: 't2', taskName: 'Task B', displayStatus: 'in_progress' });
    const withReview = makeTask({ taskId: 't2', taskName: 'Task B', displayStatus: 'in_review', review: { sessionId: 'rev-1', status: 'running', verdict: null, summary: null, iterationCount: 1 } });

    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [task] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [withReview] });

    const { rerender } = render(
      <TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} reviewRefreshTrigger={0} send={noop} project={null} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Task B')).toBeDefined();
    });

    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(
        <TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} reviewRefreshTrigger={1} send={noop} project={null} />,
      );
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  it('patches an existing task in-place when lastTaskUpdate changes', async () => {
    const initial = makeTask({ taskId: 't1', taskName: 'Old Name', displayStatus: 'ready' });
    mockFetch([initial]);

    const updated = makeTask({ taskId: 't1', taskName: 'Updated Name', displayStatus: 'in_progress' });

    const { rerender } = render(
      <TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} lastTaskUpdate={null} send={noop} project={null} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Old Name')).toBeDefined();
    });

    act(() => {
      rerender(
        <TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} lastTaskUpdate={updated} send={noop} project={null} />,
      );
    });

    expect(screen.getByText('Updated Name')).toBeDefined();
    expect(screen.queryByText('Old Name')).toBeNull();
  });
});
