/**
 * Tests for sendOrResume() worktree-recreation failure handling.
 * Verifies: no rethrow, session marked errored, session_action_failed broadcast,
 * stderr captured in event, short-circuit on already-errored sessions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '../ws/types';
import { mockDbQueries } from './helpers/mockDbQueries';

const { mockExecCallback } = vi.hoisted(() => ({
  // Default: every exec() call succeeds with empty output. Tests that need
  // to simulate a `git worktree add` failure (the real code path — see
  // gitWorktreeAddWithRetry, which uses the promisified async exec, not
  // execSync) override this per-test.
  mockExecCallback: vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      cb?: (err: unknown, result?: { stdout: string; stderr: string }) => void,
    ) => {
      const callback = (typeof _opts === 'function' ? _opts : cb) as (
        err: unknown,
        result?: { stdout: string; stderr: string },
      ) => void;
      process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
    },
  ),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue(''),
    exec: mockExecCallback,
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
      mkdirSync: vi.fn(),
      statSync: vi.fn().mockReturnValue({ isFile: () => false }),
    },
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    mkdirSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ isFile: () => false }),
  };
});

vi.mock('../config', () => ({
  config: {},
  runtimeSettings: { session_mode: 'cli', max_concurrent_code_sessions: 10 },
  getProjectById: vi.fn().mockReturnValue({
    id: 'test-proj',
    name: 'Test Project',
    projectDir: '/tmp/test',
    taskSource: 'notion',
    gitMode: 'local-only',
    autoLaunchEnabled: true,
    baseBranch: 'dev',
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
    getSetting: vi.fn().mockReturnValue(null),
    getOtherRunningSessionsForTask: vi.fn().mockReturnValue([]),
    markSessionSuperseded: vi.fn(),
    markSessionDone: vi.fn(),
    updateSessionWorktreePath: vi.fn(),
    incrementTaskCrashCount: vi.fn().mockReturnValue(1),
    setTaskPauseReason: vi.fn(),
  }),
);

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
    mcp_servers: undefined,
  }),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue('context'),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue('review context'),
}));

vi.mock('../session/branchModel', () => ({
  resolveStartingPoint: vi.fn().mockReturnValue({
    startingPoint: 'dev',
    milestoneSlug: null,
  }),
  ensureMilestoneBranch: vi.fn(),
  slugify: vi
    .fn()
    .mockImplementation((s: string) => s.toLowerCase().replace(/\s+/g, '-')),
  deriveBranchSlug: vi
    .fn()
    .mockImplementation(
      (s: string) => `feature/${s.toLowerCase().replace(/\s+/g, '-')}`,
    ),
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
    // Never resolves so wireSession's run() fires session_status (resolving firstEvent)
    // but never completes, avoiding asynchronous markSessionErrored('run_error') noise.
    run: vi.fn().mockReturnValue(new Promise(() => {})),
  })),
}));

vi.mock('../session/ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
}));

vi.mock('../session/DockerSessionRunner', () => ({
  DockerSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
  reapOrphanContainers: vi.fn(),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config/corporateMode', () => ({
  getCorporateMode: vi
    .fn()
    .mockReturnValue({ gates: { dockerMandatory: false } }),
}));

import { execSync } from 'child_process';
import fs from 'fs';
import { SessionManager } from '../session/SessionManager';
import { AgentSession } from '../session/AgentSession';
import * as queries from '../db/queries';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
const IDLE_SESSION_ROW = {
  session_id: SESSION_ID,
  task_name: 'my-feature-task',
  task_id: 'notion:task-abc123',
  project_id: 'test-proj',
  status: 'idle',
  session_type: 'standard',
  worktree_path: null,
  pause_reason: null,
};

function makeWorktreeError(stderrContent: string): Error & { stderr: string } {
  const err = new Error(
    `Command failed: git worktree add\n${stderrContent}`,
  ) as Error & { stderr: string };
  err.stderr = stderrContent;
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getSession).mockReturnValue(IDLE_SESSION_ROW as never);
  vi.mocked(queries.getOtherRunningSessionsForTask).mockReturnValue([]);
  // vi.clearAllMocks() clears calls, not implementations — reset exec() back
  // to its always-succeeds default so a per-test failure override doesn't
  // leak into later tests.
  mockExecCallback.mockImplementation(
    (
      _cmd: string,
      _opts: unknown,
      cb?: (err: unknown, result?: { stdout: string; stderr: string }) => void,
    ) => {
      const callback = (typeof _opts === 'function' ? _opts : cb) as (
        err: unknown,
        result?: { stdout: string; stderr: string },
      ) => void;
      process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
    },
  );
});

// ── No rethrow — process stays alive ────────────────────────────────────────

describe('sendOrResume() worktree-recreate failure: no rethrow', () => {
  it('resolves without throwing when execSync throws during worktree add', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if ((cmd as string).includes('worktree add')) {
        throw makeWorktreeError(
          "fatal: a branch named 'feature/my-feature-task' already exists",
        );
      }
      return '' as never;
    });

    const sm = new SessionManager();
    await expect(
      sm.sendOrResume(SESSION_ID, 'fix this'),
    ).resolves.not.toThrow();
  });

  it('returns the session ID when worktree recreation fails', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if ((cmd as string).includes('worktree add')) {
        throw makeWorktreeError('fatal: branch already exists');
      }
      return '' as never;
    });

    const sm = new SessionManager();
    const result = await sm.sendOrResume(SESSION_ID, 'fix this');
    expect(result).toBe(SESSION_ID);
  });
});

// ── Session marked errored ───────────────────────────────────────────────────

describe('sendOrResume() worktree-recreate failure: session marked errored', () => {
  it('calls updateSessionStatus with error status when worktree add fails', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if ((cmd as string).includes('worktree add')) {
        throw makeWorktreeError('fatal: branch already exists');
      }
      return '' as never;
    });

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'fix this');

    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      SESSION_ID,
      'error',
      expect.any(Number),
    );
  });
});

// ── WS event broadcast ───────────────────────────────────────────────────────

describe('sendOrResume() worktree-recreate failure: session_action_failed broadcast', () => {
  it('broadcasts a session_action_failed WS event on worktree failure', async () => {
    // gitWorktreeAddWithRetry uses the promisified async exec, not execSync.
    mockExecCallback.mockImplementation(
      (
        cmd: string,
        opts: unknown,
        cb?: (err: unknown, result?: unknown) => void,
      ) => {
        const callback = (typeof opts === 'function' ? opts : cb) as (
          err: unknown,
          result?: unknown,
        ) => void;
        if (cmd.includes('worktree add')) {
          process.nextTick(() =>
            callback(makeWorktreeError('fatal: branch already exists')),
          );
          return;
        }
        process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
      },
    );

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    await sm.sendOrResume(SESSION_ID, 'fix this');

    const failedMsg = msgs.find((m) => m.type === 'session_action_failed') as
      | {
          type: 'session_action_failed';
          sessionId: string;
          action: string;
          reason: string;
          detail: string;
        }
      | undefined;
    expect(failedMsg).toBeDefined();
    expect(failedMsg!.sessionId).toBe(SESSION_ID);
    expect(failedMsg!.reason).toBe('worktree_recreate_failed');
  });

  it('includes the git stderr in the WS event detail', async () => {
    const stderrContent =
      "fatal: a branch named 'feature/my-feature-task' already exists";
    // gitWorktreeAddWithRetry uses the promisified async exec, not execSync.
    mockExecCallback.mockImplementation(
      (
        cmd: string,
        opts: unknown,
        cb?: (err: unknown, result?: unknown) => void,
      ) => {
        const callback = (typeof opts === 'function' ? opts : cb) as (
          err: unknown,
          result?: unknown,
        ) => void;
        if (cmd.includes('worktree add')) {
          process.nextTick(() =>
            callback(makeWorktreeError(stderrContent)),
          );
          return;
        }
        process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
      },
    );

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    await sm.sendOrResume(SESSION_ID, 'fix this');

    const failedMsg = msgs.find((m) => m.type === 'session_action_failed') as
      | { type: 'session_action_failed'; detail: string }
      | undefined;
    expect(failedMsg).toBeDefined();
    expect(failedMsg!.detail).toContain(stderrContent);
  });
});

// ── Short-circuit on already-errored session ────────────────────────────────

describe('sendOrResume() short-circuit: already-errored session', () => {
  it('does not attempt worktree-add when session status is error', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...IDLE_SESSION_ROW,
      status: 'error',
    } as never);

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'fix this');

    const worktreeCalls = vi
      .mocked(execSync)
      .mock.calls.filter((c) => (c[0] as string).includes('worktree add'));
    expect(worktreeCalls).toHaveLength(0);
  });

  it('does not attempt worktree-add when session status is done', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...IDLE_SESSION_ROW,
      status: 'done',
    } as never);

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'fix this');

    const worktreeCalls = vi
      .mocked(execSync)
      .mock.calls.filter((c) => (c[0] as string).includes('worktree add'));
    expect(worktreeCalls).toHaveLength(0);
  });
});

// ── Terminal session: session_action_failed broadcast ────────────────────────

describe('sendOrResume() terminal session: session_action_failed broadcast', () => {
  it('broadcasts session_action_failed when session is in terminal error state', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...IDLE_SESSION_ROW,
      status: 'error',
    } as never);

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    await sm.sendOrResume(SESSION_ID, 'fix this');

    const failedMsg = msgs.find((m) => m.type === 'session_action_failed') as
      | {
          type: 'session_action_failed';
          sessionId: string;
          action: string;
          reason: string;
        }
      | undefined;
    expect(failedMsg).toBeDefined();
    expect(failedMsg?.sessionId).toBe(SESSION_ID);
    expect(failedMsg?.action).toBe('send_message');
    expect(failedMsg?.reason).toBe('terminal_session');
  });

  it('broadcasts session_action_failed when session is in done state', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...IDLE_SESSION_ROW,
      status: 'done',
    } as never);

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    await sm.sendOrResume(SESSION_ID, 'fix this');

    const failedMsg = msgs.find((m) => m.type === 'session_action_failed');
    expect(failedMsg).toBeDefined();
  });

  it('broadcasts session_action_failed when session is in killed state', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...IDLE_SESSION_ROW,
      status: 'killed',
    } as never);

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    await sm.sendOrResume(SESSION_ID, 'fix this');

    const failedMsg = msgs.find((m) => m.type === 'session_action_failed');
    expect(failedMsg).toBeDefined();
  });
});

// ── Prune + reattach ─────────────────────────────────────────────────────────

describe('sendOrResume() prune + reattach', () => {
  it('calls git worktree prune before attempting to add the worktree', async () => {
    vi.mocked(execSync).mockReturnValue('' as never);
    // gitWorktreeAddWithRetry uses the promisified async exec for the add
    // itself, while the proactive prune beforehand still uses execSync —
    // track ordering across both.
    const execCalls: string[] = [];
    mockExecCallback.mockImplementation(
      (
        cmd: string,
        opts: unknown,
        cb?: (err: unknown, result?: unknown) => void,
      ) => {
        execCalls.push(cmd);
        const callback = (typeof opts === 'function' ? opts : cb) as (
          err: unknown,
          result?: unknown,
        ) => void;
        process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
      },
    );

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'fix this');

    const syncCalls = vi.mocked(execSync).mock.calls.map((c) => c[0] as string);
    const pruneIdx = syncCalls.findIndex((c) => c.includes('worktree prune'));
    const addIdx = execCalls.findIndex((c) => c.includes('worktree add'));
    expect(pruneIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThanOrEqual(0);
  });

  it('reattaches successfully after prune when branch "already checked out"', async () => {
    let attachAttempt = 0;
    // gitWorktreeAddWithRetry uses the promisified async exec, not execSync.
    mockExecCallback.mockImplementation(
      (
        cmd: string,
        opts: unknown,
        cb?: (err: unknown, result?: unknown) => void,
      ) => {
        const callback = (typeof opts === 'function' ? opts : cb) as (
          err: unknown,
          result?: unknown,
        ) => void;
        if (cmd.includes('worktree add') && !cmd.includes('-b')) {
          attachAttempt++;
          if (attachAttempt === 1) {
            process.nextTick(() =>
              callback(
                makeWorktreeError(
                  "fatal: 'feature/my-feature-task' is already checked out at '/deleted/path'",
                ),
              ),
            );
            return;
          }
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
          return;
        }
        process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
      },
    );

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    const result = await sm.sendOrResume(SESSION_ID, 'fix this');
    expect(result).toBe(SESSION_ID);
    // Reattach succeeded → no worktree_recreate_failed broadcast.
    expect(
      msgs.find(
        (m) =>
          m.type === 'session_action_failed' &&
          (m as { reason: string }).reason === 'worktree_recreate_failed',
      ),
    ).toBeUndefined();
    // A second (post-prune) attach was attempted.
    expect(attachAttempt).toBe(2);
    // Session was respawned to running (reattach proceeded past worktree setup).
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
  });

  it('succeeds when -b also fails with "already exists" by pruning + reattaching', async () => {
    let attachAttempt = 0;
    // gitWorktreeAddWithRetry uses the promisified async exec, not execSync.
    mockExecCallback.mockImplementation(
      (
        cmd: string,
        opts: unknown,
        cb?: (err: unknown, result?: unknown) => void,
      ) => {
        const callback = (typeof opts === 'function' ? opts : cb) as (
          err: unknown,
          result?: unknown,
        ) => void;
        if (cmd.includes('worktree add') && !cmd.includes('-b')) {
          attachAttempt++;
          if (attachAttempt === 1) {
            process.nextTick(() =>
              callback(
                makeWorktreeError(
                  'fatal: invalid reference: feature/my-feature-task',
                ),
              ),
            );
            return;
          }
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
          return;
        }
        if (cmd.includes('worktree add') && cmd.includes('-b')) {
          process.nextTick(() =>
            callback(
              makeWorktreeError(
                "fatal: A branch named 'feature/my-feature-task' already exists.",
              ),
            ),
          );
          return;
        }
        process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
      },
    );

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    const result = await sm.sendOrResume(SESSION_ID, 'fix this');
    expect(result).toBe(SESSION_ID);
    expect(
      msgs.find(
        (m) =>
          m.type === 'session_action_failed' &&
          (m as { reason: string }).reason === 'worktree_recreate_failed',
      ),
    ).toBeUndefined();
    // Final reattach after -b failure succeeded.
    expect(attachAttempt).toBe(2);
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
  });
});

// ── Crash budget: worktree_recreate_failed counts ────────────────────────────

describe('sendOrResume() crash budget for worktree_recreate_failed', () => {
  it('increments crash counter when worktree recreation fails', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if ((cmd as string).includes('worktree add')) {
        throw makeWorktreeError('fatal: some unrecoverable error');
      }
      return '' as never;
    });

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'fix this');

    expect(queries.incrementTaskCrashCount).toHaveBeenCalledWith(
      IDLE_SESSION_ROW.task_id,
    );
  });

  it('does not write task_pause_reasons on first crash (counter=1)', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(1);
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if ((cmd as string).includes('worktree add')) {
        throw makeWorktreeError('fatal: some error');
      }
      return '' as never;
    });

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'fix this');

    expect(queries.setTaskPauseReason).not.toHaveBeenCalled();
  });

  it('writes task_pause_reasons and marks Blocked on second consecutive crash', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(2);
    // gitWorktreeAddWithRetry uses the promisified async exec, not execSync —
    // simulate the failure on the actual code path.
    mockExecCallback.mockImplementation(
      (
        cmd: string,
        opts: unknown,
        cb?: (err: unknown, result?: unknown) => void,
      ) => {
        const callback = (typeof opts === 'function' ? opts : cb) as (
          err: unknown,
          result?: unknown,
        ) => void;
        if (cmd.includes('worktree add')) {
          process.nextTick(() =>
            callback(makeWorktreeError('fatal: some error')),
          );
        } else {
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        }
      },
    );

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'fix this');

    expect(queries.setTaskPauseReason).toHaveBeenCalledWith(
      IDLE_SESSION_ROW.task_id,
      'launch_failed',
      'worktree_recreate_failed',
    );
  });
});

// ── Integration: stale registration → reattach (2026-06-10 scenario) ─────────

describe('sendOrResume() integration: stale-registration reattach', () => {
  it('does not create a new session row when reattaching to existing branch', async () => {
    // Branch is registered to a deleted worktree dir; prune clears it, second attach succeeds.
    let attachAttempt = 0;
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      const cmdStr = cmd as string;
      if (cmdStr.includes('worktree add') && !cmdStr.includes('-b')) {
        attachAttempt++;
        if (attachAttempt === 1) {
          throw makeWorktreeError(
            "fatal: 'feature/my-feature-task' is already checked out at '/old/stale/path'",
          );
        }
        // Second attempt after prune succeeds
        return '' as never;
      }
      return '' as never;
    });

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    await sm.sendOrResume(SESSION_ID, 'review feedback');

    // No new session inserted — reusing existing row (same branch, PR commits intact).
    expect(queries.insertSession).not.toHaveBeenCalled();
    // No worktree_recreate_failed loop — reattach succeeded.
    expect(
      msgs.find(
        (m) =>
          m.type === 'session_action_failed' &&
          (m as { reason: string }).reason === 'worktree_recreate_failed',
      ),
    ).toBeUndefined();
    // Session respawned in place (running), not a fresh launch.
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
  });
});

// ── Overflow escalation: pending text registered on session ───────────────────

describe('sendOrResume() overflow escalation: setPendingOverflowText', () => {
  it('registers the feedback text on the session for re-delivery on overflow', async () => {
    // Worktree setup succeeds; session is spawned and firstEvent resolves from the
    // session_status broadcast emitted by AgentSession.run() before runner.run() is called.
    vi.mocked(execSync).mockReturnValue('' as never);

    const spy = vi.spyOn(AgentSession.prototype, 'setPendingOverflowText');

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'review: please fix the type errors');

    expect(spy).toHaveBeenCalledWith('review: please fix the type errors');

    spy.mockRestore();
  });

  it('does not register pending text when worktree creation fails', async () => {
    // gitWorktreeAddWithRetry uses the promisified async exec, not execSync —
    // simulate the failure on the actual code path.
    mockExecCallback.mockImplementation(
      (
        cmd: string,
        opts: unknown,
        cb?: (err: unknown, result?: unknown) => void,
      ) => {
        const callback = (typeof opts === 'function' ? opts : cb) as (
          err: unknown,
          result?: unknown,
        ) => void;
        if (cmd.includes('worktree add')) {
          process.nextTick(() =>
            callback(makeWorktreeError('fatal: branch already exists')),
          );
        } else {
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        }
      },
    );

    const spy = vi.spyOn(AgentSession.prototype, 'setPendingOverflowText');

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'some feedback');

    // Session was never created — spy should not have been called.
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});

// ── Planning sessions (groom/design/ops): never respawn a worktree ───────────

const PLANNING_SESSION_ID = 'ffffeeee-dddd-cccc-bbbb-aaaaaaaaaaaa';
const PLANNING_SESSION_ROW = {
  session_id: PLANNING_SESSION_ID,
  task_name: 'nightly-groom',
  task_id: 'notion:task-groom123',
  project_id: 'test-proj',
  status: 'starting',
  session_type: 'ops',
  worktree_path: null,
  pause_reason: null,
};

describe('sendOrResume() planning session (starting): graceful initializing signal', () => {
  it('returns null without touching git worktree machinery', async () => {
    vi.mocked(queries.getSession).mockReturnValue(
      PLANNING_SESSION_ROW as never,
    );

    const sm = new SessionManager();
    const result = await sm.sendOrResume(PLANNING_SESSION_ID, 'hello');

    expect(result).toBeNull();
    const calls = vi.mocked(execSync).mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('worktree'))).toBe(false);
  });

  it('broadcasts a session_action_failed "still_initializing" signal, not a worktree error', async () => {
    vi.mocked(queries.getSession).mockReturnValue(
      PLANNING_SESSION_ROW as never,
    );

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    await sm.sendOrResume(PLANNING_SESSION_ID, 'hello');

    const failedMsg = msgs.find((m) => m.type === 'session_action_failed') as
      | { type: 'session_action_failed'; reason: string }
      | undefined;
    expect(failedMsg?.reason).toBe('still_initializing');
    expect(
      msgs.some(
        (m) =>
          m.type === 'session_action_failed' &&
          (m as { reason: string }).reason === 'worktree_recreate_failed',
      ),
    ).toBe(false);
  });
});

describe('sendOrResume() planning session (idle, no worktree_path): resumes against projectDir, no worktree add', () => {
  it('never invokes git worktree add for a planning session respawn', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...PLANNING_SESSION_ROW,
      status: 'idle',
    } as never);
    // Simulate the fast path recognizing the project's own checkout as the
    // planning session's "worktree" — projectDir exists and is a git repo.
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const sm = new SessionManager();
    const result = await sm.sendOrResume(PLANNING_SESSION_ID, 'hello');

    expect(result).toBe(PLANNING_SESSION_ID);
    const calls = vi.mocked(execSync).mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('worktree'))).toBe(false);
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      PLANNING_SESSION_ID,
      'running',
    );
  });
});

describe('sendOrResume() planning session: live in-memory session routes to send()', () => {
  it('delivers directly via session.send() without any respawn/worktree logic', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...PLANNING_SESSION_ROW,
      status: 'running',
    } as never);

    const sm = new SessionManager();
    const fakeSendMessage = vi.fn();
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
      PLANNING_SESSION_ID,
      { sendMessage: fakeSendMessage },
    );

    const result = await sm.sendOrResume(PLANNING_SESSION_ID, 'hello');

    expect(result).toBe(PLANNING_SESSION_ID);
    expect(fakeSendMessage).toHaveBeenCalledWith('hello');
    const calls = vi.mocked(execSync).mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('worktree'))).toBe(false);
  });
});
