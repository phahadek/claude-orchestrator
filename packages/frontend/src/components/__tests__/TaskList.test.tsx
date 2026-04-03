import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskList } from '../TaskList';
import type { TaskView, DisplayStatus } from '../../types/taskView';

function makeTask(overrides: Partial<TaskView> & { taskId: string; displayStatus: DisplayStatus }): TaskView {
  return {
    taskName: 'Test Task',
    notionStatus: '🔄 In Progress',
    priority: '',
    notionUrl: '',
    codeSession: null,
    pr: null,
    review: null,
    ...overrides,
  };
}

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
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders a loading indicator while tasks are being fetched', () => {
    (fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => { /* never resolves */ }));
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} />);
    expect(screen.getByTestId('task-list-loading')).toBeDefined();
  });

  it('renders an empty state when no active tasks exist', async () => {
    mockFetch([]);
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('task-list-empty')).toBeDefined();
    });
  });

  it('renders section headers for each non-empty display status group', async () => {
    mockFetch([
      makeTask({ taskId: 't1', taskName: 'Running Task', displayStatus: 'in_progress' }),
      makeTask({ taskId: 't2', taskName: 'Review Task',  displayStatus: 'in_review' }),
    ]);
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} />);
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
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} />);
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
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} />);
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
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} />);
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
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} />);
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
    render(<TaskList activeProjectId="proj-1" boardId={null} selectedTaskId={null} onSelectTask={onSelectTask} />);
    await waitFor(() => {
      expect(screen.getByText('Clickable Task')).toBeDefined();
    });
    fireEvent.click(screen.getByText('Clickable Task'));
    expect(onSelectTask).toHaveBeenCalledWith('task-abc');
  });

  it('renders the empty state when activeProjectId is null', async () => {
    render(<TaskList activeProjectId={null} boardId={null} selectedTaskId={null} onSelectTask={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('task-list-empty')).toBeDefined();
    });
  });
});
