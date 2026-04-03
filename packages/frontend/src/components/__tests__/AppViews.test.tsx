import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock hooks and heavy components so we can test view switching in isolation
vi.mock('../../hooks/useSessionStore', () => ({
  useSessionStore: () => ({
    sessions: [],
    tasks: [],
    tasksReady: false,
    synced: true,
    readyCount: 0,
    blockedCount: 0,
    dispatch: vi.fn(),
    deleteSession: vi.fn(),
    setSessionArchived: vi.fn(),
  }),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: vi.fn(), connectionState: 'connected' }),
}));

vi.mock('../../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: () => {},
}));

vi.mock('../SessionGrid', () => ({
  SessionGrid: () => <div data-testid="session-grid">SessionGrid</div>,
}));

vi.mock('../PRPanel', () => ({
  PRPanel: ({ activeProjectId }: { activeProjectId: string | null }) => (
    <div data-testid="pr-panel">PRPanel:{activeProjectId}</div>
  ),
}));

vi.mock('../HistoryGrid', () => ({
  HistoryGrid: () => <div data-testid="history-grid">HistoryGrid</div>,
}));

vi.mock('../PermissionRules', () => ({
  PermissionRules: () => <div data-testid="permission-rules">PermissionRules</div>,
}));

vi.mock('../Notifications', () => ({
  Notifications: () => null,
}));

vi.mock('../ShortcutHint', () => ({
  ShortcutHint: () => null,
}));

vi.mock('../DispatchModal', () => ({
  DispatchModal: () => null,
}));

vi.mock('../TaskList', () => ({
  TaskList: () => <div data-testid="task-list">TaskList</div>,
}));

vi.mock('../TaskDetail', () => ({
  TaskDetail: () => <div data-testid="task-detail">TaskDetail</div>,
}));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [{ id: 'proj-1', name: 'Project 1', projectDir: '/p', contextUrl: '', boardId: '' }],
  }));

  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  });
});

import App from '../../App';

describe('App view switching', () => {
  it('renders TaskList by default', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('task-list')).toBeDefined();
    });
    expect(screen.queryByTestId('session-grid')).toBeNull();
  });

  it('switches to SessionGrid when Sessions nav link is clicked', async () => {
    render(<App />);
    await waitFor(() => screen.getByRole('button', { name: 'Sessions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(screen.getByTestId('session-grid')).toBeDefined();
    expect(screen.queryByTestId('task-list')).toBeNull();
  });

  it('switches back to TaskList when Tasks nav link is clicked', async () => {
    render(<App />);
    await waitFor(() => screen.getByRole('button', { name: 'Sessions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(screen.getByTestId('task-list')).toBeDefined();
    expect(screen.queryByTestId('session-grid')).toBeNull();
  });

  it('switches to PRPanel when PRs nav link is clicked', async () => {
    render(<App />);
    await waitFor(() => screen.getByRole('button', { name: 'PRs' }));
    fireEvent.click(screen.getByRole('button', { name: 'PRs' }));
    expect(screen.getByTestId('pr-panel')).toBeDefined();
    expect(screen.queryByTestId('task-list')).toBeNull();
  });

  it('switches back to SessionGrid when Sessions nav link is clicked from PRs', async () => {
    render(<App />);
    await waitFor(() => screen.getByRole('button', { name: 'PRs' }));
    fireEvent.click(screen.getByRole('button', { name: 'PRs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(screen.getByTestId('session-grid')).toBeDefined();
    expect(screen.queryByTestId('pr-panel')).toBeNull();
  });
});
