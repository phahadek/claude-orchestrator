/**
 * A finished CLI subprocess (one that already emitted its terminal `result`
 * event) can be force-killed by CliSessionRunner's new post-result grace
 * timeout — or by the pre-existing escalation watchdog / StuckSessionMonitor
 * hard-stop — without ever reaching `exitCode === 0`. run()'s exit-handling
 * loop must route that case through handleCleanExit() (the designed park),
 * not the killed/runner_killed_unexpected error path, since the CLI's own
 * work was already done. A null exit with no successful result on record
 * (a genuinely hung/crashed process) must still fall through to the
 * existing classification unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return {
    ...actual,
    ALLOWED_TOOLS: [],
    GITHUB_REPO: 'owner/repo',
    config: {},
    runtimeSettings: {
      sessionMode: 'cli',
      session_mode: 'cli',
      max_concurrent_code_sessions: 10,
    },
    normalizePath: (p: string) => p,
    getProjectById: vi.fn(() => ({
      id: 'proj-1',
      name: 'Test',
      baseBranch: 'dev',
    })),
  };
});

vi.mock('../../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(async () => 'feature/my-task'),
  hasNonEmptyDiff: vi.fn(async () => false),
}));
vi.mock('../../github/NoOpInvestigator', () => ({
  NoOpInvestigator: vi
    .fn()
    .mockImplementation(() => ({ investigate: vi.fn(async () => {}) })),
}));
vi.mock('../../audit/AuditLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../audit/AuditLog')>();
  return { ...actual };
});
vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn(async () => {}),
}));

import { db } from '../../db/db';
import { insertSession, upsertSessionEvent } from '../../db/queries';
import { AgentSession } from '../AgentSession';
import type { ISessionRunner } from '../SessionRunner';
import type { ISessionManager } from '../SessionAuditor';
import type { TaskBackend } from '../../tasks/TaskBackend';

function fakeTaskBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    attachPR: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    fetchTaskPage: vi.fn(async () => ''),
  } as unknown as TaskBackend;
}

/**
 * Mimics CliSessionRunner's run() contract: resolves whatever exit code the
 * test drives it to, regardless of how that code was reached (a clean OS
 * exit, or a forced kill following a grace timeout).
 */
function makeFakeRunner() {
  let resolveRun!: (code: number | null) => void;
  const runPromise = new Promise<number | null>((resolve) => {
    resolveRun = resolve;
  });
  const runner: ISessionRunner = {
    run: vi.fn(() => runPromise),
    sendMessage: vi.fn(),
    endSession: vi.fn(async () => false),
    kill: vi.fn(async () => {
      resolveRun(null);
    }),
    pause: vi.fn(async () => {}),
    hasSpawnError: false,
  };
  return { runner, resolveRun };
}

function makeSessionManager() {
  return {
    markSessionErrored: vi.fn(),
    send: vi.fn(),
    isAlive: vi.fn(() => false),
  };
}

function seedSession(sessionId: string): void {
  insertSession({
    session_id: sessionId,
    task_id: 'task-1',
    task_url: 'https://notion.so/task-1',
    project_context_url: 'https://notion.so/ctx',
    status: 'running',
    started_at: Date.now(),
    session_type: 'groom',
  });
}

function makeSession(
  sessionId: string,
  sm: ReturnType<typeof makeSessionManager>,
  runner: ISessionRunner,
): AgentSession {
  return new AgentSession(
    sessionId,
    'https://notion.so/task',
    'https://notion.so/ctx',
    fakeTaskBackend(),
    '/tmp/worktree',
    'notion:task-abc',
    undefined,
    undefined,
    'groom',
    sm as unknown as ISessionManager,
    undefined,
    [],
    undefined,
    runner,
  );
}

beforeEach(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_events').run();
  vi.clearAllMocks();
});

describe('AgentSession — null exit after a successful result event', () => {
  it('a force-killed subprocess that already emitted a successful result is routed through handleCleanExit, not killed/runner_killed_unexpected', async () => {
    const sessionId = 'sess-force-killed-after-result';
    seedSession(sessionId);
    upsertSessionEvent({
      session_id: sessionId,
      event_type: 'system',
      payload: JSON.stringify({ type: 'result', is_error: false }),
      timestamp: Date.now(),
    });

    const { runner, resolveRun } = makeFakeRunner();
    const sm = makeSessionManager();
    const session = makeSession(sessionId, sm, runner);

    const runPromise = session.run();
    resolveRun(null);
    await runPromise;

    expect(sm.markSessionErrored).not.toHaveBeenCalled();
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get(sessionId) as { status: string } | undefined;
    expect(row?.status).not.toBe('killed');
    expect(row?.status).not.toBe('error');
  });

  it('a CliSessionRunner post-result grace-kill (reported as null per its own contract) routes into handleCleanExit, not the delivery-race resume or runner_non_zero', async () => {
    const sessionId = 'sess-grace-killed-after-result';
    seedSession(sessionId);
    upsertSessionEvent({
      session_id: sessionId,
      event_type: 'system',
      payload: JSON.stringify({ type: 'result', is_error: false }),
      timestamp: Date.now(),
    });

    // CliSessionRunner's contract: its own post-result grace-timer kill
    // reports null (not the child's raw 143 exit code) so this gate can
    // fire. The runner mock reflects that contract directly.
    const { runner, resolveRun } = makeFakeRunner();
    const sm = makeSessionManager();
    const session = makeSession(sessionId, sm, runner);

    const runPromise = session.run();
    resolveRun(null);
    await runPromise;

    expect(sm.markSessionErrored).not.toHaveBeenCalled();
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get(sessionId) as { status: string } | undefined;
    expect(row?.status).toBe('idle');
  });

  it('a null exit with no successful result on record is still classified as runner_killed_unexpected', async () => {
    const sessionId = 'sess-null-exit-no-result';
    seedSession(sessionId);
    // No result event recorded — this process never got that far.

    const { runner, resolveRun } = makeFakeRunner();
    const sm = makeSessionManager();
    const session = makeSession(sessionId, sm, runner);

    const runPromise = session.run();
    resolveRun(null);
    await runPromise;

    expect(sm.markSessionErrored).toHaveBeenCalledWith(
      sessionId,
      'killed',
      'runner_killed_unexpected',
      expect.any(String),
    );
  });
});
