import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionGrid } from '../SessionGrid';
import type { SessionState } from '../../hooks/useSessionStore';

function makeSession(
  overrides: Partial<SessionState> & { sessionId: string },
): SessionState {
  return {
    taskName: 'Test Task',
    notionTaskUrl: 'https://notion.so/task',
    status: 'running',
    events: [],
    ...overrides,
  };
}

describe('SessionGrid', () => {
  it('renders all sessions as cards', () => {
    const sessions = [
      makeSession({ sessionId: 's1', taskName: 'Task One', status: 'running' }),
      makeSession({ sessionId: 's2', taskName: 'Task Two', status: 'done' }),
    ];
    render(
      <SessionGrid
        sessions={sessions}
        projects={[]}
        onSelect={vi.fn()}
        selectedId={null}
        keyboardSelectedId={null}
        synced={true}
        onArchiveAll={vi.fn()}
      />,
    );
    expect(screen.getByText('Task One')).toBeDefined();
    expect(screen.getByText('Task Two')).toBeDefined();
  });

  it('sorts cards by status rank — needs_permission always first', () => {
    const sessions = [
      makeSession({ sessionId: 's1', taskName: 'Done Task', status: 'done' }),
      makeSession({
        sessionId: 's2',
        taskName: 'Running Task',
        status: 'running',
      }),
      makeSession({
        sessionId: 's3',
        taskName: 'Permission Task',
        status: 'needs_permission',
      }),
      makeSession({
        sessionId: 's4',
        taskName: 'Starting Task',
        status: 'starting',
      }),
    ];
    render(
      <SessionGrid
        sessions={sessions}
        projects={[]}
        onSelect={vi.fn()}
        selectedId={null}
        keyboardSelectedId={null}
        synced={true}
        onArchiveAll={vi.fn()}
      />,
    );
    const cards = screen
      .getAllByRole('generic')
      .filter((el) => el.className?.includes('session-card'));
    // First card should contain the needs_permission task
    expect(cards[0].textContent).toContain('Permission Task');
  });

  it('renders empty state placeholder when sessions list is empty', () => {
    render(
      <SessionGrid
        sessions={[]}
        projects={[]}
        onSelect={vi.fn()}
        selectedId={null}
        keyboardSelectedId={null}
        synced={true}
        onArchiveAll={vi.fn()}
      />,
    );
    expect(screen.getByText(/no sessions yet/i)).toBeDefined();
  });

  it('renders filter empty state when sessions is empty and filtersActive is true', () => {
    render(
      <SessionGrid
        sessions={[]}
        projects={[]}
        onSelect={vi.fn()}
        selectedId={null}
        keyboardSelectedId={null}
        synced={true}
        onArchiveAll={vi.fn()}
        filtersActive={true}
        onClearFilters={vi.fn()}
      />,
    );
    expect(screen.getByText(/no sessions match your filters/i)).toBeDefined();
    expect(
      screen.getByRole('button', { name: /clear filters/i }),
    ).toBeDefined();
  });

  it('calls onClearFilters when Clear filters button is clicked', () => {
    const onClearFilters = vi.fn();
    render(
      <SessionGrid
        sessions={[]}
        projects={[]}
        onSelect={vi.fn()}
        selectedId={null}
        keyboardSelectedId={null}
        synced={true}
        onArchiveAll={vi.fn()}
        filtersActive={true}
        onClearFilters={onClearFilters}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(onClearFilters).toHaveBeenCalledOnce();
  });

  it('sorts favorited sessions before non-favorited regardless of status rank', () => {
    const sessions = [
      makeSession({
        sessionId: 's1',
        taskName: 'Running Task',
        status: 'running',
        favorited: false,
      }),
      makeSession({
        sessionId: 's2',
        taskName: 'Favorited Done',
        status: 'done',
        favorited: true,
      }),
      makeSession({
        sessionId: 's3',
        taskName: 'Permission Task',
        status: 'needs_permission',
        favorited: false,
      }),
    ];
    render(
      <SessionGrid
        sessions={sessions}
        projects={[]}
        onSelect={vi.fn()}
        selectedId={null}
        keyboardSelectedId={null}
        synced={true}
        onArchiveAll={vi.fn()}
      />,
    );
    const cards = screen
      .getAllByRole('generic')
      .filter((el) => el.className?.includes('session-card'));
    // Favorited session should come first regardless of its status rank
    expect(cards[0].textContent).toContain('Favorited Done');
  });

  it('archive button has title attribute and both full and short label spans', () => {
    const sessions = [
      makeSession({ sessionId: 's1', taskName: 'Task One', status: 'done' }),
    ];
    render(
      <SessionGrid
        sessions={sessions}
        projects={[]}
        onSelect={vi.fn()}
        selectedId={null}
        keyboardSelectedId={null}
        synced={true}
        onArchiveAll={vi.fn()}
      />,
    );
    const archiveBtn = screen.getByTitle(
      'Archive done / error / killed sessions',
    );
    expect(archiveBtn).toBeDefined();
    expect(archiveBtn.textContent).toContain('Archive done/error/killed');
    expect(archiveBtn.textContent).toContain('Archive');
  });

  it('clicking archive button invokes onArchiveAll', () => {
    const onArchiveAll = vi.fn();
    const sessions = [
      makeSession({ sessionId: 's1', taskName: 'Task One', status: 'done' }),
    ];
    render(
      <SessionGrid
        sessions={sessions}
        projects={[]}
        onSelect={vi.fn()}
        selectedId={null}
        keyboardSelectedId={null}
        synced={true}
        onArchiveAll={onArchiveAll}
      />,
    );
    fireEvent.click(
      screen.getByTitle('Archive done / error / killed sessions'),
    );
    expect(onArchiveAll).toHaveBeenCalledOnce();
  });

  it('filter toggle pills apply and clear correctly', () => {
    const sessions = [
      makeSession({
        sessionId: 's1',
        taskName: 'Running Task',
        status: 'running',
      }),
      makeSession({ sessionId: 's2', taskName: 'Done Task', status: 'done' }),
    ];
    render(
      <SessionGrid
        sessions={sessions}
        projects={[]}
        onSelect={vi.fn()}
        selectedId={null}
        keyboardSelectedId={null}
        synced={true}
        onArchiveAll={vi.fn()}
      />,
    );
    // Both cards visible initially
    expect(screen.getByText('Running Task')).toBeDefined();
    expect(screen.getByText('Done Task')).toBeDefined();

    // Click Running filter
    fireEvent.click(screen.getByRole('button', { name: 'Running' }));
    expect(screen.getByText('Running Task')).toBeDefined();
    expect(screen.queryByText('Done Task')).toBeNull();

    // Clear filter
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('Running Task')).toBeDefined();
    expect(screen.getByText('Done Task')).toBeDefined();
  });

  it('calls onSelect with the correct sessionId when a card is clicked', () => {
    const onSelect = vi.fn();
    const sessions = [
      makeSession({
        sessionId: 'abc123',
        taskName: 'Clickable Task',
        status: 'running',
      }),
    ];
    render(
      <SessionGrid
        sessions={sessions}
        projects={[]}
        onSelect={onSelect}
        selectedId={null}
        keyboardSelectedId={null}
        synced={true}
        onArchiveAll={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Clickable Task'));
    expect(onSelect).toHaveBeenCalledWith('abc123');
  });
});

describe('SessionGrid — per-card ErrorBoundary isolation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      /* silence React's logged error */
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../SessionCard');
    vi.resetModules();
  });

  it('a throw inside one SessionCard does not crash the grid; other cards still render; the failing card shows the fallback', async () => {
    vi.resetModules();
    vi.doMock('../SessionCard', () => ({
      SessionCard: ({ session }: { session: SessionState }) => {
        if (session.sessionId === 'broken') throw new Error('boom');
        return (
          <div data-testid={`card-${session.sessionId}`}>
            {session.taskName}
          </div>
        );
      },
    }));

    const { SessionGrid: SessionGridIsolated } = await import('../SessionGrid');

    const sessions = [
      makeSession({ sessionId: 'ok-1', taskName: 'OK One', status: 'running' }),
      makeSession({
        sessionId: 'broken',
        taskName: 'Broken Card',
        status: 'running',
      }),
      makeSession({ sessionId: 'ok-2', taskName: 'OK Two', status: 'running' }),
    ];

    render(
      <SessionGridIsolated
        sessions={sessions}
        projects={[]}
        onSelect={vi.fn()}
        selectedId={null}
        keyboardSelectedId={null}
        synced={true}
        onArchiveAll={vi.fn()}
      />,
    );

    expect(screen.getByTestId('card-ok-1')).toBeDefined();
    expect(screen.getByTestId('card-ok-2')).toBeDefined();
    expect(screen.queryByTestId('card-broken')).toBeNull();
    expect(screen.getByText(/session card failed to render/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
  });
});
