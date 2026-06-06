/**
 * Tests for graceful shutdown — AgentSession.gracefulPause() and
 * SessionManager.shutdownAll() behaviour.
 *
 * Verifies:
 * 1. gracefulPause() SIGTERMs the CLI runner without touching DB status.
 * 2. SessionManager.shutdownAll() calls gracefulPause (not kill) on every
 *    live session.
 * 3. Sessions paused via gracefulPause remain status='running' in the DB.
 * 4. Integration: shutdownAll → new SessionManager → resumeOrphanSessions
 *    picks up the paused session.
 * 5. User-initiated kill() semantics are unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import fs from 'fs';

// ── Mock child_process ────────────────────────────────────────────────────────

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdinChunks: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(chunk.toString());
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 12345,
    exitCode: null as number | null,
  });
  return { proc, stdinChunks, stdout, stderr };
}

let mockProc: ReturnType<typeof createMockProc>;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc.proc),
  execSync: vi.fn(() => ''),
  execFile: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => ''),
      writeFileSync: vi.fn(),
      statSync: vi.fn(() => ({ isFile: () => true })),
    },
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    statSync: vi.fn(() => ({ isFile: () => true })),
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

const projectFixture = {
  id: 'test-project',
  name: 'Test Project',
  projectDir: '/fake/project',
  contextUrl: 'https://notion.so/ctx',
  boardId: 'board-1',
  githubRepo: 'owner/repo',
  taskSource: 'notion' as const,
};

vi.mock('../config', () => ({
  AUTO_REVIEW_ENABLED: false,
  ALLOWED_TOOLS: [],
  BASH_MAX_OUTPUT_LENGTH: 50000,
  BASH_DEFAULT_TIMEOUT_MS: 120000,
  config: {
    claudePath: '/fake/claude',
    maxConcurrentCodeSessions: 20,
    projectDir: '/fake/project',
  },
  getProjectById: vi.fn((id: string) =>
    id === 'test-project' ? projectFixture : undefined,
  ),
  getAllProjects: vi.fn(() => [projectFixture]),
  normalizePath: (p: string) => p,
  runtimeSettings: {
    session_mode: 'cli',
    code_session_model: '',
    review_session_model: '',
    max_concurrent_code_sessions: 20,
    auto_review_concurrency: 20,
  },
}));

vi.mock('../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn(() => ({
    allowedTools: [],
    prGate: { typeCheck: '', build: '' },
    bootstrapScript: '',
    bashRules: [],
  })),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn(() => ''),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn(() => ''),
}));

const fakeTaskBackend = {
  fetchTaskPage: vi.fn(async () => ''),
  fetchReadyTasks: vi.fn(async () => []),
  updateStatus: vi.fn(async () => {}),
  attachPR: vi.fn(async () => {}),
};

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => fakeTaskBackend),
}));

vi.mock('../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn(() => 'Running'),
}));

vi.mock('../github/NoOpInvestigator', () => ({
  NoOpInvestigator: vi.fn().mockImplementation(() => ({
    investigate: vi.fn(async () => {}),
  })),
}));

vi.mock('../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(async () => 'feature/some-task'),
  hasNonEmptyDiff: vi.fn(async () => false),
}));

vi.mock('../db/queries', () => ({
  getSessionsByStatus: vi.fn(() => []),
  getSession: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  getPRByNotionTaskId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getStuckResultSessionRows: vi.fn(() => []),
  insertSession: vi.fn(),
  insertEvent: vi.fn(),
  upsertSessionEvent: vi.fn(() => 1),
  upsertPullRequest: vi.fn(),
  insertPermissionDenial: vi.fn(),
  incrementTokens: vi.fn(),
  insertSessionAudit: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  getProjectRowById: vi.fn(() => null),
  insertLocalBranch: vi.fn(),
  getSetting: vi.fn(() => null),
  hasActiveSessionForTask: vi.fn(() => false),
  getRules: vi.fn(() => []),
}));

import { spawn, execSync } from 'child_process';
import { AgentSession } from '../session/AgentSession';
import { SessionManager } from '../session/SessionManager';
import * as queries from '../db/queries';
import type { ServerMessage } from '../ws/types';
import type { Session } from '../db/types';

function makeRunningSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'session-uuid-default',
    task_id: 'notion-task-id',
    task_url: 'https://notion.so/task',
    project_context_url: 'https://notion.so/ctx',
    project_id: 'test-project',
    status: 'running',
    started_at: 1_000_000,
    ended_at: null,
    pr_url: null,
    worktree_path: '/fake/project/.claude/worktrees/session-uuid-default',
    archived: 0,
    favorited: 0,
    session_type: 'standard',
    note: null,
    tags: null,
    model: null,
    task_name: 'fixture-task',
    ...overrides,
  } as Session;
}

beforeEach(() => {
  mockProc = createMockProc();
  vi.clearAllMocks();
  vi.mocked(execSync).mockReturnValue('');
  vi.mocked(fs.existsSync).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1. AgentSession.gracefulPause() leaves DB status untouched ───────────────

describe('AgentSession.gracefulPause()', () => {
  it('terminates the CLI runner without calling updateSessionStatus', async () => {
    const session = new AgentSession(
      'pause-session-1',
      'https://notion.so/task',
      'https://notion.so/ctx',
      undefined,
      '/fake/worktree',
      'task-id-1',
    );

    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    const runPromise = session.run();

    // Drain microtasks so the runner spawns the process.
    await new Promise((r) => setImmediate(r));

    // Call gracefulPause while the session is running.
    const pausePromise = session.gracefulPause();

    // Simulate the process exiting (as it would after receiving SIGTERM).
    mockProc.proc.emit('exit', null);
    mockProc.stdout.push(null);

    await pausePromise;
    await runPromise;

    // Status must NOT have been updated to 'killed' or anything else — it
    // should remain 'running' so resumeOrphanSessions picks it up.
    const killedCalls = vi
      .mocked(queries.updateSessionStatus)
      .mock.calls.filter(
        ([, status]) => status === 'killed' || status === 'error',
      );
    expect(killedCalls).toHaveLength(0);

    // No session_ended message must have been broadcast.
    const endedMessages = messages.filter((m) => m.type === 'session_ended');
    expect(endedMessages).toHaveLength(0);
  });

  it('is idempotent — calling gracefulPause twice does not double-update status', async () => {
    const session = new AgentSession(
      'pause-session-2',
      'https://notion.so/task',
      'https://notion.so/ctx',
      undefined,
      '/fake/worktree',
      'task-id-2',
    );

    session.on('message', () => {});
    const runPromise = session.run();
    await new Promise((r) => setImmediate(r));

    const p1 = session.gracefulPause();
    const p2 = session.gracefulPause(); // second call should be a no-op

    mockProc.proc.emit('exit', null);
    mockProc.stdout.push(null);

    await Promise.all([p1, p2]);
    await runPromise;

    const killedCalls = vi
      .mocked(queries.updateSessionStatus)
      .mock.calls.filter(
        ([, status]) => status === 'killed' || status === 'error',
      );
    expect(killedCalls).toHaveLength(0);
  });

  it('does not interfere with user-initiated kill() semantics', async () => {
    const session = new AgentSession(
      'kill-session-1',
      'https://notion.so/task',
      'https://notion.so/ctx',
      undefined,
      '/fake/worktree',
      'task-id-3',
    );

    session.on('message', () => {});
    const runPromise = session.run();
    await new Promise((r) => setImmediate(r));

    const killPromise = session.kill();
    mockProc.proc.emit('exit', null);
    mockProc.stdout.push(null);

    await killPromise;
    await runPromise;

    // kill() MUST update status to 'killed'.
    expect(vi.mocked(queries.updateSessionStatus)).toHaveBeenCalledWith(
      'kill-session-1',
      'killed',
      expect.any(Number),
    );
  });
});

// ── 2. SessionManager.shutdownAll() uses gracefulPause ───────────────────────

describe('SessionManager.shutdownAll()', () => {
  it('pauses all live sessions without marking them killed in the DB', async () => {
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([]);

    const sm = new SessionManager();

    // Manually start a session via resumeOrphanSessions so it ends up in the
    // live sessions map. Simpler than going through sm.start() (which is async
    // and requires a lot of setup).
    const orphan = makeRunningSession({ session_id: 'orphan-for-shutdown' });
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([orphan]);
    vi.mocked(execSync).mockReturnValue('session/orphan-for-shutdown');

    await sm.resumeOrphanSessions();
    expect(sm.isAlive('orphan-for-shutdown')).toBe(true);

    vi.clearAllMocks(); // reset call counts before the actual assertion

    const shutdownPromise = sm.shutdownAll();

    // Simulate the process exiting gracefully after SIGTERM.
    mockProc.proc.emit('exit', null);
    mockProc.stdout.push(null);

    await shutdownPromise;

    // updateSessionStatus must NOT have been called with 'killed' or 'error'.
    const badCalls = vi
      .mocked(queries.updateSessionStatus)
      .mock.calls.filter(
        ([, status]) => status === 'killed' || status === 'error',
      );
    expect(badCalls).toHaveLength(0);
  });
});

// ── 3. Integration: shutdown → restart → resumeOrphanSessions ────────────────

describe('graceful shutdown integration: paused sessions resume on next boot', () => {
  it('session paused by shutdownAll is picked up by resumeOrphanSessions on next boot', async () => {
    // --- First boot: start a session, then shut it down gracefully ---
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([]);

    const sm1 = new SessionManager();
    const orphan = makeRunningSession({
      session_id: 'integration-session',
      worktree_path: '/fake/project/.claude/worktrees/integration-session',
    });
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([orphan]);
    vi.mocked(execSync).mockReturnValue('session/integration-session');

    await sm1.resumeOrphanSessions();
    expect(sm1.isAlive('integration-session')).toBe(true);

    // Graceful shutdown
    const shutdownPromise = sm1.shutdownAll();
    mockProc.proc.emit('exit', null);
    mockProc.stdout.push(null);
    await shutdownPromise;

    // DB status must still be 'running' (not 'killed') after shutdown.
    const killedCalls = vi
      .mocked(queries.updateSessionStatus)
      .mock.calls.filter(
        ([id, status]) => id === 'integration-session' && status === 'killed',
      );
    expect(killedCalls).toHaveLength(0);

    // --- Second boot: new SessionManager with the same 'running' session ---
    mockProc = createMockProc(); // fresh mock process for the re-spawned runner
    vi.mocked(spawn).mockReturnValue(mockProc.proc as ReturnType<typeof spawn>);
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([orphan]); // still 'running' in DB

    const sm2 = new SessionManager();
    const messages: ServerMessage[] = [];
    sm2.on('message', (m: ServerMessage) => messages.push(m));

    await sm2.resumeOrphanSessions();

    // The session was picked up and re-attached by the new SessionManager.
    expect(sm2.isAlive('integration-session')).toBe(true);

    // A status=running message was broadcast for the resumed session.
    const runningMsgs = messages.filter(
      (m) =>
        m.type === 'session_status' &&
        (m as { sessionId: string; status: string }).sessionId ===
          'integration-session' &&
        (m as { status: string }).status === 'running',
    );
    expect(runningMsgs.length).toBeGreaterThanOrEqual(1);
  });
});
