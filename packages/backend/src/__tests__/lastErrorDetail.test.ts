/**
 * Tests that last_error_detail is populated on every session error transition:
 * - AgentSession non-zero exit sets last_error_detail with exit code
 * - AgentSession non-zero exit with non-transient error event includes snippet
 * - AgentSession null exit sets last_error_detail with "process killed unexpectedly"
 * - AgentSession kill() sets last_error_detail with "killed by user request"
 * - SessionManager.markSessionErrored propagates detail to setSessionLastErrorDetail
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// ── Mock child_process (must include exec for SessionManager) ───────────────

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk: unknown, _enc: unknown, cb: () => void) {
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 11111,
    exitCode: null,
  });
  return { proc, stdout, stderr };
}

let mockProc: ReturnType<typeof createMockProc>;

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => mockProc.proc),
    execFile: vi.fn(),
    execSync: vi.fn(() => 'feature/task\n'),
    exec: vi.fn().mockImplementation(
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

// ── Mock DB queries ────────────────────────────────────────────────────────

vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(() => ({ id: 1 })),
  incrementTokens: vi.fn(),
  incrementCompactionCount: vi.fn(),
  setContextOccupancy: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNotionTaskId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  setSessionPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  getSession: vi.fn(() => null),
  getSessionTags: vi.fn(() => []),
  setSessionTags: vi.fn(),
  resetTaskCrashCount: vi.fn(),
  incrementTaskCrashCount: vi.fn(() => 1),
  setSessionLastErrorDetail: vi.fn(),
  insertSession: vi.fn(),
  updateSessionWorktreePath: vi.fn(),
  getSessionsByStatus: vi.fn(() => []),
  insertEvent: vi.fn(),
  hasActiveSessionForTask: vi.fn(() => false),
  getOtherRunningSessionsForTask: vi.fn(() => []),
  getStuckResultSessionRows: vi.fn(() => []),
  getRunningSessionsWithMergedOrClosedPR: vi.fn(() => []),
  getTerminalSessionsForTask: vi.fn(() => []),
  markSessionSuperseded: vi.fn(),
  setTaskPauseReason: vi.fn(),
}));

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  return {
    ...actual,
    config: { maxConcurrentCodeSessions: 10 },
    ALLOWED_TOOLS: [],
    GITHUB_REPO: 'owner/repo',
    runtimeSettings: { sessionMode: 'cli', session_mode: 'cli' },
    getProjectById: vi.fn().mockReturnValue({
      id: 'proj-1',
      name: 'Test',
      baseBranch: 'dev',
      projectDir: '/tmp/test',
      taskSource: 'notion',
    }),
    normalizePath: (p: string) => p,
  };
});

vi.mock('../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(async () => 'feature/my-task'),
  hasNonEmptyDiff: vi.fn(async () => false),
}));

vi.mock('../github/NoOpInvestigator', () => ({
  NoOpInvestigator: vi.fn().mockImplementation(() => ({
    investigate: vi.fn(async () => {}),
  })),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
  countPushFailureEvents: vi.fn(() => 0),
}));

vi.mock('../session/sessionRecovery', () => ({
  recoverSession: vi.fn(async () => {}),
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
    bashRules: [],
    bash_rules: [],
    allowedTools: [],
    allowed_tools: [],
    verify: [],
    mcp_servers: {},
  }),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue('context'),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue('review context'),
}));

vi.mock('../session/branchModel', () => ({
  resolveStartingPoint: vi.fn().mockResolvedValue('dev'),
  ensureMilestoneBranch: vi.fn().mockResolvedValue(undefined),
  deriveBranchSlug: vi.fn().mockReturnValue('feature/test-task'),
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

// ── Imports (after all vi.mock calls) ─────────────────────────────────────

import { AgentSession } from '../session/AgentSession';
import { SessionManager } from '../session/SessionManager';
import {
  setSessionLastErrorDetail,
  getEventsBySession,
  updateSessionStatus,
  getSession,
} from '../db/queries';
import type { TaskBackend } from '../tasks/TaskBackend';

// ── Helpers ────────────────────────────────────────────────────────────────

function fakeTaskBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    attachPR: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    fetchTaskPage: vi.fn(async () => ''),
  };
}

function makeSession(taskId = 'notion:task-abc') {
  return new AgentSession(
    'sess-err-detail',
    'https://notion.so/task',
    'https://notion.so/ctx',
    fakeTaskBackend(),
    '/tmp/worktree',
    taskId,
  );
}

// ── Tests — AgentSession exit paths ───────────────────────────────────────

describe('last_error_detail — AgentSession exit paths', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
  });

  it('sets last_error_detail with exit code when process exits non-zero', async () => {
    const session = makeSession();
    const runPromise = session.run();

    await new Promise((r) => setTimeout(r, 10));
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 50));
    mockProc.proc.emit('exit', 1);
    await runPromise;

    expect(setSessionLastErrorDetail).toHaveBeenCalledWith(
      'sess-err-detail',
      expect.stringContaining('code 1'),
    );
    expect(updateSessionStatus).toHaveBeenCalledWith(
      'sess-err-detail',
      'error',
      expect.any(Number),
    );
  });

  it('includes last error event snippet when exit is non-zero and last event is non-transient error', async () => {
    // Use a non-transient error type (authentication_error) so isTransientApiError() returns false
    // and the retry path is not taken.
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'sess-err-detail',
        event_type: 'system',
        payload: JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid API key' },
        }),
        created_at: 0,
      } as never,
    ]);

    const session = makeSession();
    const runPromise = session.run();

    await new Promise((r) => setTimeout(r, 10));
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 50));
    mockProc.proc.emit('exit', 2);
    await runPromise;

    expect(setSessionLastErrorDetail).toHaveBeenCalledWith(
      'sess-err-detail',
      expect.stringMatching(/code 2.*last error:/),
    );
  });

  it(
    'sets last_error_detail to "process killed unexpectedly" on null exit code',
    async () => {
      const session = makeSession();
      const runPromise = session.run();

      await new Promise((r) => setTimeout(r, 10));
      // Push EOF first and wait long enough for readline to close.
      mockProc.stdout.push(null);
      await new Promise((r) => setTimeout(r, 200));
      mockProc.proc.emit('exit', null);
      await runPromise;

      expect(setSessionLastErrorDetail).toHaveBeenCalledWith(
        'sess-err-detail',
        'process killed unexpectedly',
      );
    },
    10_000,
  );

  it(
    'sets last_error_detail to "killed by user request" when kill() is called',
    async () => {
      const session = makeSession();
      const runPromise = session.run();

      // Wait for session to start.
      await new Promise((r) => setTimeout(r, 10));

      // Start kill() — it sets isKilling=true and waits for proc exit.
      const killPromise = session.kill();

      // Give kill() a moment to register the exit listener, then emit exit.
      await new Promise((r) => setTimeout(r, 10));
      mockProc.stdout.push(null);
      await new Promise((r) => setTimeout(r, 200));
      mockProc.proc.emit('exit', null);

      await Promise.all([runPromise, killPromise]);

      expect(setSessionLastErrorDetail).toHaveBeenCalledWith(
        'sess-err-detail',
        'killed by user request',
      );
    },
    10_000,
  );
});

// ── Tests — SessionManager.markSessionErrored ─────────────────────────────

describe('last_error_detail — SessionManager.markSessionErrored', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
  });

  it('calls setSessionLastErrorDetail when detail is provided', () => {
    const sm = new SessionManager();

    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-sm-test',
      status: 'running',
      task_id: null,
      session_type: 'standard',
      project_id: null,
      worktree_path: null,
    } as never);

    sm.markSessionErrored('sess-sm-test', 'error', 'run_error', 'subprocess crashed: SIGSEGV');

    expect(setSessionLastErrorDetail).toHaveBeenCalledWith(
      'sess-sm-test',
      'subprocess crashed: SIGSEGV',
    );
    expect(updateSessionStatus).toHaveBeenCalledWith(
      'sess-sm-test',
      'error',
      expect.any(Number),
    );
  });

  it('does not call setSessionLastErrorDetail when no detail is provided', () => {
    const sm = new SessionManager();

    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-sm-nodetail',
      status: 'running',
      task_id: null,
      session_type: 'standard',
      project_id: null,
      worktree_path: null,
    } as never);

    sm.markSessionErrored('sess-sm-nodetail', 'error', 'run_error');

    expect(setSessionLastErrorDetail).not.toHaveBeenCalled();
  });

  it('each covered error reason passes a non-null detail to setSessionLastErrorDetail', () => {
    const sm = new SessionManager();

    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-reasons',
      status: 'running',
      task_id: null,
      session_type: 'standard',
      project_id: null,
      worktree_path: null,
    } as never);

    const details = [
      'worktree missing: /some/path',
      'no events within 30s of resume',
      'max concurrent code sessions reached',
      'subprocess run error',
      'worktree recreation failed: git error',
    ];

    for (const detail of details) {
      vi.mocked(setSessionLastErrorDetail).mockClear();
      sm.markSessionErrored('sess-reasons', 'error', 'test_reason', detail);
      expect(setSessionLastErrorDetail).toHaveBeenCalledWith('sess-reasons', detail);
    }
  });
});
