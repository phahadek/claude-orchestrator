import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Shared mock data ───────────────────────────────────────────────
const MOCK_SESSION = {
  sessionId: 'sess-1',
  taskId: 'task-1',
  status: 'running' as const,
  archived: false,
  isRateLimited: false,
  isFavorited: false,
  startedAt: Date.now(),
  endedAt: null,
  lastMessage: '',
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  projectId: 'proj-1',
  model: 'claude-sonnet',
  worktreeDir: null,
  sessionMode: 'cli',
  tags: [],
};

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
    sessions: [MOCK_SESSION],
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
  Header: ({
    onViewChange,
  }: {
    onViewChange: (v: string) => void;
    activeView: string;
  }) => (
    <div data-testid="header">
      <button type="button" onClick={() => onViewChange('sessions')}>
        Sessions
      </button>
      <button type="button" onClick={() => onViewChange('tasks')}>
        Tasks
      </button>
    </div>
  ),
}));

vi.mock('../SessionGrid', () => ({
  SessionGrid: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <div
      data-testid="session-grid"
      onClick={() => onSelect('sess-1')}
      role="list"
    >
      <div role="listitem" data-session-id="sess-1">
        Session 1
      </div>
    </div>
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

vi.mock('../Settings', () => ({
  Settings: () => <div data-testid="settings" />,
}));
vi.mock('../AnalyticsPanel', () => ({
  AnalyticsPanel: () => <div data-testid="analytics" />,
}));
vi.mock('../PRPanel', () => ({
  PRPanel: () => <div data-testid="pr-panel" />,
}));

// ── Viewport helper ────────────────────────────────────────────────
function mockMatchMedia(isMobile: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: isMobile,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// ── beforeEach / afterEach ─────────────────────────────────────────
beforeEach(() => {
  mockMatchMedia(false);

  // Mock history.back to fire popstate synchronously (jsdom doesn't navigate the history stack)
  vi.spyOn(window.history, 'back').mockImplementation(() => {
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  });

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
        return Promise.resolve({
          ok: true,
          json: async () => [MOCK_TASK],
        });
      }
      if (url.includes('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            cardPreviewLines: 3,
            sessionMode: 'cli',
            autoLaunchCap: 1,
            autoLaunchPollIntervalMs: 60000,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => [
          {
            id: 'proj-1',
            name: 'Project 1',
            projectDir: '/p',
            contextUrl: '',
            boardId: 'board-1',
          },
        ],
      });
    }),
  );

  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import App from '../../App';
import styles from '../../App.module.css';

async function switchToSessions() {
  await waitFor(() => screen.getByRole('button', { name: 'Sessions' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
}

// ── Task overlay tests ─────────────────────────────────────────────
describe('App — mobile overlay: task detail', () => {
  it('desktop: task list and placeholder render, no backdrop without selection', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));
    expect(screen.getByTestId('task-list')).toBeDefined();
    expect(screen.getByText(/select a task/i)).toBeDefined();
    expect(screen.queryByTestId('task-mobile-backdrop')).toBeNull();
  });

  it('task list stays mounted in DOM when task detail is open', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));

    fireEvent.click(screen.getByTestId('task-list'));

    // task detail appears once taskViews (loaded via fetch) + selectedTaskId are set
    await waitFor(() => screen.getByTestId('task-detail'));
    expect(screen.getByTestId('task-list')).toBeDefined();
    expect(screen.getByTestId('task-detail')).toBeDefined();
  });

  it('backdrop renders in DOM when task detail is open', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));
    fireEvent.click(screen.getByTestId('task-list'));
    await waitFor(() => screen.getByTestId('task-mobile-backdrop'));
    expect(screen.getByTestId('task-mobile-backdrop')).toBeDefined();
  });

  it('clicking backdrop dismisses task detail', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));
    fireEvent.click(screen.getByTestId('task-list'));
    await waitFor(() => screen.getByTestId('task-mobile-backdrop'));

    fireEvent.click(screen.getByTestId('task-mobile-backdrop'));

    await waitFor(() =>
      expect(screen.queryByTestId('task-mobile-backdrop')).toBeNull(),
    );
    expect(screen.queryByTestId('task-detail')).toBeNull();
  });

  it('close button in task detail dismisses overlay', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));
    fireEvent.click(screen.getByTestId('task-list'));
    await waitFor(() => screen.getByTestId('task-detail'));

    fireEvent.click(screen.getByRole('button', { name: /close task detail/i }));

    await waitFor(() => expect(screen.queryByTestId('task-detail')).toBeNull());
  });

  it('contentArea has detail class when task is selected', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));
    fireEvent.click(screen.getByTestId('task-list'));
    await waitFor(() => screen.getByTestId('task-detail'));

    const contentArea = screen
      .getByTestId('task-detail')
      .closest(`.${styles.contentAreaHasDetail}`);
    expect(contentArea).not.toBeNull();
  });

  it('no detail class when no task is selected', async () => {
    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));

    const allWithDetailClass = document.querySelectorAll(
      `.${styles.contentAreaHasDetail}`,
    );
    expect(allWithDetailClass.length).toBe(0);
  });
});

