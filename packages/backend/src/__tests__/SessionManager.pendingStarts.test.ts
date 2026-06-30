/**
 * Behavioral tests for the pendingStarts concurrency fix.
 * These tests actually call SessionManager.start() at runtime and verify
 * getLiveCodeSessionCount() returns the correct value synchronously / after rejection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// child_process: prevent real git operations
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

// fs: prevent real file writes
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

vi.mock('../config', () => ({
  config: { maxConcurrentCodeSessions: 10 },
  runtimeSettings: { session_mode: 'cli' },
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

vi.mock('../db/queries', () => ({
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
  setSessionLastErrorDetail: vi.fn(),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue('task content'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    mainBranch: 'main',
    bootstrapScript: null,
    prGate: null,
    bashRules: null,
    allowedTools: [],
  }),
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
}));

vi.mock('../session/ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
}));

// Controllable AgentSession mock: default succeeds, can be overridden per-test.
vi.mock(import('../session/AgentSession'), async (importOriginal) => {
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
        // never resolves — keeps wireSession from triggering cleanup
        run: vi.fn().mockReturnValue(new Promise(() => {})),
      }),
    );
  return {
    ...actual,
    AgentSession,
  };
});

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { SessionManager } from '../session/SessionManager';
import { AgentSession } from '../session/AgentSession';

const TASK_URL =
  'https://www.notion.so/Test-Task-abc123def456789012345678901234';
const CTX_URL = 'https://www.notion.so/Context-abc123';

describe('SessionManager.getLiveCodeSessionCount() — behavioral pendingStarts tests', () => {
  beforeEach(() => {
    // Reset AgentSession mock to the default (succeeding) implementation
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

  it('AC #1: returns 1 immediately (synchronously) after start() for a standard session', () => {
    const sm = new SessionManager();
    sm.start(TASK_URL, CTX_URL, {
      sessionType: 'standard',
      projectId: 'test-proj',
      taskName: 'Test Task',
      taskKind: 'milestone',
    });
    // Synchronous check — launchSession() is suspended at "await fetchTaskPage",
    // so pendingStarts still contains the entry.
    expect(sm.getLiveCodeSessionCount()).toBe(1);
  });

  it('AC #2: returns 0 after launchSession rejects (simulated worktree failure)', async () => {
    // Use mockImplementation (not Once) so concurrent sessions from other tests
    // don't consume the throw before this session reaches AgentSession.
    vi.mocked(AgentSession).mockImplementation(() => {
      throw new Error('simulated worktree failure');
    });

    const sm = new SessionManager();
    // await so start() completes its exec chain; launchSession() is still pending
    // (fire-and-forget) so pendingStarts still has the entry.
    await sm.start(TASK_URL, CTX_URL, {
      sessionType: 'standard',
      projectId: 'test-proj',
      taskName: 'Test Task',
      taskKind: 'milestone',
    });

    // Count is 1 right after start() — launchSession hasn't settled yet
    expect(sm.getLiveCodeSessionCount()).toBe(1);

    // Flush microtasks: fetchTaskPage resolves → launchSession continues →
    // AgentSession throws → launchSession rejects → .catch() runs →
    // pendingStarts.delete(sessionId). setTimeout is a macrotask that runs
    // after the entire microtask queue drains.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sm.getLiveCodeSessionCount()).toBe(0);
  });

  it('AC #3: review sessionType does not count toward getLiveCodeSessionCount()', () => {
    const sm = new SessionManager();
    sm.start(TASK_URL, CTX_URL, {
      sessionType: 'review',
      projectId: 'test-proj',
      taskName: 'Review Task',
    });
    // Review sessions must not increment the code session count,
    // whether the entry is in pendingStarts or sessions.
    expect(sm.getLiveCodeSessionCount()).toBe(0);
  });
});
