import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const MOCK_TASK = {
  taskId: 'task-1',
  taskName: 'Task One',
  notionStatus: 'ready',
  displayStatus: 'ready',
  pauseReason: null,
  priority: 'medium',
  notionUrl: '',
  taskType: 'code',
  blocked: false,
  blockerNames: [],
  wave: 1,
  codeSession: null,
  pr: null,
  review: null,
  totalTokens: { input: 0, output: 0 },
};

// ── Mocks ──────────────────────────────────────────────────────────
vi.mock('../../hooks/useSessionStore', () => ({
  useSessionStore: () => ({
    sessions: [],
    tasks: [],
    tasksReady: true,
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
    lastPrMergedEvent: null,
    lastPrClosedEvent: null,
    lastPrStateChangedEvent: null,
    lastPrMergeabilityChangedEvent: null,
    lastReviewEscalation: null,
    lastReviewFailed: null,
    lastStuckNotification: null,
    lastStuckPaused: null,
    lastStuckKilled: null,
    lastApiOverloadedPaused: null,
    incompleteReviews: [],
    lastTaskUpdate: null,
    taskListRefreshTrigger: 0,
  }),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: vi.fn(), connectionState: 'connected' }),
}));

vi.mock('../../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: vi.fn(),
}));

vi.mock('../Header', () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock('../SessionGrid', () => ({
  SessionGrid: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <div
      data-testid="session-grid"
      onClick={() => onSelect('sess-1')}
      role="list"
    />
  ),
}));

vi.mock('../HistoryGrid', () => ({
  HistoryGrid: () => <div data-testid="history-grid" />,
}));

vi.mock('../Notifications', () => ({ Notifications: () => null }));
vi.mock('../ShortcutHint', () => ({ ShortcutHint: () => null }));
vi.mock('../DispatchModal', () => ({ DispatchModal: () => null }));
vi.mock('../PermissionEventLog', () => ({ PermissionEventLog: () => null }));
vi.mock('../SessionFilterBar', () => ({ SessionFilterBar: () => null }));
vi.mock('../Settings', () => ({ Settings: () => null }));
vi.mock('../AnalyticsPanel', () => ({ AnalyticsPanel: () => null }));
vi.mock('../PRPanel', () => ({ PRPanel: () => null }));

vi.mock('../TaskList', () => ({
  TaskList: ({ onSelectTask }: { onSelectTask: (id: string) => void }) => (
    <div
      data-testid="task-list"
      onClick={() => onSelectTask('task-1')}
      role="list"
    >
      Task 1
    </div>
  ),
}));

vi.mock('../TaskDetail', () => ({
  TaskDetail: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="task-detail">
      <button type="button" onClick={onClose} aria-label="Close task detail">
        ✕
      </button>
    </div>
  ),
}));

vi.mock('../SessionDetail', () => ({
  SessionDetail: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="session-detail">
      <button type="button" onClick={onClose} aria-label="Close session detail">
        ✕
      </button>
    </div>
  ),
}));

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));

  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
  });

  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/tasks/active')) {
        return Promise.resolve({ ok: true, json: async () => [MOCK_TASK] });
      }
      if (url.includes('/api/settings')) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({
        ok: true,
        json: async () => [
          {
            id: 'proj-1',
            name: 'P1',
            projectDir: '/p',
            contextUrl: '',
            boardId: 'board-1',
          },
        ],
      });
    }),
  );

  // Mock history.back to fire popstate synchronously with null state
  vi.spyOn(window.history, 'back').mockImplementation(() => {
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  });
  vi.spyOn(window.history, 'pushState');

  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import App from '../../App';

describe('App — navigation history', () => {
  it('clicking a task calls history.pushState AND sets selectedTaskId', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));

    fireEvent.click(screen.getByTestId('task-list'));

    await waitFor(() => screen.getByTestId('task-detail'));
    expect(window.history.pushState).toHaveBeenCalledWith(
      { type: 'task', id: 'task-1' },
      '',
    );
    expect(screen.getByTestId('task-detail')).toBeDefined();
  });

  it('simulating popstate clears selectedTaskId', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));
    fireEvent.click(screen.getByTestId('task-list'));
    await waitFor(() => screen.getByTestId('task-detail'));

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });

    await waitFor(() => expect(screen.queryByTestId('task-detail')).toBeNull());
  });

  it('clicking backdrop calls history.back()', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));
    fireEvent.click(screen.getByTestId('task-list'));
    await waitFor(() => screen.getByTestId('task-mobile-backdrop'));

    fireEvent.click(screen.getByTestId('task-mobile-backdrop'));

    expect(window.history.back).toHaveBeenCalledOnce();
  });

  it('backdrop calls history.back() and task detail disappears', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));
    fireEvent.click(screen.getByTestId('task-list'));
    await waitFor(() => screen.getByTestId('task-mobile-backdrop'));

    fireEvent.click(screen.getByTestId('task-mobile-backdrop'));

    await waitFor(() => expect(screen.queryByTestId('task-detail')).toBeNull());
  });

  it('task detail onClose calls history.back() and dismisses overlay', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));
    fireEvent.click(screen.getByTestId('task-list'));
    await waitFor(() => screen.getByTestId('task-detail'));

    fireEvent.click(screen.getByRole('button', { name: /close task detail/i }));

    expect(window.history.back).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByTestId('task-detail')).toBeNull());
  });

  it('simulating popstate when no detail view is open does not crash', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });

    // No crash, task-list still rendered
    expect(screen.getByTestId('task-list')).toBeDefined();
    expect(screen.queryByTestId('task-detail')).toBeNull();
  });

  it('idempotent: clicking same task twice does not push history twice', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));

    fireEvent.click(screen.getByTestId('task-list'));
    await waitFor(() => screen.getByTestId('task-detail'));
    const pushCallCount = (window.history.pushState as ReturnType<typeof vi.fn>)
      .mock.calls.length;

    fireEvent.click(screen.getByTestId('task-list'));

    // Should not push again
    expect(
      (window.history.pushState as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(pushCallCount);
  });
});
