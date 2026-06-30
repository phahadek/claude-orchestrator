/**
 * AgentSession passes a concise, one-line reason to markSessionErrored on each
 * error/killed exit path (non-zero exit + code, killed, user kill, API-error snippet),
 * which SessionManager.markSessionErrored persists as last_error_detail. The persistence
 * half is asserted in markSessionErrored.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// ── Shared child_process mock (spawn for AgentSession, exec for SessionManager) ──

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

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc.proc),
  execFile: vi.fn(),
  execSync: vi.fn(() => 'feature/task\n'),
  exec: vi.fn((_cmd: string, _opts: unknown, cb?: unknown) => {
    const callback = (typeof _opts === 'function' ? _opts : cb) as
      | ((e: null, r: { stdout: string; stderr: string }) => void)
      | undefined;
    if (callback)
      process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
  }),
}));

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
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  setSessionPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  getSession: vi.fn(() => null),
  getSessionTags: vi.fn(() => []),
  setSessionTags: vi.fn(),
  resetTaskCrashCount: vi.fn(),
  incrementTaskCrashCount: vi.fn(() => 1),
  setTaskPauseReason: vi.fn(),
  setSessionLastErrorDetail: vi.fn(),
  ackPendingComments: vi.fn(),
  listUndeliveredInboxItems: vi.fn(() => []),
  markInboxItemsDelivered: vi.fn(),
}));

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  return {
    ...actual,
    ALLOWED_TOOLS: [],
    GITHUB_REPO: 'owner/repo',
    config: { maxConcurrentCodeSessions: 10 },
    runtimeSettings: { sessionMode: 'cli', session_mode: 'cli' },
    normalizePath: (p: string) => p,
    getProjectById: vi.fn(() => ({
      id: 'proj-1',
      name: 'Test',
      baseBranch: 'dev',
    })),
  };
});

vi.mock('../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(async () => 'feature/my-task'),
  hasNonEmptyDiff: vi.fn(async () => false),
}));
vi.mock('../github/NoOpInvestigator', () => ({
  NoOpInvestigator: vi
    .fn()
    .mockImplementation(() => ({ investigate: vi.fn(async () => {}) })),
}));
vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
  countPushFailureEvents: vi.fn(() => 0),
}));
vi.mock('../session/sessionRecovery', () => ({
  recoverSession: vi.fn(async () => {}),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { AgentSession } from '../session/AgentSession';
import { getEventsBySession } from '../db/queries';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { ISessionManager } from '../session/SessionAuditor';

function fakeTaskBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    attachPR: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    fetchTaskPage: vi.fn(async () => ''),
  };
}

function makeSession(sm: ISessionManager) {
  return new AgentSession(
    'sess-err',
    'https://notion.so/task',
    'https://notion.so/ctx',
    fakeTaskBackend(),
    '/tmp/worktree',
    'notion:task-abc',
    undefined,
    undefined,
    'standard',
    sm,
  );
}

// ── AgentSession passes a concise detail to markSessionErrored ─────────────────

describe('AgentSession error paths pass a concise detail to markSessionErrored', () => {
  let sm: {
    markSessionErrored: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    isAlive: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
    sm = {
      markSessionErrored: vi.fn(),
      send: vi.fn(),
      isAlive: vi.fn(() => false),
    };
  });

  it('non-zero exit records the exit code', async () => {
    const session = makeSession(sm as unknown as ISessionManager);
    const runPromise = session.run();
    await new Promise((r) => setTimeout(r, 10));
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 50));
    mockProc.proc.emit('exit', 1);
    await runPromise;

    expect(sm.markSessionErrored).toHaveBeenCalledWith(
      'sess-err',
      'error',
      'runner_non_zero',
      expect.stringContaining('code 1'),
    );
  });

  it('non-zero exit appends the last error-event snippet', async () => {
    vi.mocked(getEventsBySession).mockReturnValue([
      {
        id: 1,
        session_id: 'sess-err',
        event_type: 'system',
        payload: JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid API key' },
        }),
        created_at: 0,
      } as never,
    ]);
    const session = makeSession(sm as unknown as ISessionManager);
    const runPromise = session.run();
    await new Promise((r) => setTimeout(r, 10));
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 50));
    mockProc.proc.emit('exit', 2);
    await runPromise;

    expect(sm.markSessionErrored).toHaveBeenCalledWith(
      'sess-err',
      'error',
      'runner_non_zero',
      expect.stringMatching(/code 2.*last error:/),
    );
  });

  it('null exit code records "process killed unexpectedly"', async () => {
    const session = makeSession(sm as unknown as ISessionManager);
    const runPromise = session.run();
    await new Promise((r) => setTimeout(r, 10));
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 50));
    mockProc.proc.emit('exit', null);
    await runPromise;

    expect(sm.markSessionErrored).toHaveBeenCalledWith(
      'sess-err',
      'killed',
      'runner_killed_unexpected',
      'process killed unexpectedly',
    );
  });

  it('kill() records "killed by user request"', async () => {
    const session = makeSession(sm as unknown as ISessionManager);
    const runPromise = session.run();
    await new Promise((r) => setTimeout(r, 10));

    const killPromise = session.kill();
    await new Promise((r) => setTimeout(r, 10));
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 50));
    mockProc.proc.emit('exit', null);
    await Promise.all([runPromise, killPromise]);

    expect(sm.markSessionErrored).toHaveBeenCalledWith(
      'sess-err',
      'killed',
      'user_kill',
      'killed by user request',
    );
  });
});
