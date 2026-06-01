import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionGrid } from '../SessionGrid';
import type { SessionState } from '../../hooks/useSessionStore';

// ── Routing helpers ──────────────────────────────────────────────────────────
const ACTIVE_STATUSES = ['running', 'starting', 'needs_permission', 'retrying'] as const;
const CONCLUDED_STATUSES = ['done', 'error', 'killed'] as const;

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
    // Favorited Done is a concluded session → renders as ConcludedSessionRow (not SessionCard)
    const concludedRow = screen.getByTestId('concluded-session-row');
    expect(concludedRow.textContent).toContain('Favorited Done');
    // Non-favorited active sessions render as SessionCards
    const cards = screen
      .getAllByRole('generic')
      .filter((el) => el.className?.includes('session-card'));
    expect(cards).toHaveLength(2);
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

describe('SessionGrid — differential rendering routing', () => {
  it('routes concluded sessions (done/error/killed) to ConcludedSessionRow', () => {
    const sessions = CONCLUDED_STATUSES.map((status, i) =>
      makeSession({ sessionId: `c${i}`, taskName: `Task ${status}`, status }),
    );
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
    expect(screen.getAllByTestId('concluded-session-row')).toHaveLength(3);
    // No rich session-card rendered for concluded sessions
    const richCards = screen
      .getAllByRole('generic')
      .filter((el) => el.className?.includes('session-card'));
    expect(richCards).toHaveLength(0);
  });

  it('routes active sessions (running/starting/needs_permission/retrying) to SessionCard', () => {
    const sessions = ACTIVE_STATUSES.map((status, i) =>
      makeSession({ sessionId: `a${i}`, taskName: `Task ${status}`, status }),
    );
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
    const richCards = screen
      .getAllByRole('generic')
      .filter((el) => el.className?.includes('session-card'));
    expect(richCards).toHaveLength(ACTIVE_STATUSES.length);
    // No compact row rendered for active sessions
    expect(screen.queryAllByTestId('concluded-session-row')).toHaveLength(0);
  });

  it('mixed panel: active sessions use SessionCard, concluded use ConcludedSessionRow', () => {
    const sessions = [
      makeSession({ sessionId: 's1', taskName: 'Running', status: 'running' }),
      makeSession({ sessionId: 's2', taskName: 'Done', status: 'done' }),
      makeSession({ sessionId: 's3', taskName: 'Error', status: 'error' }),
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
    const richCards = screen
      .getAllByRole('generic')
      .filter((el) => el.className?.includes('session-card'));
    expect(richCards).toHaveLength(1);
    expect(screen.getAllByTestId('concluded-session-row')).toHaveLength(2);
  });

  it('clicking a ConcludedSessionRow calls onSelect with the correct sessionId', () => {
    const onSelect = vi.fn();
    const sessions = [
      makeSession({ sessionId: 'fin-123', taskName: 'Finished Task', status: 'done' }),
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
    fireEvent.click(screen.getByTestId('concluded-session-row'));
    expect(onSelect).toHaveBeenCalledWith('fin-123');
  });

  it('performance smoke: 50 concluded + 5 active sessions render without console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessions = [
      ...Array.from({ length: 50 }, (_, i) =>
        makeSession({ sessionId: `c${i}`, taskName: `Done ${i}`, status: 'done' }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeSession({ sessionId: `a${i}`, taskName: `Active ${i}`, status: 'running' }),
      ),
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
    expect(screen.getAllByTestId('concluded-session-row')).toHaveLength(50);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
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
