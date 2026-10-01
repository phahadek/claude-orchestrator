/**
 * Behavioral test for the Q1-addendum concurrency rule: groom/design (and,
 * once it exists, ops) planning sessions share ONE maxConcurrentPlanningSessions
 * pool, separate from the maxConcurrentCodeSessions pool used by standard
 * code sessions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from './helpers/mockDbQueries';

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('dev\n'),
  exec: vi.fn((...args: unknown[]) => {
    (args[args.length - 1] as (err: unknown, out: unknown) => void)(null, {
      stdout: '',
      stderr: '',
    });
  }),
  execFile: vi.fn((...args: unknown[]) => {
    (args[args.length - 1] as (err: unknown, out: unknown) => void)(null, {
      stdout: '',
      stderr: '',
    });
  }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue(''),
      statSync: vi.fn().mockReturnValue({ isFile: () => false }),
      mkdirSync: vi.fn(),
    },
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    statSync: vi.fn().mockReturnValue({ isFile: () => false }),
    mkdirSync: vi.fn(),
  };
});

vi.mock('../config', () => ({
  config: {},
  runtimeSettings: {
    session_mode: 'cli',
    max_concurrent_planning_sessions: 2,
    max_concurrent_code_sessions: 10,
  },
  getProjectById: vi.fn().mockReturnValue({
    id: 'test-proj',
    name: 'Test Project',
    projectDir: '/tmp/test',
    taskSource: 'yaml',
    gitMode: 'local-only',
    autoLaunchEnabled: false,
    dataResidencyConfirmed: true,
    boards: [],
  }),
  normalizePath: (p: string) => p,
}));

vi.mock('../db/queries', () =>
  mockDbQueries({
    getGrantedCapabilities: vi.fn(() => []),
    insertSession: vi.fn(),
    updateSessionStatus: vi.fn(),
    getPRByNotionTaskId: vi.fn().mockReturnValue(null),
    getSession: vi.fn().mockReturnValue(null),
    insertEvent: vi.fn(),
    getSessionsByStatus: vi.fn().mockReturnValue([]),
    getEventsBySession: vi.fn().mockReturnValue([]),
    getPRByNumber: vi.fn().mockReturnValue(null),
    hasActiveSessionForTask: vi.fn().mockReturnValue(false),
    hasActivePlanningSessionForTask: vi.fn().mockReturnValue(false),
    getStuckResultSessionRows: vi.fn().mockReturnValue([]),
    TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
  }),
);

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue('task content'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../session/orchestrator-config', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    mainBranch: 'main',
    bootstrap_script: null,
    verify: [],
    bash_rules: [],
    allowed_tools: [],
    required_env: [],
    required_files: [],
    review_rules: [],
    session_rules: [],
  }),
  getSessionAllowedTools: vi.fn(() => []),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue('context'),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue('review context'),
}));

vi.mock('../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../notion/NotionClient', () => ({
  parseSection: vi.fn().mockReturnValue(''),
}));

vi.mock('../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('starting'),
}));

vi.mock('../session/CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
  PreSpawnConfigError: class PreSpawnConfigError extends Error {},
}));

vi.mock('../session/ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
}));

vi.mock('../session/AgentSession', () => {
  const AgentSession = vi.fn().mockImplementation(() => ({
    sessionType: 'standard',
    taskId: 'fake',
    prUrl: null,
    hasEnded: true,
    on: vi.fn(),
    run: vi.fn().mockReturnValue(new Promise(() => {})),
    injectContextFile: vi.fn(),
  }));
  return {
    AgentSession,
    parseNotionPageIdDashed: vi.fn().mockImplementation((url: string) => {
      const segment = url.split('/').pop() ?? url;
      const raw = segment
        .replace(/[^a-f0-9]/gi, '')
        .slice(-32)
        .padEnd(32, '0');
      return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
    }),
  };
});

vi.mock('../config/corporateMode', () => ({
  getCorporateMode: vi.fn().mockReturnValue({
    enabled: false,
    envLocked: false,
    gates: {
      dockerMandatory: false,
      requireHumanApproval: false,
      requireZDR: false,
      validatePRBody: false,
    },
  }),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { SessionManager } from '../session/SessionManager';
import * as queries from '../db/queries';

const TASK_URL =
  'https://www.notion.so/Test-Task-abc123def456789012345678901234ab';
const CTX_URL = 'https://notion.so/context';
const PROJECT_ID = 'test-proj';

/** Directly seeds a fake live session into the SessionManager's in-memory map. */
function seedLiveSession(
  sm: SessionManager,
  id: string,
  sessionType: string,
): void {
  (
    sm as unknown as { sessions: Map<string, { sessionType: string }> }
  ).sessions.set(id, { sessionType });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionManager.start() — shared planning concurrency cap', () => {
  it('rejects a groom start once the shared planning pool (cap=2) is full of design sessions', async () => {
    const sm = new SessionManager();
    seedLiveSession(sm, 'live-design-1', 'design');
    seedLiveSession(sm, 'live-design-2', 'design');

    await expect(
      sm.start(TASK_URL, CTX_URL, {
        sessionType: 'groom',
        projectId: PROJECT_ID,
        taskKind: 'milestone',
      }),
    ).rejects.toThrow(/Max concurrent planning sessions/);
  });

  it('groom and design share one pool — one of each already counts as 2 toward cap=2', async () => {
    const sm = new SessionManager();
    seedLiveSession(sm, 'live-groom-1', 'groom');
    seedLiveSession(sm, 'live-design-1', 'design');

    await expect(
      sm.start(TASK_URL, CTX_URL, {
        sessionType: 'design',
        projectId: PROJECT_ID,
        taskKind: 'milestone',
      }),
    ).rejects.toThrow(/Max concurrent planning sessions/);
  });

  it('standard code sessions are not counted against, or blocked by, the planning cap', async () => {
    const sm = new SessionManager();
    seedLiveSession(sm, 'live-design-1', 'design');
    seedLiveSession(sm, 'live-design-2', 'design');

    // The planning pool is full, but a standard session is a different pool
    // (maxConcurrentCodeSessions=10, no standard sessions live) and must succeed.
    const id = await sm.start(TASK_URL, CTX_URL, {
      sessionType: 'standard',
      projectId: PROJECT_ID,
      taskKind: 'milestone',
    });
    expect(typeof id).toBe('string');
  });

  it('live standard sessions do not count toward the planning cap', async () => {
    const sm = new SessionManager();
    seedLiveSession(sm, 'live-standard-1', 'standard');
    seedLiveSession(sm, 'live-standard-2', 'standard');

    const id = await sm.start(TASK_URL, CTX_URL, {
      sessionType: 'design',
      projectId: PROJECT_ID,
      taskKind: 'milestone',
    });
    expect(typeof id).toBe('string');
  });

  it('ops shares the planning pool with groom/design — rejects once cap=2 is full of design sessions', async () => {
    const sm = new SessionManager();
    seedLiveSession(sm, 'live-design-1', 'design');
    seedLiveSession(sm, 'live-design-2', 'design');

    await expect(
      sm.start(TASK_URL, CTX_URL, {
        sessionType: 'ops',
        projectId: PROJECT_ID,
        taskKind: 'milestone',
      }),
    ).rejects.toThrow(/Max concurrent planning sessions/);
  });

  it('live ops sessions do not count toward maxConcurrentCodeSessions and do not block a standard session', async () => {
    const sm = new SessionManager();
    seedLiveSession(sm, 'live-ops-1', 'ops');

    const id = await sm.start(TASK_URL, CTX_URL, {
      sessionType: 'standard',
      projectId: PROJECT_ID,
      taskKind: 'milestone',
    });
    expect(typeof id).toBe('string');
  });

  it('getLiveCodeSessionCount excludes ops sessions', () => {
    const sm = new SessionManager();
    seedLiveSession(sm, 'live-ops-1', 'ops');
    seedLiveSession(sm, 'live-standard-1', 'standard');

    expect(sm.getLiveCodeSessionCount()).toBe(1);
  });
});

