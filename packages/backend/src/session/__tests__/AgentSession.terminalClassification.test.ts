/**
 * A groom/design session that finishes planning cleanly (e.g.
 * planning_approved) is concluded by PlanningOrchestrator.markTerminal
 * closing stdin and, if the CLI doesn't honor that within the graceful
 * window, escalating to a forceful kill. Before this fix, AgentSession.run()'s
 * own exit-code classification couldn't tell that forced kill apart from an
 * unexplained one and recorded it as runner_killed_unexpected/session_errored
 * — contradicting the terminal_completion_reason the session had just
 * written for the same conclusion. AgentSession.endSession() now reads that
 * reason and, when present, sets hasEnded synchronously (before the runner
 * ever sends a kill signal) so the run() loop's own classification is
 * skipped rather than clobbering a clean 'done' with 'killed'/'error'.
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
  isSessionStreamQuiet: vi.fn(() => true),
}));
vi.mock('../../audit/AuditLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../audit/AuditLog')>();
  return { ...actual };
});
vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn(async () => {}),
}));

import { db } from '../../db/db';
import {
  insertSession,
  getSession,
  setSessionTerminalCompletionReason,
} from '../../db/queries';
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
 * Mimics CliSessionRunner's contract: run() resolves with the eventual exit
 * code, endSession()/kill() resolve it with null (the process was killed)
 * — same as a real forced escalation.
 */
function makeFakeRunner() {
  let resolveRun!: (code: number | null) => void;
  const runPromise = new Promise<number | null>((resolve) => {
    resolveRun = resolve;
  });
  const endSession = vi.fn(async (_concludedCleanly?: boolean) => {
    resolveRun(null);
    return true; // escalation was required
  });
  const kill = vi.fn(async () => {
    resolveRun(null);
  });
  const runner: ISessionRunner = {
    run: vi.fn(() => runPromise),
    sendMessage: vi.fn(),
    endSession,
    kill,
    pause: kill,
    hasSpawnError: false,
  };
  return { runner, endSession, kill };
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

function auditRows(sessionId: string, eventType: string) {
  return db
    .prepare(
      `SELECT payload FROM audit_log WHERE actor_id = ? AND event_type = ?`,
    )
    .all(sessionId, eventType) as { payload: string }[];
}

beforeEach(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  vi.clearAllMocks();
});

describe('AgentSession terminal-kill classification', () => {
  it('a forced kill following a recorded terminal completion reason is not classified as session_errored', async () => {
    const sessionId = 'sess-clean-conclusion';
    seedSession(sessionId);
    // Mirrors PlanningOrchestrator.markTerminal: record the terminal reason,
    // then drive the session to end — same ordering, same two calls.
    setSessionTerminalCompletionReason(sessionId, 'planning_approved');

    const { runner, endSession } = makeFakeRunner();
    const sm = makeSessionManager();
    const session = makeSession(sessionId, sm, runner);

    const runPromise = session.run();
    await session.endSession();
    await runPromise;

    expect(endSession).toHaveBeenCalledWith(true);
    // No runner_killed_unexpected/session_errored classification.
    expect(sm.markSessionErrored).not.toHaveBeenCalled();

    // The row's terminal_completion_reason and the audit trail agree: both
    // describe a clean conclusion, not a fault.
    const row = getSession(sessionId);
    expect(row?.terminal_completion_reason).toBe('planning_approved');
    expect(auditRows(sessionId, 'session_errored')).toHaveLength(0);
    const escalations = auditRows(sessionId, 'session_teardown_escalated');
    expect(escalations).toHaveLength(1);
    const payload = JSON.parse(escalations[0].payload);
    expect(payload).toMatchObject({
      concludedCleanly: true,
      terminalCompletionReason: 'planning_approved',
    });
  });

  it('a forced kill with no recorded terminal completion reason is still surfaced to the operator as runner_killed_unexpected, not markSessionErrored', async () => {
    const sessionId = 'sess-no-reason';
    seedSession(sessionId);
    // No setSessionTerminalCompletionReason call — this session never
    // recorded why it's ending.

    const { runner, endSession } = makeFakeRunner();
    const sm = makeSessionManager();
    const session = makeSession(sessionId, sm, runner);

    const runPromise = session.run();
    await session.endSession();
    await runPromise;

    expect(endSession).toHaveBeenCalledWith(false);
    expect(sm.markSessionErrored).not.toHaveBeenCalled();
    const row = getSession(sessionId);
    expect(row?.archived).toBe(1);
    expect(row?.pause_reason).toBe('runner_killed_unexpected');
    expect(row?.last_error_detail).toBe('process killed unexpectedly');
  });

  it('an operator-initiated kill remains classified as user_kill regardless of a recorded terminal completion reason', async () => {
    const sessionId = 'sess-user-kill';
    seedSession(sessionId);
    // Even with a terminal reason on record, an explicit operator kill()
    // must still resolve to user_kill — narrowing the escalation path must
    // not leak into the unrelated abort path.
    setSessionTerminalCompletionReason(sessionId, 'planning_approved');

    const { runner } = makeFakeRunner();
    const sm = makeSessionManager();
    const session = makeSession(sessionId, sm, runner);

    const runPromise = session.run();
    const killPromise = session.kill();
    await Promise.all([runPromise, killPromise]);

    expect(sm.markSessionErrored).toHaveBeenCalledWith(
      sessionId,
      'killed',
      'user_kill',
      'killed by user request',
    );
  });

  it('the forced kill still occurs after the graceful window in both the clean-conclusion and unexplained cases', async () => {
    for (const reason of ['planning_approved', undefined] as const) {
      const sessionId = `sess-reap-${reason ?? 'none'}`;
      seedSession(sessionId);
      if (reason) setSessionTerminalCompletionReason(sessionId, reason);

      const { runner, endSession, kill } = makeFakeRunner();
      const sm = makeSessionManager();
      const session = makeSession(sessionId, sm, runner);

      const runPromise = session.run();
      await session.endSession();
      await runPromise;

      // The runner's escalation path actually ran — the subprocess was
      // reaped either way, independent of how the outcome is classified.
      expect(endSession).toHaveBeenCalledTimes(1);
      expect(kill).not.toHaveBeenCalled(); // escalation happens inside runner.endSession itself
    }
  });
});
