import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../hooks/useSessionStore', () => ({
  useSessionStore: () => ({
    sessions: [],
    tasks: [],
    tasksReady: false,
    synced: true,
    readyCount: 0,
    blockedCount: 0,
    dispatch: vi.fn(),
    resetTasks: vi.fn(),
    deleteSession: vi.fn(),
    setSessionArchived: vi.fn(),
    setSessionFavorited: vi.fn(),
    prRefreshTrigger: 0,
    lastPrReviewEvent: null,
    lastReviewEscalation: null,
    incompleteReviews: [],
    lastTaskUpdate: null,
    taskListRefreshTrigger: 0,
  }),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: vi.fn(), connectionState: 'connected' }),
}));

vi.mock('../../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: () => {},
}));

vi.mock('../Header', () => ({
  Header: () => {
    throw new Error('header boom');
  },
}));

vi.mock('../SessionGrid', () => ({
  SessionGrid: () => <div data-testid="session-grid">SessionGrid</div>,
}));

vi.mock('../PRPanel', () => ({
  PRPanel: () => <div data-testid="pr-panel">PRPanel</div>,
}));

vi.mock('../HistoryGrid', () => ({
  HistoryGrid: () => <div data-testid="history-grid">HistoryGrid</div>,
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

  vi.spyOn(console, 'error').mockImplementation(() => { /* silence React's logged error */ });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import App from '../../App';

describe('App — Header ErrorBoundary isolation', () => {
  it('a throw inside Header does not crash the app; views/sidebar still render; the header area shows the fallback strip', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('task-list')).toBeDefined();
    });

    expect(screen.getByText(/header failed to render/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
  });
});
