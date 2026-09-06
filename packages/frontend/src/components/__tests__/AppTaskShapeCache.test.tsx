import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: vi.fn(), connectionState: 'connected' }),
}));

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
    lastStagedIntentChange: null,
    taskListRefreshTrigger: 0,
    lastAutofixEvent: null,
    lastReviewStartedEvent: null,
    lastCiBillingBlockedEvent: null,
    lastSessionStartedEvent: null,
    lastSessionEndedEvent: null,
    lastSessionStatusEvent: null,
    lastCacheUpdatedEvent: null,
    prPipelineStages: {},
    prPipelineFailedCommands: {},
  }),
}));

vi.mock('../../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: () => ({ highlightedItemId: null }),
}));

vi.mock('../../hooks/useNotifications', () => ({
  useNotifications: () => {},
}));

vi.mock('../TaskList', () => ({
  TaskList: ({ tasks }: { tasks: Array<{ taskId: string }> }) => (
    <div data-testid="task-list">{tasks.map((t) => t.taskId).join(',')}</div>
  ),
}));

vi.mock('../MilestoneView', () => ({
  MilestoneView: () => <div data-testid="milestone-view">MilestoneView</div>,
}));

vi.mock('../Notifications', () => ({ Notifications: () => null }));
vi.mock('../ShortcutHint', () => ({ ShortcutHint: () => null }));

const PROJECT = {
  id: 'proj-1',
  name: 'Project 1',
  projectDir: '/p',
  contextUrl: '',
  boardId: 'board-1',
  boards: [{ id: 'board-1', name: 'M1' }],
};

function stubLocalStorage() {
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
}

function mockMatchMedia() {
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
}

function activeTaskCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((url) => url.includes('/api/tasks/active'));
}

import App from '../../App';

beforeEach(() => {
  stubLocalStorage();
  mockMatchMedia();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App — per-shape taskViews cache', () => {
  it('switching topView between tasks and milestone after both shapes are cached triggers zero additional requests', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/config')) {
        return Promise.resolve({ ok: true, json: async () => [PROJECT] });
      }
      if (url.includes('/api/tasks/active')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tasks: [], coldCache: false }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    // Initial 'tasks' view fetches shape=full
    await waitFor(() => {
      expect(
        activeTaskCalls(fetchMock).some((u) => u.includes('shape=full')),
      ).toBe(true);
    });

    // Switch to milestone view — first visit fetches shape=summary
    fireEvent.click(screen.getByRole('button', { name: 'Milestone' }));
    await waitFor(() => {
      expect(
        activeTaskCalls(fetchMock).some((u) => u.includes('shape=summary')),
      ).toBe(true);
    });

    const callCountAfterBothShapesCached = activeTaskCalls(fetchMock).length;

    // Switch back and forth between the two already-cached shapes
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Milestone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));

    // No new /api/tasks/active requests should have been issued
    expect(activeTaskCalls(fetchMock).length).toBe(
      callCountAfterBothShapesCached,
    );
  });

  it('discards an out-of-order (stale) shape response instead of overwriting the newer cached response', async () => {
    let resolveFirstFull!: (v: unknown) => void;
    const firstFullPromise = new Promise((resolve) => {
      resolveFirstFull = resolve;
    });
    let fullCallCount = 0;

    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/config')) {
        return Promise.resolve({ ok: true, json: async () => [PROJECT] });
      }
      if (url.includes('/api/tasks/active') && url.includes('shape=full')) {
        fullCallCount += 1;
        if (fullCallCount === 1) {
          // First request never resolves until we manually trigger it below —
          // simulating a slow in-flight request that a second request outraces.
          return firstFullPromise;
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tasks: [{ taskId: 'fresh-task' }],
            coldCache: false,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ tasks: [], coldCache: false }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(fullCallCount).toBeGreaterThanOrEqual(1);
    });

    // Force a second 'full' shape fetch to be issued while the first is still pending,
    // by toggling to milestone (summary, resolves immediately) and back to tasks (full) —
    // the cache for 'full' is still empty (first request hasn't resolved), so this issues
    // a second request and bumps the per-shape sequence number, making the first stale.
    fireEvent.click(screen.getByRole('button', { name: 'Milestone' }));
    await waitFor(() => screen.getByTestId('milestone-view'));
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));

    await waitFor(() => {
      expect(fullCallCount).toBeGreaterThanOrEqual(2);
    });

    // The newer (second) request resolves synchronously and should populate taskViews
    await waitFor(() => {
      expect(screen.getByTestId('task-list').textContent).toBe('fresh-task');
    });

    // Now resolve the stale first request with different (stale) data
    await act(async () => {
      resolveFirstFull({
        ok: true,
        json: async () => ({
          tasks: [{ taskId: 'stale-task' }],
          coldCache: false,
        }),
      });
      await Promise.resolve();
    });

    // The stale response must be discarded — taskViews must still show the fresher data
    expect(screen.getByTestId('task-list').textContent).toBe('fresh-task');
  });
});
