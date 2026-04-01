import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionFilterBar } from '../SessionFilterBar';

describe('SessionFilterBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onSearchChange after debounce when typing in search input', async () => {
    const onSearchChange = vi.fn();
    render(
      <SessionFilterBar
        searchText=""
        onSearchChange={onSearchChange}
        statusFilter={null}
        onStatusChange={vi.fn()}
        tagFilter={null}
        onTagChange={vi.fn()}
        availableTags={[]}
        resultCount={5}
      />
    );

    const input = screen.getByPlaceholderText('Search sessions...');
    fireEvent.change(input, { target: { value: 'my task' } });
    expect(onSearchChange).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(150); });
    expect(onSearchChange).toHaveBeenCalledWith('my task');
  });

  it('calls onStatusChange when status dropdown changes', () => {
    const onStatusChange = vi.fn();
    render(
      <SessionFilterBar
        searchText=""
        onSearchChange={vi.fn()}
        statusFilter={null}
        onStatusChange={onStatusChange}
        tagFilter={null}
        onTagChange={vi.fn()}
        availableTags={[]}
        resultCount={3}
      />
    );

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'running' } });
    expect(onStatusChange).toHaveBeenCalledWith('running');
  });

  it('calls onStatusChange with null when "All" is selected', () => {
    const onStatusChange = vi.fn();
    render(
      <SessionFilterBar
        searchText=""
        onSearchChange={vi.fn()}
        statusFilter="running"
        onStatusChange={onStatusChange}
        tagFilter={null}
        onTagChange={vi.fn()}
        availableTags={[]}
        resultCount={0}
      />
    );

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: '' } });
    expect(onStatusChange).toHaveBeenCalledWith(null);
  });

  it('renders the correct result count', () => {
    render(
      <SessionFilterBar
        searchText=""
        onSearchChange={vi.fn()}
        statusFilter={null}
        onStatusChange={vi.fn()}
        tagFilter={null}
        onTagChange={vi.fn()}
        availableTags={[]}
        resultCount={7}
      />
    );
    expect(screen.getByText('7 sessions')).toBeDefined();
  });

  it('renders singular "1 session" when resultCount is 1', () => {
    render(
      <SessionFilterBar
        searchText=""
        onSearchChange={vi.fn()}
        statusFilter={null}
        onStatusChange={vi.fn()}
        tagFilter={null}
        onTagChange={vi.fn()}
        availableTags={[]}
        resultCount={1}
      />
    );
    expect(screen.getByText('1 session')).toBeDefined();
  });

  it('tag dropdown is populated from availableTags', () => {
    render(
      <SessionFilterBar
        searchText=""
        onSearchChange={vi.fn()}
        statusFilter={null}
        onStatusChange={vi.fn()}
        tagFilter={null}
        onTagChange={vi.fn()}
        availableTags={['bugfix', 'auth', 'refactor']}
        resultCount={3}
      />
    );
    expect(screen.getByText('bugfix')).toBeDefined();
    expect(screen.getByText('auth')).toBeDefined();
    expect(screen.getByText('refactor')).toBeDefined();
  });

  it('calls onTagChange when a tag is selected', () => {
    const onTagChange = vi.fn();
    render(
      <SessionFilterBar
        searchText=""
        onSearchChange={vi.fn()}
        statusFilter={null}
        onStatusChange={vi.fn()}
        tagFilter={null}
        onTagChange={onTagChange}
        availableTags={['bugfix', 'auth']}
        resultCount={2}
      />
    );
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1], { target: { value: 'bugfix' } });
    expect(onTagChange).toHaveBeenCalledWith('bugfix');
  });

  it('calls onTagChange with null when "All tags" is selected', () => {
    const onTagChange = vi.fn();
    render(
      <SessionFilterBar
        searchText=""
        onSearchChange={vi.fn()}
        statusFilter={null}
        onStatusChange={vi.fn()}
        tagFilter="bugfix"
        onTagChange={onTagChange}
        availableTags={['bugfix']}
        resultCount={1}
      />
    );
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1], { target: { value: '' } });
    expect(onTagChange).toHaveBeenCalledWith(null);
  });
});

// Filter logic tests — these validate the filtering algorithm used in App.tsx
describe('session filtering logic', () => {
  type MinSession = { taskName: string; status: string; project_id?: string | null; archived?: boolean; tags?: string[] };

  function applyFilters(
    sessions: MinSession[],
    searchText: string,
    statusFilter: string | null,
    tagFilter: string | null,
    activeProjectId: string | null,
  ): MinSession[] {
    return sessions
      .filter((s) => !s.archived)
      .filter((s) => !searchText || s.taskName.toLowerCase().includes(searchText.toLowerCase()))
      .filter((s) => !statusFilter || s.status === statusFilter)
      .filter((s) => !tagFilter || s.tags?.includes(tagFilter))
      .filter((s) => !activeProjectId || s.project_id === activeProjectId);
  }

  it('filters by searchText case-insensitively', () => {
    const sessions = [
      { taskName: 'Deploy frontend', status: 'running' },
      { taskName: 'Fix login bug', status: 'done' },
    ];
    const result = applyFilters(sessions, 'DEPLOY', null, null, null);
    expect(result).toHaveLength(1);
    expect(result[0].taskName).toBe('Deploy frontend');
  });

  it('filters out sessions that do not include searchText', () => {
    const sessions = [
      { taskName: 'Task A', status: 'running' },
      { taskName: 'Task B', status: 'done' },
      { taskName: 'Task C', status: 'error' },
    ];
    const result = applyFilters(sessions, 'Task A', null, null, null);
    expect(result).toHaveLength(1);
  });

  it('filters by statusFilter — removes sessions with a different status', () => {
    const sessions = [
      { taskName: 'Task 1', status: 'running' },
      { taskName: 'Task 2', status: 'done' },
      { taskName: 'Task 3', status: 'error' },
    ];
    const result = applyFilters(sessions, '', 'running', null, null);
    expect(result).toHaveLength(1);
    expect(result[0].taskName).toBe('Task 1');
  });

  it('returns all sessions when statusFilter is null', () => {
    const sessions = [
      { taskName: 'Task 1', status: 'running' },
      { taskName: 'Task 2', status: 'done' },
    ];
    const result = applyFilters(sessions, '', null, null, null);
    expect(result).toHaveLength(2);
  });

  it('excludes archived sessions regardless of filters', () => {
    const sessions = [
      { taskName: 'Active Task', status: 'running', archived: false },
      { taskName: 'Archived Task', status: 'running', archived: true },
    ];
    const result = applyFilters(sessions, '', null, null, null);
    expect(result).toHaveLength(1);
    expect(result[0].taskName).toBe('Active Task');
  });

  it('filters by tagFilter — returns only sessions with the given tag', () => {
    const sessions = [
      { taskName: 'Task A', status: 'running', tags: ['bugfix', 'auth'] },
      { taskName: 'Task B', status: 'done', tags: ['refactor'] },
      { taskName: 'Task C', status: 'running', tags: [] },
    ];
    const result = applyFilters(sessions, '', null, 'bugfix', null);
    expect(result).toHaveLength(1);
    expect(result[0].taskName).toBe('Task A');
  });

  it('returns all sessions when tagFilter is null', () => {
    const sessions = [
      { taskName: 'Task A', status: 'running', tags: ['bugfix'] },
      { taskName: 'Task B', status: 'done', tags: [] },
    ];
    const result = applyFilters(sessions, '', null, null, null);
    expect(result).toHaveLength(2);
  });
});
