import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectionState } from '../../hooks/useWebSocket';

// Mutable control surface exposed to tests
const mockSend = vi.fn();
let setWsConnectionState: ((cs: ConnectionState) => void) | null = null;

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => {
    // require runs at render time (not hoist time), so React is already loaded
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useState, useEffect } = require('react') as typeof import('react');
    const [cs, setCs] = useState<ConnectionState>('connected');
    useEffect(() => {
      setWsConnectionState = setCs;
    }, []);
    return { send: mockSend, connectionState: cs };
  },
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
    taskListRefreshTrigger: 0,
    lastAutofixEvent: null,
    lastReviewStartedEvent: null,
  }),
}));

vi.mock('../../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: () => {},
}));

vi.mock('../../hooks/useNotifications', () => ({
  useNotifications: () => {},
}));

// Header mock that exposes onBoardChange so tests can invoke it directly
let capturedOnBoardChange: ((boardId: string) => void) | null = null;

vi.mock('../Header', () => ({
  Header: ({
    onBoardChange,
    activeBoardId,
  }: {
    onBoardChange: (id: string) => void;
    activeBoardId: string | null;
    [key: string]: unknown;
  }) => {
    capturedOnBoardChange = onBoardChange;
    return (
      <div data-testid="header" data-active-board={activeBoardId ?? ''}>
        <button onClick={() => onBoardChange('board-2')}>Board 2</button>
        <button onClick={() => onBoardChange('board-3')}>Board 3</button>
      </div>
    );
  },
}));

vi.mock('../SessionGrid', () => ({ SessionGrid: () => <div /> }));
vi.mock('../PRPanel', () => ({ PRPanel: () => <div /> }));
vi.mock('../HistoryGrid', () => ({ HistoryGrid: () => <div /> }));
vi.mock('../Notifications', () => ({ Notifications: () => null }));
vi.mock('../ShortcutHint', () => ({ ShortcutHint: () => null }));
vi.mock('../DispatchModal', () => ({ DispatchModal: () => null }));
// Capture onSelectTask so tests can simulate a user clicking a task
let capturedOnSelectTask: ((taskId: string) => void) | null = null;

vi.mock('../TaskList', () => ({
  TaskList: ({ onSelectTask }: { onSelectTask: (id: string) => void }) => {
    capturedOnSelectTask = onSelectTask;
    return <div data-testid="task-list" />;
  },
}));
vi.mock('../TaskDetail', () => ({
  TaskDetail: () => <div data-testid="task-detail" />,
}));

const PROJECT = {
  id: 'proj-1',
  name: 'Project 1',
  projectDir: '/p',
  contextUrl: '',
  boardId: 'board-1',
  boards: [
    { id: 'board-1', name: 'Board 1' },
    { id: 'board-2', name: 'Board 2' },
    { id: 'board-3', name: 'Board 3' },
  ],
};

function makeFetch() {
  return vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: async () => {
        if (url.includes('/api/config')) return [PROJECT];
        if (url.includes('/api/tasks')) return [];
        return {};
      },
    }),
  );
}

function makeLocalStore() {
  const store: Record<string, string> = {};
  return {
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
    length: 0,
    key: () => null,
  };
}

beforeEach(() => {
  mockSend.mockClear();
  setWsConnectionState = null;
  capturedOnBoardChange = null;
  capturedOnSelectTask = null;
  vi.stubGlobal('fetch', makeFetch());
  vi.stubGlobal('localStorage', makeLocalStore());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import App from '../../App';

describe('App — milestone switch race condition', () => {
  it('each handleBoardChange call sends fetch_tasks with the correct board ID', async () => {
    render(<App />);

    // Wait for config to load and the initial fetch_tasks for board-1
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_tasks',
          milestoneId: 'board-1',
        }),
      );
    });

    mockSend.mockClear();

    // Invoke board changes in rapid succession (both in one act — React may batch them)
    act(() => {
      capturedOnBoardChange?.('board-2');
      capturedOnBoardChange?.('board-3');
    });

    // After effects flush, the final committed board ID must appear in fetch_tasks
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_tasks',
          milestoneId: 'board-3',
        }),
      );
    });

    // The last fetch_tasks must carry board-3, never a stale ID
    const fetchCalls = mockSend.mock.calls.filter(
      (c) => (c[0] as { type: string })?.type === 'fetch_tasks',
    );
    const lastFetch = fetchCalls[fetchCalls.length - 1][0] as {
      milestoneId: string;
    };
    expect(lastFetch.milestoneId).toBe('board-3');
  });

  it('WS reconnect after milestone switch re-fetches with the current milestone ID', async () => {
    render(<App />);

    // Wait for initial fetch_tasks with board-1
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_tasks',
          milestoneId: 'board-1',
        }),
      );
    });

    // Switch to board-2
    act(() => {
      capturedOnBoardChange?.('board-2');
    });

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_tasks',
          milestoneId: 'board-2',
        }),
      );
    });

    mockSend.mockClear();

    // Simulate WS disconnect then reconnect
    await act(async () => {
      setWsConnectionState?.('disconnected');
    });
    await act(async () => {
      setWsConnectionState?.('connected');
    });

    // Must re-fetch with board-2 (the currently selected milestone), not a stale board-1
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fetch_tasks',
          milestoneId: 'board-2',
        }),
      );
    });

    const fetchCalls = mockSend.mock.calls.filter(
      (c) => (c[0] as { type: string })?.type === 'fetch_tasks',
    );
    expect(
      fetchCalls.every(
        (c) => (c[0] as { milestoneId: string }).milestoneId === 'board-2',
      ),
    ).toBe(true);
  });
});