// ── Session overlay tests ──────────────────────────────────────────
describe('App — mobile overlay: session detail', () => {
  it('desktop: session list and placeholder render, no backdrop without selection', async () => {
    render(<App />);
    await switchToSessions();
    await waitFor(() => screen.getByTestId('session-grid'));
    expect(screen.getByTestId('session-grid')).toBeDefined();
    expect(screen.getByText(/select a session/i)).toBeDefined();
    expect(screen.queryByTestId('session-mobile-backdrop')).toBeNull();
  });

  it('session list stays mounted in DOM when session detail is open', async () => {
    render(<App />);
    await switchToSessions();
    await waitFor(() => screen.getByTestId('session-grid'));

    fireEvent.click(screen.getByTestId('session-grid'));

    await waitFor(() => screen.getByTestId('session-detail'));
    expect(screen.getByTestId('session-grid')).toBeDefined();
    expect(screen.getByTestId('session-detail')).toBeDefined();
  });

  it('backdrop renders in DOM when session detail is open', async () => {
    render(<App />);
    await switchToSessions();
    await waitFor(() => screen.getByTestId('session-grid'));

    fireEvent.click(screen.getByTestId('session-grid'));

    await waitFor(() => screen.getByTestId('session-mobile-backdrop'));
    expect(screen.getByTestId('session-mobile-backdrop')).toBeDefined();
  });

  it('clicking backdrop dismisses session detail', async () => {
    render(<App />);
    await switchToSessions();
    await waitFor(() => screen.getByTestId('session-grid'));

    fireEvent.click(screen.getByTestId('session-grid'));
    await waitFor(() => screen.getByTestId('session-mobile-backdrop'));

    fireEvent.click(screen.getByTestId('session-mobile-backdrop'));

    await waitFor(() =>
      expect(screen.queryByTestId('session-mobile-backdrop')).toBeNull(),
    );
    expect(screen.queryByTestId('session-detail')).toBeNull();
  });

  it('close button in session detail dismisses overlay', async () => {
    render(<App />);
    await switchToSessions();
    await waitFor(() => screen.getByTestId('session-grid'));

    fireEvent.click(screen.getByTestId('session-grid'));
    await waitFor(() => screen.getByTestId('session-detail'));

    fireEvent.click(
      screen.getByRole('button', { name: /close session detail/i }),
    );

    await waitFor(() =>
      expect(screen.queryByTestId('session-detail')).toBeNull(),
    );
  });

  it('contentArea has detail class when session is selected', async () => {
    render(<App />);
    await switchToSessions();
    await waitFor(() => screen.getByTestId('session-grid'));

    fireEvent.click(screen.getByTestId('session-grid'));
    await waitFor(() => screen.getByTestId('session-detail'));

    const contentArea = screen
      .getByTestId('session-detail')
      .closest(`.${styles.contentAreaHasDetail}`);
    expect(contentArea).not.toBeNull();
  });
});

// ── Keyboard dismiss tests ─────────────────────────────────────────
describe('App — keyboard dismiss', () => {
  it('onDismiss from useKeyboardShortcuts dismisses task detail', async () => {
    const { useKeyboardShortcuts } =
      await import('../../hooks/useKeyboardShortcuts');
    const mockImpl = vi.mocked(useKeyboardShortcuts);

    let capturedDismiss: (() => void) | undefined;
    mockImpl.mockImplementation(({ onDismiss }) => {
      capturedDismiss = onDismiss;
    });

    render(<App />);
    await waitFor(() => screen.getByTestId('task-list'));
    fireEvent.click(screen.getByTestId('task-list'));
    await waitFor(() => screen.getByTestId('task-detail'));

    capturedDismiss?.();

    await waitFor(() => expect(screen.queryByTestId('task-detail')).toBeNull());
  });

  it('onDismiss from useKeyboardShortcuts dismisses session detail', async () => {
    const { useKeyboardShortcuts } =
      await import('../../hooks/useKeyboardShortcuts');
    const mockImpl = vi.mocked(useKeyboardShortcuts);

    let capturedDismiss: (() => void) | undefined;
    mockImpl.mockImplementation(({ onDismiss }) => {
      capturedDismiss = onDismiss;
    });

    render(<App />);
    await switchToSessions();
    await waitFor(() => screen.getByTestId('session-grid'));

    fireEvent.click(screen.getByTestId('session-grid'));
    await waitFor(() => screen.getByTestId('session-detail'));

    capturedDismiss?.();

    await waitFor(() =>
      expect(screen.queryByTestId('session-detail')).toBeNull(),
    );
  });
});
