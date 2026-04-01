import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SessionGrid } from '../SessionGrid';
import type { SessionState } from '../../hooks/useSessionStore';

function makeSession(overrides: Partial<SessionState> & { sessionId: string }): SessionState {
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
    render(<SessionGrid sessions={sessions} onSelect={vi.fn()} selectedId={null} keyboardSelectedId={null} synced={true} onArchiveAll={vi.fn()} />);
    expect(screen.getByText('Task One')).toBeDefined();
    expect(screen.getByText('Task Two')).toBeDefined();
  });

  it('sorts cards by status rank — needs_permission always first', () => {
    const sessions = [
      makeSession({ sessionId: 's1', taskName: 'Done Task',       status: 'done' }),
      makeSession({ sessionId: 's2', taskName: 'Running Task',     status: 'running' }),
      makeSession({ sessionId: 's3', taskName: 'Permission Task',  status: 'needs_permission' }),
      makeSession({ sessionId: 's4', taskName: 'Starting Task',    status: 'starting' }),
    ];
    render(<SessionGrid sessions={sessions} onSelect={vi.fn()} selectedId={null} keyboardSelectedId={null} synced={true} onArchiveAll={vi.fn()} />);
    const cards = screen.getAllByRole('generic').filter(
      (el) => el.className?.includes('session-card')
    );
    // First card should contain the needs_permission task
    expect(cards[0].textContent).toContain('Permission Task');
  });

  it('renders empty state placeholder when sessions list is empty', () => {
    render(<SessionGrid sessions={[]} onSelect={vi.fn()} selectedId={null} keyboardSelectedId={null} synced={true} onArchiveAll={vi.fn()} />);
    expect(screen.getByText(/no sessions yet/i)).toBeDefined();
  });

  it('calls onSelect with the correct sessionId when a card is clicked', () => {
    const onSelect = vi.fn();
    const sessions = [makeSession({ sessionId: 'abc123', taskName: 'Clickable Task', status: 'running' })];
    render(<SessionGrid sessions={sessions} onSelect={onSelect} selectedId={null} keyboardSelectedId={null} synced={true} onArchiveAll={vi.fn()} />);
    fireEvent.click(screen.getByText('Clickable Task'));
    expect(onSelect).toHaveBeenCalledWith('abc123');
  });
});
