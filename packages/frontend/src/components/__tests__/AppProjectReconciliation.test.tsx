import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../hooks/useSessionStore', () => ({
  useSessionStore: () => ({
    sessions: [
      {
        sessionId: 's-stale',
        project_id: 'stale-project',
        taskName: 'Stale Task',
        status: 'done',
        events: [],
        archived: false,
        tags: [],
      },
      {
        sessionId: 's-server',
        project_id: 'server-project',
        taskName: 'Server Task',
        status: 'done',
        events: [],
        archived: false,
        tags: [],
      },
    ],
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
    lastStuckNotification: null,
    lastStuckPaused: null,
    lastStuckKilled: null,
    incompleteReviews: [],
    lastTaskUpdate: null,
    taskListRefreshTrigger: 0,
  }),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: vi.fn(), connectionState: 'connected' }),
}));

vi.mock('../../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: () => {},
}));

vi.mock('../Header', () => ({
  Header: ({
    activeProjectId,
    activeBoardId,
    activeView,
    onViewChange,
  }: {
    activeProjectId: string | null;
    activeBoardId: string | null;
    activeView: string;
    onViewChange: (v: string) => void;
  }) => (
    <div>
      <div
        data-testid="header"
        data-active-project={activeProjectId ?? ''}
        data-active-board={activeBoardId ?? ''}
        data-active-view={activeView}
      />
      <button onClick={() => onViewChange('sessions')}>Sessions</button>
      <button onClick={() => onViewChange('tasks')}>Tasks</button>
    </div>
  ),
}));

vi.mock('../SessionGrid', () => ({
  SessionGrid: ({
    sessions,
  }: {
    sessions: { sessionId: string; taskName: string }[];
  }) => (
    <div data-testid="session-grid">
      {sessions.map((s) => (
        <div key={s.sessionId} data-testid={`session-${s.sessionId}`}>
          {s.taskName}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('../PRPanel', () => ({
  PRPanel: () => <div data-testid="pr-panel" />,
}));

vi.mock('../HistoryGrid', () => ({
  HistoryGrid: () => <div data-testid="history-grid" />,
}));

vi.mock('../Notifications', () => ({ Notifications: () => null }));
vi.mock('../ShortcutHint', () => ({ ShortcutHint: () => null }));
vi.mock('../DispatchModal', () => ({ DispatchModal: () => null }));
vi.mock('../TaskList', () => ({
  TaskList: () => <div data-testid="task-list" />,
}));
vi.mock('../TaskDetail', () => ({
  TaskDetail: () => <div data-testid="task-detail" />,
}));

function makeLocalStore(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
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
  };
}

function jsonFor(url: string, projects: object[]) {
  if (url.includes('/api/config')) return projects;
  if (url.includes('/api/tasks')) return [];
  if (url.includes('/api/settings')) return {};
  return {};
}

function makeFetch(projects: object[]) {
  return vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: async () => jsonFor(url, projects),
    }),
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import App from '../../App';

const SERVER_PROJECT = {
  id: 'server-project',
  name: 'Server Project',
  projectDir: '/srv',
  contextUrl: '',
  boardId: 'board-srv',
  boards: [{ id: 'board-srv', name: 'Sprint' }],
};

describe('App — project reconciliation after /api/config', () => {
  it('uses server-default project when stale localStorage ID is absent from config', async () => {
    vi.stubGlobal(
      'localStorage',
      makeLocalStore({ activeProjectId: 'stale-project' }),
    );
    vi.stubGlobal('fetch', makeFetch([SERVER_PROJECT]));

    render(<App />);

    // Before config resolves: header shows no project yet
    expect(
      screen.getByTestId('header').getAttribute('data-active-project'),
    ).toBe('');

    // After config resolves: header shows server-truth project, never stale
    await waitFor(() => {
      expect(
        screen.getByTestId('header').getAttribute('data-active-project'),
      ).toBe('server-project');
    });
    expect(
      screen.getByTestId('header').getAttribute('data-active-project'),
    ).not.toBe('stale-project');
  });

  it('retains localStorage project ID when it is present in the config response', async () => {
    const SECOND_PROJECT = {
      id: 'project-b',
      name: 'Project B',
      projectDir: '/b',
      contextUrl: '',
      boardId: 'board-b',
      boards: [{ id: 'board-b', name: 'Board B' }],
    };
    vi.stubGlobal(
      'localStorage',
      makeLocalStore({ activeProjectId: 'project-b' }),
    );
    vi.stubGlobal('fetch', makeFetch([SERVER_PROJECT, SECOND_PROJECT]));

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByTestId('header').getAttribute('data-active-project'),
      ).toBe('project-b');
    });
  });

  it('uses server-default board when stored board ID is absent from project boards', async () => {
    const PROJECT_WITH_BOARDS = {
      id: 'proj-x',
      name: 'Proj X',
      projectDir: '/x',
      contextUrl: '',
      boardId: 'board-default',
      boards: [{ id: 'board-default', name: 'Default' }],
    };
    vi.stubGlobal(
      'localStorage',
      makeLocalStore({
        activeProjectId: 'proj-x',
        'activeMilestone_proj-x': 'board-stale',
      }),
    );
    vi.stubGlobal('fetch', makeFetch([PROJECT_WITH_BOARDS]));

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByTestId('header').getAttribute('data-active-board'),
      ).toBe('board-default');
    });
  });

  it('sessions from stale project never appear; only server-project sessions show after config', async () => {
    vi.stubGlobal(
      'localStorage',
      makeLocalStore({ activeProjectId: 'stale-project' }),
    );

    let resolveConfig!: () => void;
    const configDeferred = new Promise<void>((res) => {
      resolveConfig = res;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.includes('/api/config')
          ? configDeferred.then(() =>
              Promise.resolve({
                ok: true,
                json: async () => [SERVER_PROJECT],
              }),
            )
          : Promise.resolve({
              ok: true,
              json: async () => (url.includes('/api/tasks') ? [] : {}),
            }),
      ),
    );

    render(<App />);

    // Switch to sessions view so SessionGrid is mounted
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));

    // Before config resolves: no sessions visible (activeProjectId is null)
    expect(screen.queryByTestId('session-s-stale')).toBeNull();
    expect(screen.queryByTestId('session-s-server')).toBeNull();

    resolveConfig();

    // After config: only server-project session visible, stale session never shown
    await waitFor(() => {
      expect(screen.getByTestId('session-s-server')).toBeDefined();
    });
    expect(screen.queryByTestId('session-s-stale')).toBeNull();
  });
});
