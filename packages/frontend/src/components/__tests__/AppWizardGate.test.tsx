import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Minimal mocks to allow App to render
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
    lastCiBillingBlockedEvent: null,
    lastSessionStartedEvent: null,
    lastSessionEndedEvent: null,
  }),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: vi.fn(), connectionState: 'connected' }),
}));

vi.mock('../../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: () => {},
}));

vi.mock('../../hooks/useNotifications', () => ({
  useNotifications: () => {},
}));

vi.mock('../Header', () => ({
  Header: () => <div data-testid="dashboard-header">Header</div>,
}));

vi.mock('../Notifications', () => ({ Notifications: () => null }));
vi.mock('../ShortcutHint', () => ({ ShortcutHint: () => null }));
vi.mock('../TaskList', () => ({
  TaskList: () => <div data-testid="task-list" />,
}));

// Mock SetupWizard to keep the test lightweight
vi.mock('../../wizard/SetupWizard', () => ({
  SetupWizard: ({ onComplete }: { onComplete: (g?: boolean) => void }) => (
    <div data-testid="setup-wizard">
      <button
        type="button"
        data-testid="wizard-complete"
        onClick={() => onComplete(false)}
      >
        Complete
      </button>
    </div>
  ),
}));

import App from '../../App';

const localStore: Record<string, string> = {};
beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => localStore[k] ?? null,
    setItem: (k: string, v: string) => { localStore[k] = v; },
    removeItem: (k: string) => { delete localStore[k]; },
    clear: () => { Object.keys(localStore).forEach((k) => delete localStore[k]); },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.keys(localStore).forEach((k) => delete localStore[k]);
});

describe('App — setup wizard gate', () => {
  it('shows the wizard when setup/status returns setupNeeded=true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          json: async () => {
            if (url.includes('setup/status')) return { setupNeeded: true };
            if (url.includes('/api/config')) return [];
            if (url.includes('/api/settings')) return {};
            if (url.includes('/api/tasks')) return [];
            return {};
          },
        }),
      ),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('setup-wizard')).toBeDefined();
    });

    expect(screen.queryByTestId('dashboard-header')).toBeNull();
  });

  it('shows the dashboard when setup/status returns setupNeeded=false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          json: async () => {
            if (url.includes('setup/status')) return { setupNeeded: false };
            if (url.includes('/api/config')) return [];
            if (url.includes('/api/settings')) return {};
            if (url.includes('/api/tasks')) return [];
            return {};
          },
        }),
      ),
    );

    render(<App />);

    // Dashboard renders immediately (optimistic)
    await waitFor(() => {
      expect(screen.getByTestId('dashboard-header')).toBeDefined();
    });

    expect(screen.queryByTestId('setup-wizard')).toBeNull();
  });
});