describe("SessionManager.endSession() — releasing a terminal planning session's slot", () => {
  function seedSettledGroom(sm: SessionManager, id: string): void {
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, {
      sessionType: 'groom',
      endSession: vi.fn().mockResolvedValue(undefined),
    });
  }
  const startGroom = (sm: SessionManager) =>
    sm.start(TASK_URL, CTX_URL, {
      sessionType: 'groom',
      projectId: PROJECT_ID,
      taskKind: 'milestone',
    });

  it('with the cap (2) full of terminal-but-unreaped sessions, ending them frees the slot for a new launch', async () => {
    const sm = new SessionManager();
    const ids = ['term-1', 'term-2'];
    for (const id of ids) seedSettledGroom(sm, id);
    vi.mocked(queries.getSession).mockImplementation(
      (id: string) => ({ session_id: id, status: 'done' }) as never,
    );

    await expect(startGroom(sm)).rejects.toThrow(
      /Max concurrent planning sessions/,
    );

    for (const id of ids) sm.endSession(id);

    expect(typeof (await startGroom(sm))).toBe('string');
  });

  it('an idle groom left in the map still holds its slot at the cap', async () => {
    const sm = new SessionManager();
    seedSettledGroom(sm, 'idle-1');
    seedSettledGroom(sm, 'idle-2');
    vi.mocked(queries.getSession).mockImplementation(
      (id: string) => ({ session_id: id, status: 'idle' }) as never,
    );

    await expect(startGroom(sm)).rejects.toThrow(
      /Max concurrent planning sessions/,
    );
  });

  it('endSession on a non-terminal row keeps the map entry', () => {
    const sm = new SessionManager();
    seedSettledGroom(sm, 'idle-1');
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'idle-1',
      status: 'idle',
    } as never);

    sm.endSession('idle-1');

    expect(
      (sm as unknown as { sessions: Map<string, unknown> }).sessions.has(
        'idle-1',
      ),
    ).toBe(true);
  });
});
