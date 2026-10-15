import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSessionStore } from '../../hooks/useSessionStore';

vi.mock('../../hooks/useSessionStore', () => ({
  useSessionStore: vi.fn(),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: vi.fn(), connectionState: 'connected' }),
}));

vi.mock('../../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: () => ({ highlightedItemId: null }),
}));

vi.mock('../Header', () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock('../SessionGrid', () => ({
  SessionGrid: () => <div data-testid="session-grid" />,
}));

vi.mock('../PRPanel', () => ({
  PRPanel: () => <div data-testid="pr-panel" />,
}));

vi.mock('../HistoryGrid', () => ({
  HistoryGrid: () => <div data-testid="history-grid" />,
}));

vi.mock('../ShortcutHint', () => ({
  ShortcutHint: () => null,
}));

vi.mock('../TaskList', () => ({
  TaskList: () => <div data-testid="task-list" />,
}));

vi.mock('../TaskDetail', () => ({
  TaskDetail: () => <div data-testid="task-detail" />,
}));

vi.mock('../Settings', () => ({
  Settings: () => null,
}));

vi.mock('../AnalyticsPanel', () => ({
  AnalyticsPanel: () => null,
}));

function baseStoreReturn(sessions: object[] = []) {
  return {
    sessions,
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
    dismissedDenialIds: new Map(),
    dismissDenial: vi.fn(),
    dismissAllDenials: vi.fn(),
    clearSessionDenials: vi.fn(),
    prRefreshTrigger: 0,
    lastPrReviewEvent: null,
    lastPrMergedEvent: null,
    lastPrClosedEvent: null,
    lastPrStateChangedEvent: null,
    lastPrMergeabilityChangedEvent: null,
    lastReviewEscalation: null,
    lastReviewFailed: null,
    lastDeployNeedsAttention: null,
    lastStuckNotification: null,
    lastStuckPaused: null,
    lastStuckKilled: null,
    lastApiOverloadedPaused: null,
    incompleteReviews: [],
    dismissIncompleteReviews: vi.fn(),
    lastTaskUpdate: null,
    lastStagedIntentChange: null,
    taskListRefreshTrigger: 0,
    lastAutofixEvent: null,
    lastReviewStartedEvent: null,
    lastCiBillingBlockedEvent: null,
    lastSessionStartedEvent: null,
    lastSessionEndedEvent: null,
    lastSessionStatusEvent: null,
    lastCacheUpdatedEvent: null,
    prPipelineStages: new Map(),
    prPipelineFailedCommands: new Map(),
    reviewNotDispatched: new Map(),
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: 'proj-1',
          name: 'Project 1',
          projectDir: '/p',
          contextUrl: '',
          boardId: '',
        },
      ],
    }),
  );

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

  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import App from '../../App';

describe('App — in-app toast suppression for replayed sessions', () => {
  it('does not show a toast for a done session with lastStatusReplay: true', async () => {
    vi.mocked(useSessionStore).mockReturnValue(
      baseStoreReturn([
        {
          sessionId: 'sess-replay',
          taskName: 'Replay Task',
          notionTaskUrl: '',
          status: 'done',
          events: [],
          archived: false,
          lastStatusReplay: true,
        },
      ]) as ReturnType<typeof useSessionStore>,
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('task-list')).toBeDefined();
    });

    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('shows a toast for a done session with lastStatusReplay: false (live transition)', async () => {
    vi.mocked(useSessionStore).mockReturnValue(
      baseStoreReturn([
        {
          sessionId: 'sess-live',
          taskName: 'Live Task',
          notionTaskUrl: '',
          status: 'done',
          events: [],
          archived: false,
          lastStatusReplay: false,
        },
      ]) as ReturnType<typeof useSessionStore>,
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.queryAllByRole('alert')).toHaveLength(1);
    });
  });
});

function doneSession(id: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: id,
    taskName: `Task ${id}`,
    notionTaskUrl: '',
    status: 'done',
    events: [],
    archived: false,
    lastStatusReplay: false,
    ...extra,
  };
}

describe('App — gate-verify suppression and toast cap', () => {
  it('shows no toast for gate-verify done or error sessions', async () => {
    vi.mocked(useSessionStore).mockReturnValue(
      baseStoreReturn([
        doneSession('gv-1', { isGateVerify: true }),
        doneSession('gv-2', { isGateVerify: true, status: 'error' }),
      ]) as ReturnType<typeof useSessionStore>,
    );
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('task-list')).toBeDefined();
    });
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('caps completions at 3 rows with a +N summary', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    vi.mocked(useSessionStore).mockReturnValue(
      baseStoreReturn(ids.map((i) => doneSession(i))) as ReturnType<
        typeof useSessionStore
      >,
    );
    render(<App />);
    await waitFor(() => {
      expect(screen.queryAllByRole('alert')).toHaveLength(3);
    });
    expect(screen.getByText('+3 more sessions finished')).toBeDefined();
  });

  it('keeps a non-completion toast as its own row when the cap is reached', async () => {
    const store = baseStoreReturn(
      ['a', 'b', 'c', 'd'].map((i) => doneSession(i)),
    );
    Object.assign(store, {
      lastReviewEscalation: {
        prNumber: 7,
        repo: 'r',
        message: 'look at this',
        receivedAt: 1,
      },
    });
    vi.mocked(useSessionStore).mockReturnValue(
      store as ReturnType<typeof useSessionStore>,
    );
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/PR #7 needs your attention/)).toBeDefined();
    });
    expect(screen.getByText(/more sessions finished/)).toBeDefined();
  });
});
