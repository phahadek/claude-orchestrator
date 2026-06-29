import { render, screen, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BootReconciliationState } from '../../hooks/useBootReconciliation';

const bootDispatchRef = { current: vi.fn() };
const bootStateRef: { current: BootReconciliationState } = {
  current: {
    phase: 'idle',
    steps: [],
    stepEntries: [],
    currentStep: null,
    startedAt: null,
    totalDurationMs: null,
  },
};

vi.mock('../../hooks/useBootReconciliation', () => ({
  useBootReconciliation: () => ({
    get state() {
      return bootStateRef.current;
    },
    dispatch: bootDispatchRef.current,
  }),
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
    lastPrMergeabilityChangedEvent: null,
    lastPrMergedEvent: null,
    lastPrClosedEvent: null,
    lastPrStateChangedEvent: null,
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
    lastCiBillingBlockedEvent: null,
    lastSessionStartedEvent: null,
    lastSessionEndedEvent: null,
    lastCacheUpdatedEvent: null,
    prPipelineStages: null,
    prPipelineFailedCommands: null,
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
  TaskList: ({ tasks }: { tasks: unknown[] }) => (
    <div data-testid="task-list">
      {tasks.length === 0 ? (
        <div data-testid="task-list-empty">No active tasks found.</div>
      ) : (
        <div>tasks</div>
      )}
    </div>
  ),
}));

vi.mock('../TaskDetail', () => ({
  TaskDetail: () => <div data-testid="task-detail">TaskDetail</div>,
}));

beforeEach(() => {
  bootStateRef.current = {
    phase: 'idle',
    steps: [],
    stepEntries: [],
    currentStep: null,
    startedAt: null,
    totalDurationMs: null,
  };
  bootDispatchRef.current = vi.fn();

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/api/tasks')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tasks: [], coldCache: false }),
        });
      }
      if (typeof url === 'string' && url.includes('/api/setup')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ setupNeeded: false }),
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
            boardId: '',
          },
        ],
      });
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
});

import App from '../../App';

describe('App boot loading gating', () => {
  it('shows boot-loading-banner when phase is in_progress', async () => {
    bootStateRef.current = {
      phase: 'in_progress',
      steps: ['jsonl_import', 'worktree_reconciliation'],
      stepEntries: [{ name: 'jsonl_import', status: 'started' }],
      currentStep: 'jsonl_import',
      startedAt: new Date().toISOString(),
      totalDurationMs: null,
    };

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('boot-loading-banner')).toBeDefined();
    });
  });

  it('does not render the task-list empty state while phase is in_progress', async () => {
    bootStateRef.current = {
      phase: 'in_progress',
      steps: ['jsonl_import', 'worktree_reconciliation'],
      stepEntries: [{ name: 'jsonl_import', status: 'started' }],
      currentStep: 'jsonl_import',
      startedAt: new Date().toISOString(),
      totalDurationMs: null,
    };

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('boot-loading-banner')).toBeDefined();
    });
    expect(screen.queryByTestId('task-list-empty')).toBeNull();
    expect(screen.queryByTestId('task-list')).toBeNull();
  });

  it('shows TaskList (not boot banner) when phase is idle', async () => {
    bootStateRef.current = {
      phase: 'idle',
      steps: [],
      stepEntries: [],
      currentStep: null,
      startedAt: null,
      totalDurationMs: null,
    };

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('task-list')).toBeDefined();
    });
    expect(screen.queryByTestId('boot-loading-banner')).toBeNull();
  });

  it('shows the current step name and X-of-Y progress in the boot banner', async () => {
    bootStateRef.current = {
      phase: 'in_progress',
      steps: ['jsonl_import', 'worktree_reconciliation'],
      stepEntries: [{ name: 'jsonl_import', status: 'started' }],
      currentStep: 'jsonl_import',
      startedAt: new Date().toISOString(),
      totalDurationMs: null,
    };

    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('boot-loading-banner')).toBeDefined();
    });
    expect(screen.getByTestId('boot-current-step').textContent).toBe(
      'jsonl import',
    );
    expect(screen.getByTestId('boot-progress').textContent).toBe('Step 1 of 2');
  });

  it('clears boot banner and shows TaskList when phase transitions to completed', async () => {
    bootStateRef.current = {
      phase: 'in_progress',
      steps: ['jsonl_import'],
      stepEntries: [{ name: 'jsonl_import', status: 'started' }],
      currentStep: 'jsonl_import',
      startedAt: new Date().toISOString(),
      totalDurationMs: null,
    };

    const { rerender } = render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('boot-loading-banner')).toBeDefined();
    });

    act(() => {
      bootStateRef.current = {
        phase: 'completed',
        steps: ['jsonl_import'],
        stepEntries: [
          { name: 'jsonl_import', status: 'completed', duration_ms: 500 },
        ],
        currentStep: null,
        startedAt: new Date().toISOString(),
        totalDurationMs: 500,
      };
    });
    rerender(<App />);

    await waitFor(() => {
      expect(screen.queryByTestId('boot-loading-banner')).toBeNull();
    });
    expect(screen.getByTestId('task-list')).toBeDefined();
  });
});