// ── Detail pane sync tests ─────────────────────────────────────────────────────
// These tests verify that the detail pane uses the same task-views source as
// TaskList (App.taskViews), eliminating the stale-state divergence bug.

type FetchTaskView = {
  taskId: string;
  taskName: string;
  notionStatus: string;
  displayStatus: string;
  pauseReason: null;
  priority: string;
  notionUrl: string;
  taskType: string;
  blocked: boolean;
  blockerNames: string[];
  wave: number;
  codeSession: null;
  pr: null;
  review: null;
  totalTokens: { input: number; output: number };
  assignedRepo: string | null;
};

function makeTaskView(taskId: string, taskName: string): FetchTaskView {
  return {
    taskId,
    taskName,
    notionStatus: '🔄 In Progress',
    displayStatus: 'in_progress',
    pauseReason: null,
    priority: '🔴 High',
    notionUrl: `https://notion.so/${taskId}`,
    taskType: '💻 Code',
    blocked: false,
    blockerNames: [],
    wave: 1,
    codeSession: null,
    pr: null,
    review: null,
    totalTokens: { input: 0, output: 0 },
    assignedRepo: null,
  };
}

describe('App — detail pane sync with shared task-views source', () => {
  it('TaskDetail renders when selectedTaskId matches a task in taskViews', async () => {
    const task = makeTaskView('task-abc', 'My Task');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          json: async () => {
            if (url.includes('/api/config')) return [PROJECT];
            if (url.includes('/api/tasks')) return [task];
            return {};
          },
        }),
      ),
    );

    render(<App />);

    // Wait for tasks to load into taskViews
    await waitFor(() => {
      expect(capturedOnSelectTask).not.toBeNull();
    });

    // Simulate user clicking a task — the task IS in taskViews
    await act(async () => {
      capturedOnSelectTask!('task-abc');
    });

    // TaskDetail should render (task found in shared taskViews)
    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeDefined();
    });
    expect(screen.queryByTestId('task-detail-loading')).toBeNull();
  });

  it('loading placeholder renders when selectedTaskId is set but task not yet in taskViews', async () => {
    // Fetch returns tasks only after a delay — user clicks before taskViews is populated
    let resolveTasksFetch!: (value: unknown) => void;
    const tasksPromise = new Promise((resolve) => {
      resolveTasksFetch = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/api/config'))
          return Promise.resolve({
            ok: true,
            json: async () => [PROJECT],
          });
        if (url.includes('/api/tasks')) return tasksPromise;
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }),
    );

    render(<App />);

    // Wait for TaskList mock to receive onSelectTask
    await waitFor(() => {
      expect(capturedOnSelectTask).not.toBeNull();
    });

    // Select a task BEFORE taskViews has been populated (fetch not yet resolved)
    await act(async () => {
      capturedOnSelectTask!('task-xyz');
    });

    // Should show loading placeholder, not the empty "Select a task" placeholder
    await waitFor(() => {
      expect(screen.getByTestId('task-detail-loading')).toBeDefined();
    });
    expect(screen.queryByTestId('task-detail')).toBeNull();

    // Now resolve the fetch with the task data
    resolveTasksFetch({
      ok: true,
      json: async () => [makeTaskView('task-xyz', 'Loaded Task')],
    });

    // TaskDetail should now appear
    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeDefined();
    });
    expect(screen.queryByTestId('task-detail-loading')).toBeNull();
  });

  it('detail pane shows the empty placeholder only when no task is selected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          json: async () => {
            if (url.includes('/api/config')) return [PROJECT];
            if (url.includes('/api/tasks')) return [];
            return {};
          },
        }),
      ),
    );

    render(<App />);

    await waitFor(() => {
      expect(capturedOnSelectTask).not.toBeNull();
    });

    // No task selected — should show the "Select a task" placeholder
    expect(screen.queryByTestId('task-detail')).toBeNull();
    expect(screen.queryByTestId('task-detail-loading')).toBeNull();
  });

  it('onSelectTask from TaskList propagates taskId matching the key in taskViews (shape regression)', async () => {
    const task = makeTaskView('prefixed-task-id-001', 'Shape Test Task');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          json: async () => {
            if (url.includes('/api/config')) return [PROJECT];
            if (url.includes('/api/tasks')) return [task];
            return {};
          },
        }),
      ),
    );

    render(<App />);

    await waitFor(() => {
      expect(capturedOnSelectTask).not.toBeNull();
    });

    // Simulate TaskList calling onSelectTask with the same taskId format stored in taskViews
    await act(async () => {
      capturedOnSelectTask!('prefixed-task-id-001');
    });

    // TaskDetail must render — the taskId shapes match
    await waitFor(() => {
      expect(screen.getByTestId('task-detail')).toBeDefined();
    });
  });
});
