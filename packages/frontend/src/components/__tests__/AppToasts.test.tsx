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
  useKeyboardShortcuts: () => {},
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

vi.mock('../DispatchModal', () => ({
  DispatchModal: () => null,
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
    lastStuckNotification: null,
    lastStuckPaused: null,
    lastStuckKilled: null,
    lastApiOverloadedPaused: null,
    incompleteReviews: [],
    dismissIncompleteReviews: vi.fn(),
    lastTaskUpdate: null,
    taskListRefreshTrigger: 0,
    lastAutofixEvent: null,
    lastReviewStartedEvent: null,
    lastCiBillingBlockedEvent: null,
    lastSessionStartedEvent: null,
    lastSessionEndedEvent: null,
    lastCacheUpdatedEvent: null,
    prPipelineStages: new Map(),
    prPipelineFailedCommands: new Map(),
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
