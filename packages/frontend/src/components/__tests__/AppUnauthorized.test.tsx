import { render, screen, waitFor, act } from '@testing-library/react';
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

vi.mock('../../wizard/SetupWizard', () => ({
  SetupWizard: () => <div data-testid="setup-wizard" />,
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

function makeResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  };
}

describe('App — unauthorized device routing', () => {
  it('shows EnrollmentFlow when /api/config returns 401, not an error boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if ((url as string).includes('setup/status'))
          return Promise.resolve(makeResponse(200, { setupNeeded: false }));
        if ((url as string).includes('/api/config'))
          return Promise.resolve(makeResponse(401, { error: 'unauthorized', code: 'device_not_enrolled' }));
        return Promise.resolve(makeResponse(200, {}));
      }),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/device authorization/i)).toBeDefined();
    });

    // Error boundary text must not appear
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });

  it('shows loopback-required error on 403 bootstrap_loopback_only, not EnrollmentFlow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if ((url as string).includes('setup/status'))
          return Promise.resolve(makeResponse(200, { setupNeeded: false }));
        if ((url as string).includes('/api/config'))
          return Promise.resolve(
            makeResponse(403, { error: 'forbidden', code: 'bootstrap_loopback_only' }),
          );
        return Promise.resolve(makeResponse(200, {}));
      }),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/local access required/i)).toBeDefined();
    });

    // EnrollmentFlow must not appear
    expect(screen.queryByText(/device authorization/i)).toBeNull();
  });

  it('dispatches device-unauthorized event routes to EnrollmentFlow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if ((url as string).includes('setup/status'))
          return Promise.resolve(makeResponse(200, { setupNeeded: false }));
        return Promise.resolve(makeResponse(200, {}));
      }),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-header')).toBeDefined();
    });

    await act(async () => {
      window.dispatchEvent(new CustomEvent('device-unauthorized'));
    });

    await waitFor(() => {
      expect(screen.getByText(/device authorization/i)).toBeDefined();
    });

    expect(screen.queryByTestId('dashboard-header')).toBeNull();
  });

  it('does not clear device_token when 401 fires', async () => {
    localStore['device_token'] = 'my-token';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if ((url as string).includes('setup/status'))
          return Promise.resolve(makeResponse(200, { setupNeeded: false }));
        if ((url as string).includes('/api/config'))
          return Promise.resolve(makeResponse(401, { error: 'unauthorized' }));
        return Promise.resolve(makeResponse(200, {}));
      }),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/device authorization/i)).toBeDefined();
    });

    expect(localStore['device_token']).toBe('my-token');
  });
});
