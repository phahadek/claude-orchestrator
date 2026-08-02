import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    lastReviewFailed: null,
    incompleteReviews: [],
    lastTaskUpdate: null,
    lastStagedIntentChange: null,
    taskListRefreshTrigger: 0,
  }),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: vi.fn(), connectionState: 'connected' }),
}));

vi.mock('../../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: () => {},
}));

vi.mock('../TaskList', () => ({
  TaskList: () => <div data-testid="task-list">TaskList</div>,
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

function stubProjects(projects: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => projects,
    }),
  );
}

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

import App from '../../App';

describe('App milestone view', () => {
  beforeEach(() => {
    stubLocalStorage();
    mockMatchMedia(false);
  });

  it('switches to the milestone shell and renders its three regions when a milestone is active', async () => {
    stubProjects([
      {
        id: 'proj-1',
        name: 'Project 1',
        projectDir: '/p',
        contextUrl: '',
        boardId: 'board-1',
        boards: [{ id: 'board-1', name: 'M1' }],
      },
    ]);
    render(<App />);
    await waitFor(() => screen.getByRole('button', { name: 'Milestone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Milestone' }));

    expect(screen.getByTestId('milestone-view-shell')).toBeDefined();
    expect(screen.getByTestId('milestone-burndown-mount')).toBeDefined();
    expect(screen.getByTestId('milestone-decision-stack-mount')).toBeDefined();
    expect(screen.getByTestId('milestone-drilldown-mount')).toBeDefined();
    expect(screen.queryByTestId('milestone-empty-state')).toBeNull();
  });

  it('renders the empty state when no active milestone is selected', async () => {
    stubProjects([
      {
        id: 'proj-1',
        name: 'Project 1',
        projectDir: '/p',
        contextUrl: '',
        boardId: '',
        boards: [],
      },
    ]);
    render(<App />);
    await waitFor(() => screen.getByRole('button', { name: 'Milestone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Milestone' }));

    expect(screen.getByTestId('milestone-empty-state')).toBeDefined();
    expect(screen.queryByTestId('milestone-view-shell')).toBeNull();
  });

  it('shows a tab switch below the breakpoint, mounting only one region at a time', async () => {
    mockMatchMedia(true);
    stubProjects([
      {
        id: 'proj-1',
        name: 'Project 1',
        projectDir: '/p',
        contextUrl: '',
        boardId: 'board-1',
        boards: [{ id: 'board-1', name: 'M1' }],
      },
    ]);
    render(<App />);
    await waitFor(() => screen.getByRole('button', { name: 'Milestone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Milestone' }));

    expect(screen.getByTestId('milestone-view-shell')).toBeDefined();

    // Only the default (burndown) region is mounted initially.
    expect(screen.getByTestId('milestone-burndown-mount')).toBeDefined();
    expect(screen.queryByTestId('milestone-decision-stack-mount')).toBeNull();
    expect(screen.queryByTestId('milestone-drilldown-mount')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Decisions' }));
    expect(screen.queryByTestId('milestone-burndown-mount')).toBeNull();
    expect(screen.getByTestId('milestone-decision-stack-mount')).toBeDefined();
    expect(screen.queryByTestId('milestone-drilldown-mount')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Drill-down' }));
    expect(screen.queryByTestId('milestone-burndown-mount')).toBeNull();
    expect(screen.queryByTestId('milestone-decision-stack-mount')).toBeNull();
    expect(screen.getByTestId('milestone-drilldown-mount')).toBeDefined();
  });
});
