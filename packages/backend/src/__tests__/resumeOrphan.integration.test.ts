/**
 * Integration tests for SessionManager.resumeOrphanSessions().
 *
 * These tests "seed" sessions via the mocked DB layer and call
 * resumeOrphanSessions() on a real SessionManager. They verify the three
 * end-to-end behaviors required by the hardening task:
 *   1. Missing worktree → session marked error, server stays alive, other
 *      sessions resume normally.
 *   2. Healthy worktree → session re-attached, status broadcast, resume nudge
 *      delivered via stdin to the CLI runner.
 *   3. pr_url carry-forward → AgentSession.prUrl populated from row.pr_url so
 *      a subsequent clean exit does not delete the PR branch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { mockDbQueries } from './helpers/mockDbQueries';

// ── Module mocks ─────────────────────────────────────────────────────────────
// All vi.mock calls must appear before importing the code under test.

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

vi.mock('child_process', () => {
  // SessionManager calls `promisify(exec)` at module load. util.promisify's
  // generic callback-detection wrapper around a vi.fn() has been observed to
  // never invoke its scheduled callback in this test file's full-suite run
  // order (isolated single-test runs are unaffected), stalling any test whose
  // code path awaits promisify(exec)(...) forever. Defining the well-known
  // promisify.custom symbol makes promisify use this direct
  // promise-returning implementation instead, sidestepping that interaction.
  const EXEC_PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom');
  const execMock = Object.assign(
    vi
      .fn()
      .mockImplementation(
        (
          _cmd: string,
          _opts: unknown,
          cb: (err: null, result: { stdout: string; stderr: string }) => void,
        ) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          callback(null, { stdout: '', stderr: '' });
        },
      ),
    {
      [EXEC_PROMISIFY_CUSTOM]: vi.fn(async () => ({
        stdout: '',
        stderr: '',
      })),
    },
  );
  return {
    spawn: vi.fn(() => mockProc.proc),
    execSync: vi.fn(() => ''),
    execFile: vi.fn(),
    exec: execMock,
  };
});

// fs is mocked so existsSync can be controlled per-test; readFileSync /
// statSync / writeFileSync are no-ops because the SessionManager paths under
// test (resumeOrphanSessions → resumeSession) only need existsSync. Anything
// else used transitively is shimmed below as a safe no-op.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => '{}'),
      writeFileSync: vi.fn(),
      statSync: vi.fn(() => ({ isFile: () => true })),
      mkdirSync: vi.fn(),
      chmodSync: vi.fn(),
    },
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    statSync: vi.fn(() => ({ isFile: () => true })),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
  };
});

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
  PLANNING_DISALLOWED_TOOLS: [],
  GITHUB_REPO: '',
  BASH_MAX_OUTPUT_LENGTH: 30_000,
  BASH_DEFAULT_TIMEOUT_MS: 120_000,
  config: {
    claudePath: '/fake/claude',
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
    autofix: [],
    verify: [],
    ci_check_name: [],
    allowed_tools: [],
    bash_rules: [],
    session_rules: [],
    review_rules: [],
    required_env: [],
    required_files: [],
    bootstrap_script: '',
    mcp_servers: {},
  })),
  getSessionAllowedTools: vi.fn(() => []),
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

// recordEvent() is called unconditionally in SessionManager.start(); mock it
// so the test doesn't try to hit a real SQLite DB.
vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn(() => 'Running'),
}));

vi.mock('../db/queries', () =>
  mockDbQueries({
    getGrantedCapabilities: vi.fn(() => []),
    getSessionsByStatus: vi.fn(() => []),
    getSession: vi.fn(),
    getEventsBySession: vi.fn(() => []),
    getPRByNotionTaskId: vi.fn(() => null),
    getPRByNumber: vi.fn(() => null),
    updateSessionStatus: vi.fn(),
    markSessionDone: vi.fn(),
    markSessionIdle: vi.fn(),
    getStuckResultSessionRows: vi.fn(() => []),
    getRunningSessionsWithMergedOrClosedPR: vi.fn(() => []),
    insertSession: vi.fn(),
    insertEvent: vi.fn(),
    upsertSessionEvent: vi.fn(() => 1),
    upsertPullRequest: vi.fn(),
    insertPermissionDenial: vi.fn(),
    incrementTokens: vi.fn(),
    setContextOccupancy: vi.fn(),
    insertSessionAudit: vi.fn(),
    setSessionModel: vi.fn(),
    getPRBySessionId: vi.fn(() => null),
    setHeadSha: vi.fn(),
    // Required by getCorporateMode() which is called unconditionally in resumeOrphanSessions().
    // Returning null makes it fall through to the default personal-mode config (no dockerMandatory).
    getSetting: vi.fn(() => null),
    hasActiveSessionForTask: vi.fn(() => false),
    setTaskPauseReason: vi.fn(),
    setSessionLastErrorDetail: vi.fn(),
    TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
    getSessionsWithUnappliedPendingDone: vi.fn(() => []),
    applyPendingDone: vi.fn(() => false),
    updateSessionWorktreePath: vi.fn(),
    listStagedIntentsBySession: vi.fn(() => []),
    resetTaskCrashCount: vi.fn(),
  }),
);

vi.mock('../session/sessionRecovery', () => ({
  recoverSession: vi.fn(async () => {}),
}));

// Now import the modules under test (after all mocks are in place).
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import {
  SessionManager,
  RESUME_NUDGE_MESSAGE,
} from '../session/SessionManager';
import * as queries from '../db/queries';
import type { ServerMessage } from '../ws/types';
import type { Session } from '../db/types';
import { recoverSession } from '../session/sessionRecovery';

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
  // execSync no-op stub (used for git fetch / git rev-parse / git worktree).
  vi.mocked(execSync).mockReturnValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Test 1: missing-worktree pre-check ─────────────────────────────────────
describe('resumeOrphanSessions() — missing-worktree pre-check (integration)', () => {
  it('marks the orphan with a missing worktree as error and emits session_ended without throwing', async () => {
    const missing = makeRunningSession({
      session_id: 'missing-session',
      worktree_path: '/fake/project/.claude/worktrees/missing-session',
    });
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([missing]);

    // fs.existsSync(missing.worktreePath) → false (worktree was deleted).
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    // Server-alive proxy: resumeOrphanSessions must not throw.
    await expect(sm.resumeOrphanSessions()).resolves.not.toThrow();

    // The missing session must be marked as error.
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'missing-session',
      'error',
      expect.any(Number),
    );
    // ... and a session_ended (status=error) broadcast must have been emitted.
    const ended = messages.filter(
      (m) =>
        m.type === 'session_ended' &&
        (m as { sessionId: string }).sessionId === 'missing-session',
    );
    expect(ended).toHaveLength(1);
    expect((ended[0] as { status: string }).status).toBe('error');

    // No CLI process should have been spawned for the missing-worktree orphan.
    expect(spawn).not.toHaveBeenCalled();
  });

  it('resumes a healthy orphan in the same batch even when another orphan has a missing worktree', async () => {
    const missing = makeRunningSession({
      session_id: 'missing-session',
      worktree_path: '/fake/project/.claude/worktrees/missing-session',
    });
    const healthy = makeRunningSession({
      session_id: 'healthy-session',
      worktree_path: '/fake/project/.claude/worktrees/healthy-session',
    });
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([missing, healthy]);

    // existsSync: false for missing, true for healthy.
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).includes('healthy-session'),
    );
    // Return a plausible branch name for git rev-parse on the healthy worktree.
    vi.mocked(execSync).mockReturnValue('session/healthy-session');

    const sm = new SessionManager();
    await sm.resumeOrphanSessions();

    // The missing-session orphan is marked error.
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'missing-session',
      'error',
      expect.any(Number),
    );

    // The healthy-session orphan is added to the live sessions map (re-attached).
    expect(sm.isAlive('healthy-session')).toBe(true);
    // Its status was broadcast as running by resumeSession().
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'healthy-session',
      'running',
    );
  });
});

// ── Test 2: healthy-worktree → running + nudge + WS events ────────────────
describe('resumeOrphanSessions() — healthy-worktree resume (integration)', () => {
  it('re-attaches, broadcasts session_status: running, and delivers the resume nudge over stdin', async () => {
    vi.useFakeTimers();
    try {
      const healthy = makeRunningSession({
        session_id: 'healthy-session',
        worktree_path: '/fake/project/.claude/worktrees/healthy-session',
      });
      vi.mocked(queries.getSessionsByStatus).mockReturnValue([healthy]);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execSync).mockReturnValue('session/healthy-session');

      const sm = new SessionManager();
      const messages: ServerMessage[] = [];
      sm.on('message', (m: ServerMessage) => messages.push(m));

      await sm.resumeOrphanSessions();

      // Session is alive (re-attached) and CLI was spawned.
      expect(sm.isAlive('healthy-session')).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);

      // Regression guard: resume spawn must pass '--resume <row.session_id>' so
      // the CLI restores the correct conversation. A wrong or fresh UUID here
      // would silently start a blank session instead of resuming.
      const resumeSpawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
      const resumeIdx = resumeSpawnArgs.indexOf('--resume');
      expect(resumeIdx).toBeGreaterThan(-1);
      expect(resumeSpawnArgs[resumeIdx + 1]).toBe('healthy-session');
      expect(resumeSpawnArgs).not.toContain('--session-id');

      // session_status: running was broadcast on the WS bus.
      const statusMsgs = messages.filter(
        (m) =>
          m.type === 'session_status' &&
          (m as { sessionId: string; status: string }).sessionId ===
            'healthy-session' &&
          (m as { status: string }).status === 'running',
      );
      expect(statusMsgs.length).toBeGreaterThanOrEqual(1);

      // The resume nudge is sent via setTimeout(2_000) inside resumeSession().
      // Advance fake timers past the nudge delay so this.send() runs.
      await vi.advanceTimersByTimeAsync(2_500);

      // The nudge was written to the CLI's stdin (stream-json format).
      const stdinJoined = mockProc.stdinChunks.join('');
      expect(stdinJoined).toContain(RESUME_NUDGE_MESSAGE);
      expect(stdinJoined).toMatch(/"type":"user"/);

      // A session_event with eventType=user_message was broadcast over WS.
      const nudgeEvents = messages.filter(
        (m) =>
          m.type === 'session_event' &&
          (m as { eventType: string }).eventType === 'user_message' &&
          (m as { content: string }).content === RESUME_NUDGE_MESSAGE,
      );
      expect(nudgeEvents).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Test 3: startup boot recovery for stuck sessions ─────────────────────
describe('resumeOrphanSessions() — stuck session boot recovery', () => {
  it('calls getStuckResultSessionRows before resuming orphans', async () => {
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([]);
    vi.mocked(queries.getStuckResultSessionRows).mockReturnValue([]);

    const sm = new SessionManager();
    await sm.resumeOrphanSessions();

    expect(queries.getStuckResultSessionRows).toHaveBeenCalledTimes(1);
  });

  it('logs a message and calls recoverSession for each stuck session', async () => {
    const stuckRow = {
      session_id: 'stuck-sess',
      task_id: 'task-1',
      task_url: 'https://notion.so/task',
      project_context_url: 'https://notion.so/ctx',
      project_id: 'test-project',
      pr_url: null,
      worktree_path: '/fake/wt',
      session_type: 'standard',
      last_ts: 1_000_000,
    };
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([]);
    vi.mocked(queries.getStuckResultSessionRows).mockReturnValue([
      stuckRow,
      stuckRow,
    ]);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const sm = new SessionManager();
    await sm.resumeOrphanSessions();

    expect(
      consoleSpy.mock.calls.some((args) =>
        args.some(
          (a) =>
            typeof a === 'string' &&
            a.includes('recovering') &&
            a.includes('2'),
        ),
      ),
    ).toBe(true);
    expect(recoverSession).toHaveBeenCalledTimes(2);
    expect(recoverSession).toHaveBeenCalledWith(
      'stuck-sess',
      expect.objectContaining({ scope: 'boot' }),
    );

    consoleSpy.mockRestore();
    vi.mocked(recoverSession).mockClear();
  });

  it('getStuckResultSessionRows runs before getSessionsByStatus', async () => {
    const callOrder: string[] = [];
    vi.mocked(queries.getStuckResultSessionRows).mockImplementation(() => {
      callOrder.push('getStuckResultSessionRows');
      return [];
    });
    vi.mocked(queries.getSessionsByStatus).mockImplementation(() => {
      callOrder.push('getSessionsByStatus');
      return [];
    });

    const sm = new SessionManager();
    await sm.resumeOrphanSessions();

    expect(callOrder[0]).toBe('getStuckResultSessionRows');
    expect(callOrder[1]).toBe('getSessionsByStatus');
  });
});

// ── Test 4: pr_url carry-forward ─────────────────────────────────────────
describe('resumeOrphanSessions() — pr_url carry-forward (integration)', () => {
  it('copies row.pr_url onto AgentSession.prUrl so cleanupWorktree does NOT delete the branch on clean exit', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/42';
    const withPr = makeRunningSession({
      session_id: 'pr-session',
      worktree_path: '/fake/project/.claude/worktrees/pr-session',
      pr_url: prUrl,
    });
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([withPr]);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockReturnValue('session/pr-session');

    const sm = new SessionManager();
    await sm.resumeOrphanSessions();

    // The live AgentSession should have prUrl populated.
    expect(sm.isAlive('pr-session')).toBe(true);
    const session = (
      sm as unknown as { sessions: Map<string, { prUrl?: string }> }
    ).sessions.get('pr-session');
    expect(session?.prUrl).toBe(prUrl);

    // Simulate a clean CLI exit so the .then() in wireSession() runs and
    // cleanupWorktree() executes. Branch deletion happens via execSync calls
    // matching /git branch -D/ — they must NOT fire when prUrl is set.
    const execSyncCallsBefore = vi.mocked(execSync).mock.calls.length;
    mockProc.proc.emit('exit', 0);
    // Drain microtasks so the .then(() => cleanupWorktree(...)) callback runs.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const execCallsAfter = vi
      .mocked(execSync)
      .mock.calls.slice(execSyncCallsBefore);
    const branchDeletions = execCallsAfter.filter(
      ([cmd]) => typeof cmd === 'string' && /git\s+branch\s+-D/.test(cmd),
    );
    expect(branchDeletions).toHaveLength(0);
  });
});

// ── Test 5: spawn arg contract ───────────────────────────────────────────────
// Dedicated regression test for the session_id/--resume contract.
// Ensures resumeOrphanSessions() always passes the DB row's session_id as the
// --resume value, not a fresh UUID. If the fix is reverted, this test fails.
describe('resumeOrphanSessions() — spawn arg contract: --resume <session_id>', () => {
  it('resume spawn uses the DB row session_id as the --resume value, not a fresh UUID', async () => {
    const SESSION_UUID = 'cafebabe-dead-beef-cafe-deadbeef1234';
    const orphan = makeRunningSession({
      session_id: SESSION_UUID,
      worktree_path: `/fake/project/.claude/worktrees/${SESSION_UUID}`,
    });
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([orphan]);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockReturnValue(`session/${SESSION_UUID}`);

    const sm = new SessionManager();
    await sm.resumeOrphanSessions();

    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];

    // '--resume' must be present and immediately followed by the exact UUID
    // stored in the DB row — this is the CLI conversation_id the CLI uses to
    // restore history.
    const resumeIdx = spawnArgs.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(spawnArgs[resumeIdx + 1]).toBe(SESSION_UUID);

    // '--session-id' is only for initial spawns, never for resume.
    expect(spawnArgs).not.toContain('--session-id');
  });

  it('initial spawn includes --session-id <sessionId> not --resume', async () => {
    const SESSION_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(execSync).mockReturnValue('');

    const sm = new SessionManager();
    await sm.start('https://notion.so/task', 'https://notion.so/ctx', {
      projectId: 'test-project',
      sessionId: SESSION_UUID,
      taskKind: 'milestone',
    });

    // launchSession() is fire-and-forget — poll until the spawn happens
    // before asserting, rather than assuming a fixed number of ticks.
    await vi.waitFor(
      () => {
        expect(spawn).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000, interval: 20 },
    );
    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];

    // Initial spawn must use '--session-id' followed by the exact UUID, never '--resume'.
    const sessionIdIdx = spawnArgs.indexOf('--session-id');
    expect(sessionIdIdx).toBeGreaterThan(-1);
    expect(spawnArgs[sessionIdIdx + 1]).toBe(SESSION_UUID);
    expect(spawnArgs).not.toContain('--resume');
  });
});

// ── Test 7: planning-session resumability pre-check ──────────────────────────
// Planning sessions (groom/design/ops/split) run with cwd === the project
// checkout and never carry a worktree_path — that's their documented shape,
// not a broken record. The pre-check must resolve the working directory to
// the project dir for them instead of treating worktree_path === null as
// "worktree missing".
describe('resumeOrphanSessions() — planning-session resumability pre-check', () => {
  it('resumes a groom/design/ops session with worktree_path=null when the project directory exists', async () => {
    const planning = makeRunningSession({
      session_id: 'planning-session',
      session_type: 'design',
      worktree_path: null,
    });
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([planning]);
    // Only the project dir exists on disk (there is no worktree for this row).
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === '/fake/project',
    );
    vi.mocked(execSync).mockReturnValue('');

    const sm = new SessionManager();
    await sm.resumeOrphanSessions();

    expect(sm.isAlive('planning-session')).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    // Never flagged as a resume failure — nothing was actually broken.
    expect(queries.setTaskPauseReason).not.toHaveBeenCalled();
    expect(queries.updateSessionStatus).not.toHaveBeenCalledWith(
      'planning-session',
      'error',
      expect.any(Number),
    );
  });

  it('still fails a standard coding session whose recorded worktree is absent (no regression)', async () => {
    const standard = makeRunningSession({
      session_id: 'standard-missing',
      session_type: 'standard',
      worktree_path: '/fake/project/.claude/worktrees/standard-missing',
    });
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([standard]);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const sm = new SessionManager();
    await sm.resumeOrphanSessions();

    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'standard-missing',
      'error',
      expect.any(Number),
    );
    expect(queries.setTaskPauseReason).toHaveBeenCalledWith(
      'notion-task-id',
      'resume_failed',
      expect.any(String),
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails a planning session whose project directory is genuinely missing, distinguishing it from "no path recorded"', async () => {
    const planning = makeRunningSession({
      session_id: 'planning-no-project-dir',
      session_type: 'ops',
      worktree_path: null,
    });
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([planning]);
    // Nothing exists on disk — the project checkout itself is gone.
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const sm = new SessionManager();
    await sm.resumeOrphanSessions();

    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'planning-no-project-dir',
      'error',
      expect.any(Number),
    );
    expect(queries.setTaskPauseReason).toHaveBeenCalledWith(
      'notion-task-id',
      'resume_failed',
      expect.stringContaining('no path recorded'),
    );
    expect(spawn).not.toHaveBeenCalled();

    // The log line must render the actually-resolved path, never an empty ().
    const warnCall = warnSpy.mock.calls.find((args) =>
      args.some(
        (a) =>
          typeof a === 'string' && a.includes('resumability pre-check failed'),
      ),
    );
    expect(warnCall).toBeDefined();
    const warnMsg = warnCall!.join(' ');
    expect(warnMsg).not.toContain('missing ()');
    expect(warnMsg).toContain('/fake/project');

    warnSpy.mockRestore();
  });

  it('renders the resolved worktree path (not an empty string) in the failure log for a standard session', async () => {
    const standard = makeRunningSession({
      session_id: 'standard-missing-2',
      session_type: 'standard',
      worktree_path: '/fake/project/.claude/worktrees/standard-missing-2',
    });
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([standard]);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const sm = new SessionManager();
    await sm.resumeOrphanSessions();

    const warnCall = warnSpy.mock.calls.find((args) =>
      args.some(
        (a) =>
          typeof a === 'string' && a.includes('resumability pre-check failed'),
      ),
    );
    expect(warnCall).toBeDefined();
    const warnMsg = warnCall!.join(' ');
    expect(warnMsg).not.toContain('missing ()');
    expect(warnMsg).toContain(
      '/fake/project/.claude/worktrees/standard-missing-2',
    );

    warnSpy.mockRestore();
  });

  it('resumes mixed orphans: planning sessions resume, a genuinely worktree-less standard session is rejected', async () => {
    const planning = makeRunningSession({
      session_id: 'mixed-planning',
      session_type: 'groom',
      worktree_path: null,
    });
    const standard = makeRunningSession({
      session_id: 'mixed-standard-missing',
      session_type: 'standard',
      worktree_path: null,
    });
    vi.mocked(queries.getSessionsByStatus).mockReturnValue([
      planning,
      standard,
    ]);
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === '/fake/project',
    );

    const sm = new SessionManager();
    await sm.resumeOrphanSessions();

    // The planning session resumes.
    expect(sm.isAlive('mixed-planning')).toBe(true);

    // The standard session, with no worktree_path at all, still fails —
    // planning-session treatment must not leak into standard sessions.
    expect(sm.isAlive('mixed-standard-missing')).toBe(false);
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'mixed-standard-missing',
      'error',
      expect.any(Number),
    );
    expect(queries.setTaskPauseReason).toHaveBeenCalledWith(
      'notion-task-id',
      'resume_failed',
      expect.stringContaining('no path recorded'),
    );
  });
});

// ── Test 6: merged/closed PR sessions are reaped, not resumed ────────────────
describe('resumeOrphanSessions() — merged/closed PR reaping', () => {
  it('marks merged-PR sessions as done on boot instead of resuming them', async () => {
    const mergedRow = {
      session_id: 'merged-sess',
      task_id: 'task-merged',
      task_url: 'https://notion.so/task',
      project_context_url: 'https://notion.so/ctx',
      project_id: 'test-project',
      pr_url: 'https://github.com/owner/repo/pull/504',
      worktree_path: '/fake/project/.claude/worktrees/merged-sess',
      session_type: 'standard',
      last_ts: 1_000_000,
    };

    vi.mocked(queries.getSessionsByStatus).mockReturnValue([]);
    vi.mocked(queries.getStuckResultSessionRows).mockReturnValue([]);
    vi.mocked(
      queries.getRunningSessionsWithMergedOrClosedPR as ReturnType<
        typeof vi.fn
      >,
    ).mockReturnValue([mergedRow]);

    const sm = new SessionManager();
    await sm.resumeOrphanSessions();

    // Merged-PR session must be marked done, not spawned.
    expect(queries.markSessionDone).toHaveBeenCalledWith(
      'merged-sess',
      mergedRow.last_ts,
      mergedRow.pr_url,
      expect.any(String),
      expect.objectContaining({ skipInFlightGuard: true }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
