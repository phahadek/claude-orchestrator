/**
 * Behavioral tests for the code-session concurrency cap:
 * - runtimeSettings.max_concurrent_code_sessions is the sole authority.
 * - The admission check reserves a pendingStarts slot atomically with the
 *   check, so a batch of concurrent start() calls can't all read the same
 *   pre-insert count (the 20-against-4 regression).
 * - A reservation is released on a failure between the check and the
 *   in-memory Map insert, so a later launch is admitted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue('dev\n'),
    exec: vi
      .fn()
      .mockImplementation(
        (
          _cmd: string,
          _opts: unknown,
          cb: (err: null, result: { stdout: string; stderr: string }) => void,
        ) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        },
      ),
  };
});

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
    },
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    statSync: vi.fn().mockReturnValue({ isFile: () => false }),
  };
});

const mockRuntimeSettings = vi.hoisted(() => ({
  session_mode: 'cli' as string,
  max_concurrent_code_sessions: 4,
}));

vi.mock('../../config', () => ({
  config: {},
  runtimeSettings: mockRuntimeSettings,
  getProjectById: vi.fn().mockReturnValue({
    id: 'test-proj',
    name: 'Test Project',
    projectDir: '/tmp/test',
    taskSource: 'notion',
    autoLaunchEnabled: true,
    boards: [],
  }),
  normalizePath: (p: string) => p,
}));

vi.mock('../../db/queries', () =>
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
    getSetting: vi.fn().mockReturnValue(null),
  }),
);

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue('task content'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    mainBranch: 'main',
    bootstrapScript: null,
    prGate: null,
    bashRules: null,
    allowedTools: [],
  }),
}));

vi.mock('../ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue('context'),
}));

vi.mock('../orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue('review context'),
}));

vi.mock('../../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../../notion/NotionClient', () => ({
  parseSection: vi.fn().mockReturnValue(''),
}));

vi.mock('../../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('starting'),
}));

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
}));

vi.mock('../ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
}));

// Controllable AgentSession mock: default never settles, so completeStart()
// stays suspended and each launch's pendingStarts reservation is still live
// when we check the count — matching real launches, where the worktree/spawn
// chain takes far longer than the admission check.
vi.mock(import('../AgentSession'), async (importOriginal) => {
  const actual = await importOriginal();
  const AgentSession = vi
    .fn()
    .mockImplementation(
      (
        _sid: string,
        _url: string,
        _ctx: string,
        _override: unknown,
        _wt: string,
        _tid: string,
        _resume: string,
        _prompt: string,
        sessionType: string,
      ) => ({
        sessionType: sessionType ?? 'standard',
        taskId: null,
        prUrl: null,
        hasEnded: true,
        on: vi.fn(),
        run: vi.fn().mockReturnValue(new Promise(() => {})),
      }),
    );
  return {
    ...actual,
    AgentSession,
  };
});

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { SessionManager } from '../SessionManager';
import { AgentSession } from '../AgentSession';

const CTX_URL = 'https://www.notion.so/Context-abc123';

function taskUrl(n: number): string {
  // Each task needs a distinct Notion-style page id so dedup-by-task doesn't
  // collapse concurrent launches into "already running for task".
  const id = n.toString().padStart(32, '0');
  return `https://www.notion.so/Test-Task-${id}`;
}

describe('SessionManager code-session concurrency cap', () => {
  beforeEach(() => {
    mockRuntimeSettings.max_concurrent_code_sessions = 4;
    vi.mocked(AgentSession).mockImplementation(
      (
        _sid: string,
        _url: string,
        _ctx: string,
        _override: unknown,
        _wt: string,
        _tid: string,
        _resume: string,
        _prompt: string,
        sessionType: string,
      ) => ({
        sessionType: sessionType ?? 'standard',
        taskId: null,
        prUrl: null,
        hasEnded: true,
        on: vi.fn(),
        run: vi.fn().mockReturnValue(new Promise(() => {})),
      }),
    );
  });

  it('admits exactly the cap and rejects the remainder for N concurrent launches against cap M (regression: 20-against-4)', async () => {
    mockRuntimeSettings.max_concurrent_code_sessions = 4;
    const sm = new SessionManager();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        sm.start(taskUrl(i), CTX_URL, {
          sessionType: 'standard',
          projectId: 'test-proj',
          taskName: `Task ${i}`,
          taskKind: 'milestone',
        }),
      ),
    );

    const admitted = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(admitted).toHaveLength(4);
    expect(rejected).toHaveLength(16);
    for (const r of rejected as PromiseRejectedResult[]) {
      expect(String(r.reason)).toMatch(
        /Max concurrent code sessions \(4\) reached/,
      );
    }
    expect(sm.getLiveCodeSessionCount()).toBe(4);
  });

  it('serial launches admit up to exactly the cap and reject the next one, preserving the error message shape', async () => {
    mockRuntimeSettings.max_concurrent_code_sessions = 2;
    const sm = new SessionManager();

    await sm.start(taskUrl(100), CTX_URL, {
      sessionType: 'standard',
      projectId: 'test-proj',
      taskName: 'Task 100',
      taskKind: 'milestone',
    });
    await sm.start(taskUrl(101), CTX_URL, {
      sessionType: 'standard',
      projectId: 'test-proj',
      taskName: 'Task 101',
      taskKind: 'milestone',
    });
    expect(sm.getLiveCodeSessionCount()).toBe(2);

    await expect(
      sm.start(taskUrl(102), CTX_URL, {
        sessionType: 'standard',
        projectId: 'test-proj',
        taskName: 'Task 102',
        taskKind: 'milestone',
      }),
    ).rejects.toThrow('Max concurrent code sessions (2) reached');
  });

  it('releases the reservation on a launch that throws after the check and before the Map insert, admitting a following launch', async () => {
    mockRuntimeSettings.max_concurrent_code_sessions = 1;
    const sm = new SessionManager();

    vi.mocked(AgentSession).mockImplementationOnce(() => {
      throw new Error('simulated worktree failure');
    });

    await sm.start(taskUrl(200), CTX_URL, {
      sessionType: 'standard',
      projectId: 'test-proj',
      taskName: 'Task 200',
      taskKind: 'milestone',
    });
    // pendingStarts reservation is still live immediately after start()
    // returns — completeStart() is fire-and-forget and hasn't settled yet.
    expect(sm.getLiveCodeSessionCount()).toBe(1);

    // Flush microtasks so completeStart() rejects and its .catch() handler
    // releases the pendingStarts reservation.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sm.getLiveCodeSessionCount()).toBe(0);

    // A following launch is now admitted against the same cap of 1.
    await sm.start(taskUrl(201), CTX_URL, {
      sessionType: 'standard',
      projectId: 'test-proj',
      taskName: 'Task 201',
      taskKind: 'milestone',
    });
    expect(sm.getLiveCodeSessionCount()).toBe(1);
  });

  it('applies a runtimeSettings.max_concurrent_code_sessions change to the very next launch attempt with no restart', async () => {
    mockRuntimeSettings.max_concurrent_code_sessions = 1;
    const sm = new SessionManager();

    await sm.start(taskUrl(300), CTX_URL, {
      sessionType: 'standard',
      projectId: 'test-proj',
      taskName: 'Task 300',
      taskKind: 'milestone',
    });
    await expect(
      sm.start(taskUrl(301), CTX_URL, {
        sessionType: 'standard',
        projectId: 'test-proj',
        taskName: 'Task 301',
        taskKind: 'milestone',
      }),
    ).rejects.toThrow('Max concurrent code sessions (1) reached');

    // Simulate the settings route bumping the cap — no SessionManager restart.
    mockRuntimeSettings.max_concurrent_code_sessions = 2;

    await sm.start(taskUrl(302), CTX_URL, {
      sessionType: 'standard',
      projectId: 'test-proj',
      taskName: 'Task 302',
      taskKind: 'milestone',
    });
    expect(sm.getLiveCodeSessionCount()).toBe(2);
  });
});
