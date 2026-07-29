import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

// ── Module mocks ──────────────────────────────────────────────────────────────

let capturedSessions: ReturnType<typeof makeMockSession>[] = [];

type MockSession = EventEmitter & {
  prUrl?: string;
  hasEnded: boolean;
  sessionType: string;
  taskId?: string;
  run: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  endSession: ReturnType<typeof vi.fn>;
  gracefulPause: ReturnType<typeof vi.fn>;
  setPendingOverflowText: ReturnType<typeof vi.fn>;
  lockFileForNextInjection: ReturnType<typeof vi.fn>;
};

function makeMockSession(): MockSession {
  const ee = new EventEmitter() as MockSession;
  ee.prUrl = undefined;
  ee.hasEnded = false;
  ee.sessionType = 'standard';
  ee.run = vi.fn().mockReturnValue(new Promise(() => {}));
  ee.sendMessage = vi.fn();
  ee.kill = vi.fn().mockResolvedValue(undefined);
  ee.endSession = vi.fn();
  ee.gracefulPause = vi.fn().mockResolvedValue(undefined);
  ee.setPendingOverflowText = vi.fn();
  ee.lockFileForNextInjection = vi.fn();
  return ee;
}

vi.mock('../AgentSession', () => ({
  AgentSession: vi.fn().mockImplementation(() => {
    const s = makeMockSession();
    capturedSessions.push(s);
    return s;
  }),
  parseNotionPageIdDashed: vi.fn().mockReturnValue(''),
}));

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../DockerSessionRunner', () => ({
  DockerSessionRunner: vi.fn().mockImplementation(() => ({})),
  reapOrphanContainers: vi.fn(),
}));

vi.mock('../ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockResolvedValue(''),
}));
vi.mock('../orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue(''),
}));
vi.mock('../branchModel', () => ({
  resolveStartingPoint: vi
    .fn()
    .mockReturnValue({ startingPoint: 'dev', milestoneSlug: null }),
  ensureMilestoneBranch: vi.fn(),
  deriveBranchSlug: vi.fn().mockReturnValue('feature/my-task'),
}));
vi.mock('../orchestrator-config', () => ({
  loadOrchestratorConfig: vi
    .fn()
    .mockReturnValue({ mcp_servers: undefined, allowed_tools: [] }),
}));
vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('running'),
}));
vi.mock('../../tasks/taskId', () => ({
  formatTaskId: vi.fn().mockReturnValue('task-123'),
}));
vi.mock('../../notion/NotionClient', () => ({ parseSection: vi.fn() }));
vi.mock('../../github/reviewUtils', () => ({
  formatReviewFeedback: vi.fn().mockReturnValue('review-feedback'),
  formatApprovedVerdictMessage: vi.fn().mockReturnValue('approved'),
}));
vi.mock('../../security/scrubSecrets', () => ({
  scrubSecrets: vi.fn().mockImplementation((s: string) => s),
}));
vi.mock('../../config/corporateMode', () => ({
  getCorporateMode: vi
    .fn()
    .mockReturnValue({ gates: { dockerMandatory: false } }),
}));

vi.mock('../../db/queries', () =>
  mockDbQueries({
    insertSession: vi.fn(),
    updateSessionStatus: vi.fn(),
    updateSessionWorktreePath: vi.fn(),
    markSessionDone: vi.fn(),
    applyPendingDone: vi.fn().mockReturnValue(false),
    getSessionsWithUnappliedPendingDone: vi.fn().mockReturnValue([]),
    markSessionIdle: vi.fn(),
    markSessionSuperseded: vi.fn(),
    insertEvent: vi.fn(),
    getSession: vi.fn(),
    getSessionsByStatus: vi.fn().mockReturnValue([]),
    getOtherRunningSessionsForTask: vi.fn().mockReturnValue([]),
    getRunningSessionsWithMergedOrClosedPR: vi.fn().mockReturnValue([]),
    getPRByNotionTaskId: vi.fn().mockReturnValue(null),
    getEventsBySession: vi.fn().mockReturnValue([]),
    getPRByNumber: vi.fn().mockReturnValue(null),
    getPRBySessionId: vi.fn().mockReturnValue(null),
    getStuckResultSessionRows: vi.fn().mockReturnValue([]),
    hasActiveSessionForTask: vi.fn().mockReturnValue(false),
    incrementTaskCrashCount: vi.fn().mockReturnValue(1),
    getTerminalSessionsForTask: vi.fn().mockReturnValue([]),
    setSessionPauseReason: vi.fn(),
    setSessionLastErrorDetail: vi.fn(),
    setTaskPauseReason: vi.fn(),
    listStagedIntentsBySession: vi.fn().mockReturnValue([]),
    TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
  }),
);

vi.mock('../../config', () => ({
  config: { maxConcurrentCodeSessions: 5 },
  getProjectById: vi.fn(),
  normalizePath: vi.fn().mockImplementation((p: string) => p),
  runtimeSettings: { session_mode: 'cli', corporate_mode_enabled: false },
}));

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('dev\n'),
  // Default: call back immediately with success so promisify(exec) resolves.
  exec: vi
    .fn()
    .mockImplementation(
      (
        _cmd: string,
        _opts: unknown,
        callback: (
          err: Error | null,
          result?: { stdout: string; stderr: string },
        ) => void,
      ) => {
        callback(null, { stdout: '', stderr: '' });
      },
    ),
}));

vi.mock('fs', () => ({
  default: {
    // Default: existsSync returns true for all paths EXCEPT those ending in '.git'
    // so the worktree-reuse fast path is not triggered in tests that don't want it.
    existsSync: vi
      .fn()
      .mockImplementation((p: string) => !String(p).endsWith('.git')),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    readFileSync: vi.fn().mockReturnValue(''),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
  },
  existsSync: vi
    .fn()
    .mockImplementation((p: string) => !String(p).endsWith('.git')),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  SessionManager,
  gitWorktreeAddWithRetry,
  isRemovableWorktree,
  isDegradedSpawnFailure,
  BACKEND_SPAWN_DEGRADED_REASON,
  buildResumeMessage,
  buildPlanningResumeMessage,
  RESUME_NUDGE_MESSAGE,
  PLANNING_RESUME_FALLBACK_MESSAGE,
} from '../SessionManager';
import {
  updateSessionStatus,
  updateSessionWorktreePath,
  insertEvent,
  getSession,
  getSessionsByStatus,
  getStuckResultSessionRows,
  insertSession,
  incrementTaskCrashCount,
  setSessionLastErrorDetail,
  setTaskPauseReason,
  getPRBySessionId,
  listStagedIntentsBySession,
  applyPendingDone,
  getSessionsWithUnappliedPendingDone,
} from '../../db/queries';
import { getProjectById } from '../../config';
import { AgentSession } from '../AgentSession';
import { buildSessionContext } from '../ContextBuilder';
import { execSync, exec as execCb } from 'child_process';
import { recordEvent } from '../../audit/AuditLog';
import * as fsModule from 'fs';
import { loadOrchestratorConfig } from '../orchestrator-config';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SESSION_ID = 'original-session-abc123';
const PROJECT_ID = 'project-1';
const PROJECT_DIR = '/project';

function makeDeadRow(sessionId = SESSION_ID) {
  return {
    session_id: sessionId,
    task_id: 'task-1',
    task_name: 'my-task',
    task_url: 'https://notion.so/task',
    project_context_url: 'https://notion.so/project',
    project_id: PROJECT_ID,
    // Use 'idle' — these tests exercise the resume path for sessions whose
    // subprocess exited (idle) and are being resumed with new feedback.
    // 'done'/'error'/'killed' sessions are refused by the terminal status guard.
    status: 'idle',
    session_type: 'standard',
    pr_url: 'https://github.com/org/repo/pull/1',
    worktree_path: `${PROJECT_DIR}/.claude/worktrees/${sessionId}`,
    started_at: 1000,
    ended_at: 2000,
  } as any;
}

/** An idle session with no PR — for testing guard bypass edge cases. */
function makeIdleNoPrRow(sessionId = SESSION_ID) {
  return {
    ...makeDeadRow(sessionId),
    pr_url: null,
  } as any;
}

function makeProject() {
  return {
    id: PROJECT_ID,
    projectDir: PROJECT_DIR,
    baseBranch: 'dev',
    gitMode: undefined,
  } as any;
}

// ── sendOrResume — dead session path ─────────────────────────────────────────

describe('sendOrResume — dead session path', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  // Helper: start sendOrResume and emit first message to unblock firstEvent.
  async function doResume(text = 'hello'): Promise<string> {
    const p = sm.sendOrResume(SESSION_ID, text);
    // Wait for AgentSession to be constructed (exec is now async).
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    // Emit a boot message from the session to unblock the firstEvent promise.
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    return p;
  }

  it('returns the original session ID — no new UUID', async () => {
    const result = await doResume();
    expect(result).toBe(SESSION_ID);
  });

  it('constructs AgentSession with the original session ID', async () => {
    await doResume();
    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();
    const firstArg = vi.mocked(AgentSession).mock.calls[0][0];
    expect(firstArg).toBe(SESSION_ID);
  });

  it('updates DB row to running (does not insert a new row)', async () => {
    await doResume();
    expect(vi.mocked(updateSessionStatus)).toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
    // insertSession must NOT have been called with the original session ID
    const insertCalls = vi.mocked(insertSession).mock.calls;
    const insertedOriginal = insertCalls.some(
      ([s]) =>
        typeof s === 'object' &&
        s !== null &&
        (s as any).session_id === SESSION_ID,
    );
    expect(insertedOriginal).toBe(false);
  });

  it('updates worktree_path in DB for the resumed session', async () => {
    await doResume();
    expect(vi.mocked(updateSessionWorktreePath)).toHaveBeenCalledWith(
      SESSION_ID,
      expect.stringContaining(SESSION_ID),
    );
  });

  it('forwards pr_opened from resumed session to SessionManager', async () => {
    const prOpenedHandler = vi.fn();
    sm.on('pr_opened', prOpenedHandler);

    await doResume();

    const fakeJob = { prNumber: 42, repo: 'org/repo', sessionId: SESSION_ID };
    capturedSessions[0].emit('pr_opened', fakeJob);
    expect(prOpenedHandler).toHaveBeenCalledWith(fakeJob);
  });

  it('forwards push_detected from resumed session to SessionManager', async () => {
    const pushHandler = vi.fn();
    sm.on('push_detected', pushHandler);

    await doResume();

    const payload = { sha: 'abc123', sessionId: SESSION_ID };
    capturedSessions[0].emit('push_detected', payload);
    expect(pushHandler).toHaveBeenCalledWith(payload);
  });

  it('records the user_message event under the original session ID', async () => {
    await doResume('needs-changes feedback');
    expect(vi.mocked(insertEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: SESSION_ID,
        event_type: 'user_message',
        payload: 'needs-changes feedback',
      }),
    );
  });

  it('concurrency guard: two concurrent calls result in one spawn', async () => {
    // Launch both calls simultaneously — before either resolves.
    const p1 = sm.sendOrResume(SESSION_ID, 'first');
    const p2 = sm.sendOrResume(SESSION_ID, 'second');

    // Wait for AgentSession to be constructed (exec is now async).
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));

    // Emit first message to unblock the firstEvent promise.
    // capturedSessions has only one entry because the second call reused the inflight
    // promise or saw the live session.
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both resolve to the original session ID.
    expect(r1).toBe(SESSION_ID);
    expect(r2).toBe(SESSION_ID);

    // AgentSession must be constructed exactly once — no double-spawn.
    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();

    // git worktree add must be called at most once (via async exec, not execSync).
    const worktreeAdds = vi
      .mocked(execCb)
      .mock.calls.filter(
        ([cmd]) =>
          typeof cmd === 'string' && (cmd as string).includes('worktree add'),
      );
    expect(worktreeAdds.length).toBeLessThanOrEqual(1);
  });

  it.each(['done', 'error', 'killed'])(
    'refuses to respawn a terminal (%s) session without allowTerminal — no AgentSession constructed',
    async (terminalStatus) => {
      vi.mocked(getSession).mockReturnValue({
        ...makeDeadRow(),
        status: terminalStatus,
      } as any);

      const result = await sm.sendOrResume(SESSION_ID, 'feedback');

      expect(result).toBeNull();
      expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
    },
  );

  it('with allowTerminal, respawns a terminal session and records session_terminal_reopened instead of silently writing running', async () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'done',
    } as any);

    const p = sm.sendOrResume(SESSION_ID, 're-open me', {
      allowTerminal: true,
    });
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    await p;

    expect(vi.mocked(updateSessionStatus)).toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_terminal_reopened',
        actor_id: SESSION_ID,
        payload: expect.objectContaining({ status_before: 'done' }),
      }),
    );
  });

  it('passes taskBackend: "jira" through to buildSessionContext when resuming a jira-sourced project', async () => {
    vi.mocked(getProjectById).mockReturnValue({
      ...makeProject(),
      taskSource: 'jira',
    });
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      mcp_servers: undefined,
      allowed_tools: [],
      verify: [],
      bash_rules: [],
      session_rules: [],
    } as any);

    await doResume();

    expect(vi.mocked(buildSessionContext)).toHaveBeenCalledWith(
      expect.objectContaining({ taskBackend: 'jira' }),
    );
  });
});

// ── sendOrResume — live session fast path ────────────────────────────────────

describe('sendOrResume — live session fast path', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('delivers via send() directly when session is live — no new spawn', async () => {
    // First: do a resume to get the session registered as live.
    const p = sm.sendOrResume(SESSION_ID, 'first');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    await p;

    // Reset call counts.
    vi.mocked(AgentSession).mockClear();
    vi.mocked(insertEvent).mockClear();

    // Now call again — session is already in the map.
    sm.sendOrResume(SESSION_ID, 'live message');

    // No new session was created.
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
    // Message delivered directly via sendMessage.
    expect(capturedSessions[0].sendMessage).toHaveBeenCalledWith(
      'live message',
    );
  });

  it('updates status to running and emits session_status when live session is idle', async () => {
    // Establish the session as live (DB row has status 'idle' from beforeEach).
    const p = sm.sendOrResume(SESSION_ID, 'first');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    await p;

    vi.mocked(updateSessionStatus).mockClear();
    const emittedMessages: unknown[] = [];
    sm.on('message', (msg) => emittedMessages.push(msg));

    await sm.sendOrResume(SESSION_ID, 'live message');

    expect(vi.mocked(updateSessionStatus)).toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
    expect(emittedMessages).toContainEqual({
      type: 'session_status',
      sessionId: SESSION_ID,
      status: 'running',
    });
  });

  it('does not emit redundant status update when live session is already running', async () => {
    // Establish the session as live.
    const p = sm.sendOrResume(SESSION_ID, 'first');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    await p;

    vi.mocked(updateSessionStatus).mockClear();
    // Override: DB row already has status 'running'.
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'running',
    } as any);

    const emittedMessages: unknown[] = [];
    sm.on('message', (msg) => emittedMessages.push(msg));

    await sm.sendOrResume(SESSION_ID, 'live message');

    expect(vi.mocked(updateSessionStatus)).not.toHaveBeenCalled();
    expect(
      emittedMessages.filter((m: any) => m.type === 'session_status'),
    ).toHaveLength(0);
  });

  it.each(['done', 'error', 'killed'])(
    'does not overwrite a terminal (%s) status with running for a live session, and does not reopen it without allowTerminal',
    async (terminalStatus) => {
      // Establish the session as live.
      const p = sm.sendOrResume(SESSION_ID, 'first');
      await vi.waitFor(() =>
        expect(capturedSessions.length).toBeGreaterThan(0),
      );
      capturedSessions[0].emit('message', {
        type: 'session_event',
        sessionId: SESSION_ID,
        eventType: 'system',
        content: 'boot',
      });
      await p;

      vi.mocked(updateSessionStatus).mockClear();
      vi.mocked(recordEvent).mockClear();
      // The row concluded (e.g. a deferred done was applied) while the
      // process object is still registered as live.
      vi.mocked(getSession).mockReturnValue({
        ...makeDeadRow(),
        status: terminalStatus,
      } as any);

      const emittedMessages: unknown[] = [];
      sm.on('message', (msg) => emittedMessages.push(msg));

      await sm.sendOrResume(SESSION_ID, 'live message');

      expect(vi.mocked(updateSessionStatus)).not.toHaveBeenCalled();
      expect(
        emittedMessages.filter((m: any) => m.type === 'session_status'),
      ).toHaveLength(0);
      expect(vi.mocked(recordEvent)).not.toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'session_terminal_reopened' }),
      );
    },
  );

  it('explicitly reopens a live-but-terminal session when allowTerminal is set, recording session_terminal_reopened', async () => {
    const p = sm.sendOrResume(SESSION_ID, 'first');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    await p;

    vi.mocked(updateSessionStatus).mockClear();
    vi.mocked(recordEvent).mockClear();
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'done',
    } as any);

    await sm.sendOrResume(SESSION_ID, 'live message', { allowTerminal: true });

    expect(vi.mocked(updateSessionStatus)).toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_terminal_reopened',
        actor_id: SESSION_ID,
        payload: expect.objectContaining({ status_before: 'done' }),
      }),
    );
  });
});

// ── respawnSession shared helper ──────────────────────────────────────────────

describe('respawnSession shared helper — wires all three events', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('wires message, pr_opened, and push_detected forwarding on resumed session', async () => {
    const msgHandler = vi.fn();
    const prHandler = vi.fn();
    const pushHandler = vi.fn();
    sm.on('pr_opened', prHandler);
    sm.on('push_detected', pushHandler);

    const p = sm.sendOrResume(SESSION_ID, 'boot');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    const sess = capturedSessions[0];
    const bootMsg = {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'boot',
    };
    sess.emit('message', bootMsg);
    await p;

    // Add message handler after resume (it was registered by wireSession).
    sm.on('message', msgHandler);

    const afterMsg = {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'after',
    };
    sess.emit('message', afterMsg);
    sess.emit('pr_opened', { prNumber: 1, repo: 'org/repo' });
    sess.emit('push_detected', { sha: 'def456' });

    expect(msgHandler).toHaveBeenCalledWith(afterMsg);
    expect(prHandler).toHaveBeenCalledWith({ prNumber: 1, repo: 'org/repo' });
    expect(pushHandler).toHaveBeenCalledWith({ sha: 'def456' });
  });
});

// ── resumeOrphanSessions — boot recovery regression ──────────────────────────

describe('resumeOrphanSessions — boot recovery regression', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getStuckResultSessionRows).mockReturnValue([]);
  });

  it('reuses the original session ID and wires pr_opened', async () => {
    const orphanRow = { ...makeDeadRow(), status: 'running' };
    vi.mocked(getSessionsByStatus).mockReturnValue([orphanRow]);

    const prHandler = vi.fn();
    sm.on('pr_opened', prHandler);

    await sm.resumeOrphanSessions();

    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();
    // First constructor arg is the session ID.
    expect(vi.mocked(AgentSession).mock.calls[0][0]).toBe(SESSION_ID);

    // pr_opened must be forwarded.
    const sess = capturedSessions[0];
    const fakeJob = { prNumber: 5, repo: 'org/repo' };
    sess.emit('pr_opened', fakeJob);
    expect(prHandler).toHaveBeenCalledWith(fakeJob);
  });

  it('wires push_detected on orphan-recovered session', async () => {
    const orphanRow = { ...makeDeadRow(), status: 'running' };
    vi.mocked(getSessionsByStatus).mockReturnValue([orphanRow]);

    const pushHandler = vi.fn();
    sm.on('push_detected', pushHandler);

    await sm.resumeOrphanSessions();

    const sess = capturedSessions[0];
    sess.emit('push_detected', { sha: 'xyz' });
    expect(pushHandler).toHaveBeenCalledWith({ sha: 'xyz' });
  });

  it('does not flag resume_failed on a successful resume', async () => {
    const orphanRow = { ...makeDeadRow(), status: 'running' };
    vi.mocked(getSessionsByStatus).mockReturnValue([orphanRow]);

    await sm.resumeOrphanSessions();

    expect(vi.mocked(setTaskPauseReason)).not.toHaveBeenCalled();
    expect(vi.mocked(updateSessionStatus)).not.toHaveBeenCalledWith(
      SESSION_ID,
      'error',
      expect.any(Number),
    );
  });
});

// ── resumeOrphanSessions — deferred done-transition boot sweep ───────────────

describe('resumeOrphanSessions — deferred done-transition boot sweep', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getStuckResultSessionRows).mockReturnValue([]);
    vi.mocked(getSessionsByStatus).mockReturnValue([]);
  });

  it('applies a deferred done-transition left over from a restart and broadcasts session_status', async () => {
    const pendingRow = { ...makeDeadRow(), status: 'idle' };
    vi.mocked(getSessionsWithUnappliedPendingDone).mockReturnValue([
      pendingRow,
    ] as any);
    vi.mocked(applyPendingDone).mockReturnValue(true);

    const emittedMessages: unknown[] = [];
    sm.on('message', (msg) => emittedMessages.push(msg));

    await sm.resumeOrphanSessions();

    expect(vi.mocked(applyPendingDone)).toHaveBeenCalledWith(SESSION_ID);
    expect(emittedMessages).toContainEqual({
      type: 'session_status',
      sessionId: SESSION_ID,
      status: 'done',
    });
  });

  it('does not broadcast when applyPendingDone finds nothing to apply (e.g. stale row already terminal via another path)', async () => {
    const pendingRow = { ...makeDeadRow(), status: 'error' };
    vi.mocked(getSessionsWithUnappliedPendingDone).mockReturnValue([
      pendingRow,
    ] as any);
    vi.mocked(applyPendingDone).mockReturnValue(false);

    const emittedMessages: unknown[] = [];
    sm.on('message', (msg) => emittedMessages.push(msg));

    await sm.resumeOrphanSessions();

    expect(
      emittedMessages.filter((m: any) => m.type === 'session_status'),
    ).toHaveLength(0);
  });
});

// ── resumeOrphanSessions — planning (groom/design) session redrive ───────────

describe('resumeOrphanSessions — planning session redrive on restart', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getStuckResultSessionRows).mockReturnValue([]);
  });

  it('redrives a running planning turn but never touches an idle one', async () => {
    const runningPlanning = {
      ...makeDeadRow('running-planning-session'),
      session_type: 'design',
      status: 'running',
    };
    const idlePlanning = {
      ...makeDeadRow('idle-planning-session'),
      session_type: 'groom',
      status: 'idle',
    };
    // Mirrors the real getSessionsByStatus(statuses) filter — resumeOrphanSessions
    // only ever asks for 'running' rows, so an idle session is structurally
    // never a candidate for respawn.
    vi.mocked(getSessionsByStatus).mockImplementation((statuses: string[]) =>
      [runningPlanning, idlePlanning].filter((r) =>
        statuses.includes(r.status),
      ),
    );

    await sm.resumeOrphanSessions();

    expect(getSessionsByStatus).toHaveBeenCalledWith(['running']);
    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();
    expect(vi.mocked(AgentSession).mock.calls[0][0]).toBe(
      'running-planning-session',
    );
  });
});

// ── resumeOrphanSessions — resume failure flags needs_attention ──────────────
//
// Policy: a session resume can't continue must never be silently disposed
// (silent error + crash-count Notion flip). It must flag the task
// needs_attention via setTaskPauseReason(taskId, 'resume_failed', detail)
// instead, and the session row must not be deleted.

describe('resumeOrphanSessions — resume failure flags needs_attention (resume_failed)', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getStuckResultSessionRows).mockReturnValue([]);
  });

  it('worktree missing at resume time: flags resume_failed, does not spawn, session row not deleted', async () => {
    const orphanRow = { ...makeDeadRow(), status: 'running' };
    vi.mocked(getSessionsByStatus).mockReturnValue([orphanRow]);
    // Once-only override so the default existsSync behavior (relied on by
    // later describe blocks in this file) is restored after this call.
    vi.mocked(fsModule.existsSync).mockImplementationOnce(() => false);
    vi.mocked((fsModule as any).default.existsSync).mockImplementationOnce(
      () => false,
    );

    await sm.resumeOrphanSessions();

    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
    expect(vi.mocked(updateSessionStatus)).toHaveBeenCalledWith(
      SESSION_ID,
      'error',
      expect.any(Number),
    );
    expect(vi.mocked(setTaskPauseReason)).toHaveBeenCalledWith(
      'task-1',
      'resume_failed',
      expect.stringContaining('worktree missing'),
    );
    // Bypasses markSessionErrored's crash-budget/Notion-flip path entirely.
    expect(vi.mocked(incrementTaskCrashCount)).not.toHaveBeenCalled();
  });

  it('resumeSession throws unexpectedly: flags resume_failed instead of the silent crash-count flow', async () => {
    const orphanRow = { ...makeDeadRow(), status: 'running' };
    vi.mocked(getSessionsByStatus).mockReturnValue([orphanRow]);
    vi.mocked(loadOrchestratorConfig).mockImplementationOnce(() => {
      throw new Error('config boom');
    });

    await sm.resumeOrphanSessions();

    expect(vi.mocked(setTaskPauseReason)).toHaveBeenCalledWith(
      'task-1',
      'resume_failed',
      expect.stringContaining('config boom'),
    );
    expect(vi.mocked(updateSessionStatus)).toHaveBeenCalledWith(
      SESSION_ID,
      'error',
      expect.any(Number),
    );
    expect(vi.mocked(incrementTaskCrashCount)).not.toHaveBeenCalled();
  });

  it('project not found at resume time: flags resume_failed', async () => {
    const orphanRow = { ...makeDeadRow(), status: 'running' };
    vi.mocked(getSessionsByStatus).mockReturnValue([orphanRow]);
    vi.mocked(getProjectById).mockReturnValue(undefined);

    await sm.resumeOrphanSessions();

    expect(vi.mocked(setTaskPauseReason)).toHaveBeenCalledWith(
      'task-1',
      'resume_failed',
      expect.stringContaining('not found'),
    );
    expect(vi.mocked(incrementTaskCrashCount)).not.toHaveBeenCalled();
  });
});

// ── needs_changes verdict routing — synthetic integration test ────────────────

describe('needs_changes verdict routing — synthetic integration', () => {
  it('records formatReviewFeedback under the original coder session ID', async () => {
    capturedSessions = [];
    vi.clearAllMocks();

    const sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());

    const feedbackText = 'please fix the missing test';

    // Simulate ReviewOrchestrator routing a needs_changes verdict:
    //   await this.sessionManager.sendOrResume(prRow.session_id, formatReviewFeedback(result, 0))
    const routingPromise = sm.sendOrResume(SESSION_ID, feedbackText);

    // CLI emits first event — unblocks firstEvent inside _doSendOrResume.
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });

    await routingPromise;

    // The user_message event must be recorded under the ORIGINAL coder session ID.
    expect(vi.mocked(insertEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: SESSION_ID,
        event_type: 'user_message',
        payload: feedbackText,
      }),
    );
  });
});

// ── buildResumeMessage / buildPlanningResumeMessage — session-type branch ────

describe('buildResumeMessage — session-type branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
  });

  it.each(['groom', 'design', 'ops'] as const)(
    'a resumed %s session never receives RESUME_NUDGE_MESSAGE',
    (sessionType) => {
      const row = { ...makeDeadRow(), session_type: sessionType };
      expect(buildResumeMessage(row)).not.toBe(RESUME_NUDGE_MESSAGE);
    },
  );

  it('a planning session resumed with no specific reason receives the planning-shaped fallback, not an empty message', () => {
    const row = { ...makeDeadRow(), session_type: 'ops' };
    const message = buildResumeMessage(row);
    expect(message).toBe(PLANNING_RESUME_FALLBACK_MESSAGE);
    expect(message.length).toBeGreaterThan(0);
  });

  it('a planning session resumed after an intent was sent back names that intent and the rejection reason', () => {
    const row = { ...makeDeadRow(), session_type: 'design' };
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      {
        id: 'intent-1',
        kind: 'task.create',
        payload: JSON.stringify({ title: 'Fix the flaky test' }),
        state: 'rejected',
        disposition_reason: 'duplicate of task-42',
      } as any,
    ]);

    const message = buildResumeMessage(row);
    expect(message).toContain('task.create "Fix the flaky test"');
    expect(message).toContain('duplicate of task-42');
  });

  it('picks the most recently rejected intent when multiple exist', () => {
    const row = { ...makeDeadRow(), session_type: 'groom' };
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      {
        id: 'intent-1',
        kind: 'task.setStatus',
        payload: JSON.stringify({ taskId: 'task-1' }),
        state: 'rejected',
        disposition_reason: 'first reason',
      } as any,
      {
        id: 'intent-2',
        kind: 'task.setStatus',
        payload: JSON.stringify({ taskId: 'task-2' }),
        state: 'rejected',
        disposition_reason: 'second reason',
      } as any,
    ]);

    const message = buildPlanningResumeMessage(row);
    expect(message).toContain('task-2');
    expect(message).toContain('second reason');
    expect(message).not.toContain('first reason');
  });

  it('a code session with a stored needs_changes verdict still receives the formatted review feedback unchanged', () => {
    const row = { ...makeDeadRow(), session_type: 'standard' };
    vi.mocked(getPRBySessionId).mockReturnValue({
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
      review_iteration: 1,
      merge_state: 'clean',
      base_branch: 'dev',
    } as any);

    expect(buildResumeMessage(row)).toBe('review-feedback');
  });

  it('a code session with no stored verdict still receives RESUME_NUDGE_MESSAGE', () => {
    const row = { ...makeDeadRow(), session_type: 'standard' };
    vi.mocked(getPRBySessionId).mockReturnValue(null);

    expect(buildResumeMessage(row)).toBe(RESUME_NUDGE_MESSAGE);
  });
});

// ── cleanupWorktree chokepoint guard ─────────────────────────────────────────

describe('cleanupWorktree chokepoint guard', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('idle session with open PR — no git worktree remove invoked', () => {
    vi.mocked(getSession).mockReturnValue(
      makeDeadRow(), // status='idle', pr_url set
    );
    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
      'https://github.com/org/repo/pull/1',
      PROJECT_DIR,
    );
    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(0);
  });

  it('idle session with NO PR — teardown proceeds (no guard)', () => {
    vi.mocked(getSession).mockReturnValue(makeIdleNoPrRow());
    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
      undefined,
      PROJECT_DIR,
    );
    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(1);
  });

  it('done session with PR — teardown proceeds (guard only fires for idle)', () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'done',
    });
    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
      'https://github.com/org/repo/pull/1',
      PROJECT_DIR,
    );
    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(1);
  });
});

// ── isRemovableWorktree predicate ────────────────────────────────────────────

describe('isRemovableWorktree', () => {
  it('returns false when worktreePath === projectDir', () => {
    expect(isRemovableWorktree(PROJECT_DIR, PROJECT_DIR)).toBe(false);
  });

  it('returns false for a path outside <projectDir>/.claude/worktrees/', () => {
    expect(isRemovableWorktree(`${PROJECT_DIR}/other`, PROJECT_DIR)).toBe(
      false,
    );
    expect(isRemovableWorktree('/somewhere/else', PROJECT_DIR)).toBe(false);
    // Prefix-but-not-nested lookalike (sibling dir starting with the same string)
    expect(
      isRemovableWorktree(
        `${PROJECT_DIR}-evil/.claude/worktrees/x`,
        PROJECT_DIR,
      ),
    ).toBe(false);
  });

  it('returns true for a real per-session worktree path', () => {
    expect(
      isRemovableWorktree(
        `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
        PROJECT_DIR,
      ),
    ).toBe(true);
  });
});

// ── cleanupWorktree — refuses to tear down the project checkout ─────────────

describe('cleanupWorktree — refuses non-worktree paths', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'done' });
  });

  it('worktreePath === projectDir: no git worktree remove, no fs.rmSync, and it returns', () => {
    (sm as any).cleanupWorktree(
      SESSION_ID,
      PROJECT_DIR,
      undefined,
      PROJECT_DIR,
    );

    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(0);
    expect(vi.mocked((fsModule as any).default.rmSync)).not.toHaveBeenCalled();
  });

  it('records a worktree_teardown_refused audit event when the guard fires', () => {
    (sm as any).cleanupWorktree(
      SESSION_ID,
      PROJECT_DIR,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'worktree_teardown_refused',
        actor_type: 'system',
        actor_id: SESSION_ID,
        payload: expect.objectContaining({
          worktreePath: PROJECT_DIR,
          projectDir: PROJECT_DIR,
        }),
      }),
    );
  });

  it('a path outside <projectDir>/.claude/worktrees/ is refused (no removal)', () => {
    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/some-other-dir`,
      undefined,
      PROJECT_DIR,
    );

    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(0);
  });

  it('a real <projectDir>/.claude/worktrees/<id> path proceeds with removal', () => {
    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
      undefined,
      PROJECT_DIR,
    );

    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(1);
  });
});

// ── worktree_remove_failed audit event ───────────────────────────────────────

describe('cleanupWorktree — worktree_remove_failed audit on removal error', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    // Session is done — guard won't fire
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'done' });
  });

  it('emits worktree_remove_failed audit event when git worktree remove throws', () => {
    const removeErr = Object.assign(new Error('remove failed'), {
      stderr: Buffer.from('fatal: not a worktree'),
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('worktree remove')) throw removeErr;
      return 'feature/my-task\n';
    });

    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'worktree_remove_failed',
        actor_type: 'system',
        actor_id: SESSION_ID,
        payload: expect.objectContaining({
          stderr: expect.stringContaining('fatal: not a worktree'),
          fallbackOk: expect.any(Boolean),
        }),
      }),
    );
  });
});

// ── cleanupWorktree — post-remove prune (Fix A) ───────────────────────────────

describe('cleanupWorktree — git worktree prune always runs', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'done' });
  });

  it('calls git worktree prune after a successful worktree remove', () => {
    vi.mocked(execSync).mockReturnValue('');

    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
      undefined,
      PROJECT_DIR,
    );

    const pruneCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree prune'),
      );
    expect(pruneCalls).toHaveLength(1);
  });

  it('calls git worktree prune after a failed worktree remove', () => {
    const removeErr = Object.assign(new Error('remove failed'), {
      stderr: Buffer.from('fatal: not a working tree'),
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('worktree remove')) throw removeErr;
      return '';
    });

    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
      undefined,
      PROJECT_DIR,
    );

    const pruneCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree prune'),
      );
    expect(pruneCalls).toHaveLength(1);
  });
});

// ── cleanupWorktree — fs.rmSync fallback (Fix B) ─────────────────────────────

describe('cleanupWorktree — fs.rmSync fallback on worktree remove failure', () => {
  let sm: SessionManager;
  const worktreePath = `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'done' });
  });

  it('attempts fs.rmSync when git worktree remove fails and dir exists', () => {
    const removeErr = Object.assign(new Error('remove failed'), {
      stderr: Buffer.from('Invalid argument'),
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('worktree remove')) throw removeErr;
      return '';
    });
    // existsSync returns true for the worktree path (default mock behavior)
    vi.mocked((fsModule as any).default.existsSync).mockReturnValue(true);

    (sm as any).cleanupWorktree(
      SESSION_ID,
      worktreePath,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked((fsModule as any).default.rmSync)).toHaveBeenCalledWith(
      worktreePath,
      { recursive: true, force: true, maxRetries: 3, retryDelay: 500 },
    );
  });

  it('sets fallbackOk: true in audit event when fs.rmSync succeeds', () => {
    const removeErr = Object.assign(new Error('remove failed'), {
      stderr: Buffer.from('Invalid argument'),
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('worktree remove')) throw removeErr;
      return '';
    });
    vi.mocked((fsModule as any).default.existsSync).mockReturnValue(true);
    vi.mocked((fsModule as any).default.rmSync).mockReturnValue(undefined);

    (sm as any).cleanupWorktree(
      SESSION_ID,
      worktreePath,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'worktree_remove_failed',
        payload: expect.objectContaining({ fallbackOk: true }),
      }),
    );
  });

  it('sets fallbackOk: false in audit event when fs.rmSync also fails', () => {
    const removeErr = Object.assign(new Error('remove failed'), {
      stderr: Buffer.from('Invalid argument'),
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('worktree remove')) throw removeErr;
      return '';
    });
    vi.mocked((fsModule as any).default.existsSync).mockReturnValue(true);
    vi.mocked((fsModule as any).default.rmSync).mockImplementation(() => {
      throw new Error('EBUSY');
    });

    (sm as any).cleanupWorktree(
      SESSION_ID,
      worktreePath,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'worktree_remove_failed',
        payload: expect.objectContaining({ fallbackOk: false }),
      }),
    );
  });

  it('does NOT attempt fs.rmSync when git worktree remove succeeds', () => {
    vi.mocked(execSync).mockReturnValue('');

    (sm as any).cleanupWorktree(
      SESSION_ID,
      worktreePath,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked((fsModule as any).default.rmSync)).not.toHaveBeenCalled();
  });
});

// ── terminal cleanup: endSession + markSessionErrored for idle sessions ───────

describe('terminal cleanup for idle sessions (not live)', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('endSession on non-live idle session triggers worktree teardown', () => {
    // Simulate: PR merged → markSessionDone → session now 'done'
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'done' });

    sm.endSession(SESSION_ID);

    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(1);
  });

  it('endSession on live session does NOT trigger worktree teardown directly', async () => {
    // Set up mocks BEFORE calling sendOrResume
    vi.mocked(getSession).mockReturnValue(makeDeadRow()); // idle — can resume
    // Register a live session
    const p = sm.sendOrResume(SESSION_ID, 'boot');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'boot',
    });
    await p;

    vi.mocked(execSync).mockClear();
    sm.endSession(SESSION_ID);

    // endSession on a live session calls session.endSession() — no direct cleanup
    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(0);
  });

  it('markSessionErrored on non-live session (PR closed) triggers worktree teardown', () => {
    // Session is now 'error' (DB already updated). No task_id so getTaskBackend is skipped.
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'error',
      task_id: null,
    });

    sm.markSessionErrored(SESSION_ID, 'error', 'pr_closed');

    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(1);
  });
});

// ── sendOrResume: surviving worktree reuse ────────────────────────────────────

describe('sendOrResume — surviving worktree reuse (idle resume fast path)', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    // Session is idle with PR and a worktree_path
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    // Make existsSync return true for the .git file → fast path triggered
    vi.mocked(fsModule.existsSync).mockImplementation(() => true);
    vi.mocked((fsModule as any).default.existsSync).mockImplementation(
      () => true,
    );
  });

  async function doResume(text = 'hello'): Promise<string> {
    const p = sm.sendOrResume(SESSION_ID, text);
    const sess = capturedSessions[0];
    sess.emit('message', {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'boot',
    });
    return p;
  }

  it('no git worktree add when recorded worktree has .git file', async () => {
    await doResume();
    const worktreeAdds = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree add'),
      );
    expect(worktreeAdds).toHaveLength(0);
  });

  it('spawns CLI with the recorded worktree path as cwd', async () => {
    await doResume();
    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();
    // The AgentSession constructor receives worktreePath as its 5th arg
    const [, , , , worktreePath] = vi.mocked(AgentSession).mock.calls[0];
    expect(worktreePath).toBe(`${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`);
  });

  it('still creates AgentSession with original session ID', async () => {
    await doResume();
    expect(vi.mocked(AgentSession).mock.calls[0][0]).toBe(SESSION_ID);
  });
});

describe('sendOrResume — missing worktree falls through to recreation', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    // .git file does NOT exist → fast path skipped → git worktree add path
    vi.mocked(fsModule.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
    vi.mocked((fsModule as any).default.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
  });

  it('calls git worktree add when recorded worktree is missing', async () => {
    const p = sm.sendOrResume(SESSION_ID, 'hello');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'boot',
    });
    await p;

    // Worktree add now goes through async exec (gitWorktreeAddWithRetry), not execSync.
    const worktreeAdds = vi
      .mocked(execCb)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree add'),
      );
    expect(worktreeAdds.length).toBeGreaterThanOrEqual(1);
  });
});

// ── gitWorktreeAddWithRetry — unit tests ──────────────────────────────────────

const LOCK_STDERR =
  'error: could not lock config file /project/.git/config: File exists';
const BRANCH_EXISTS_STDERR =
  "fatal: A branch named 'feature/my-task' already exists.";

// Use zero-delay so retries are instant and no real/fake timer setup is needed.
const NO_DELAY = () => 0;

describe('gitWorktreeAddWithRetry — direct unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves on first attempt when exec succeeds', async () => {
    // Default mock already calls callback with success.
    await expect(
      gitWorktreeAddWithRetry(
        'git worktree add /path branch',
        { cwd: '/project' },
        3,
        NO_DELAY,
      ),
    ).resolves.toBeUndefined();
    expect(vi.mocked(execCb)).toHaveBeenCalledTimes(1);
  });

  it('retries on lock-contention error and succeeds on second attempt', async () => {
    let calls = 0;
    vi.mocked(execCb).mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        calls++;
        if (calls === 1) {
          const err = Object.assign(new Error('cmd failed'), {
            stderr: LOCK_STDERR,
          });
          callback(err);
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
      },
    );

    await expect(
      gitWorktreeAddWithRetry(
        'git worktree add /path branch',
        { cwd: '/project' },
        3,
        NO_DELAY,
      ),
    ).resolves.toBeUndefined();
    expect(vi.mocked(execCb)).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on non-lock error — fails immediately after one attempt', async () => {
    vi.mocked(execCb).mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        const err = Object.assign(new Error('cmd failed'), {
          stderr: BRANCH_EXISTS_STDERR,
        });
        callback(err);
      },
    );

    await expect(
      gitWorktreeAddWithRetry(
        'git worktree add /path branch',
        { cwd: '/project' },
        3,
        NO_DELAY,
      ),
    ).rejects.toMatchObject({ stderr: BRANCH_EXISTS_STDERR });
    // Only one attempt — no retry for non-lock errors.
    expect(vi.mocked(execCb)).toHaveBeenCalledTimes(1);
  });

  it('exhausts all retries on persistent lock error and rejects', async () => {
    vi.mocked(execCb).mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        const err = Object.assign(new Error('cmd failed'), {
          stderr: LOCK_STDERR,
        });
        callback(err);
      },
    );

    await expect(
      gitWorktreeAddWithRetry(
        'git worktree add /path branch',
        { cwd: '/project' },
        3,
        NO_DELAY,
      ),
    ).rejects.toMatchObject({ stderr: LOCK_STDERR });
    // 3 attempts (default maxAttempts).
    expect(vi.mocked(execCb)).toHaveBeenCalledTimes(3);
  });
});

// ── gitWorktreeAddWithRetry — per-repo serialization ──────────────────────────

describe('gitWorktreeAddWithRetry — per-repo serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes concurrent worktree adds for the same repo (never > 1 in flight)', async () => {
    let active = 0;
    let maxActive = 0;
    vi.mocked(execCb).mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        active++;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => {
          active--;
          callback(null, { stdout: '', stderr: '' });
        }, 15);
      },
    );

    await Promise.all([
      gitWorktreeAddWithRetry(
        'git worktree add /repoA/w1 b1',
        { cwd: '/repoA' },
        3,
        NO_DELAY,
      ),
      gitWorktreeAddWithRetry(
        'git worktree add /repoA/w2 b2',
        { cwd: '/repoA' },
        3,
        NO_DELAY,
      ),
      gitWorktreeAddWithRetry(
        'git worktree add /repoA/w3 b3',
        { cwd: '/repoA' },
        3,
        NO_DELAY,
      ),
    ]);

    expect(maxActive).toBe(1);
    expect(vi.mocked(execCb)).toHaveBeenCalledTimes(3);
  });

  it('does not serialize worktree adds for different repos', async () => {
    let active = 0;
    let maxActive = 0;
    vi.mocked(execCb).mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        active++;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => {
          active--;
          callback(null, { stdout: '', stderr: '' });
        }, 15);
      },
    );

    await Promise.all([
      gitWorktreeAddWithRetry(
        'git worktree add /repoA/w1 b1',
        { cwd: '/repoA' },
        3,
        NO_DELAY,
      ),
      gitWorktreeAddWithRetry(
        'git worktree add /repoB/w1 b1',
        { cwd: '/repoB' },
        3,
        NO_DELAY,
      ),
    ]);

    // Both repos' adds overlap — no cross-repo serialization.
    expect(maxActive).toBe(2);
  });

  it('same-repo lock contention under real concurrency never surfaces a .git/config lock error to the caller', async () => {
    // Simulates two concurrent launches against the same repo: without
    // per-repo serialization both `git worktree add` invocations would run
    // simultaneously and one would hit the .git/config lock. With
    // serialization the second call's exec() never overlaps the first, so
    // this mock — which fails if it observes concurrent invocations — never
    // rejects with a lock error, and both callers succeed.
    let inFlight = false;
    vi.mocked(execCb).mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        if (inFlight) {
          const err = Object.assign(new Error('cmd failed'), {
            stderr: LOCK_STDERR,
          });
          callback(err);
          return;
        }
        inFlight = true;
        setTimeout(() => {
          inFlight = false;
          callback(null, { stdout: '', stderr: '' });
        }, 10);
      },
    );

    await expect(
      Promise.all([
        gitWorktreeAddWithRetry(
          'git worktree add /repoA/w1 b1',
          { cwd: '/repoA' },
          3,
          NO_DELAY,
        ),
        gitWorktreeAddWithRetry(
          'git worktree add /repoA/w2 b2',
          { cwd: '/repoA' },
          3,
          NO_DELAY,
        ),
      ]),
    ).resolves.toBeDefined();
  });
});

// ── Spawn-health classification (degraded backend spawn) ──────────────────────

describe('isDegradedSpawnFailure', () => {
  it('classifies empty stderr + killed=true as a degraded spawn', () => {
    expect(isDegradedSpawnFailure({ stderr: '', killed: true })).toBe(true);
  });

  it('classifies empty stderr + a signal as a degraded spawn', () => {
    expect(
      isDegradedSpawnFailure({ stderr: '', signal: 'SIGKILL', killed: false }),
    ).toBe(true);
  });

  it('does not classify a normal command failure (non-empty stderr) as degraded', () => {
    expect(
      isDegradedSpawnFailure({ stderr: BRANCH_EXISTS_STDERR, killed: true }),
    ).toBe(false);
  });

  it('does not classify a clean non-killed failure as degraded', () => {
    expect(isDegradedSpawnFailure({ stderr: '', killed: false })).toBe(false);
  });

  it('handles non-object input safely', () => {
    expect(isDegradedSpawnFailure(null)).toBe(false);
    expect(isDegradedSpawnFailure(undefined)).toBe(false);
    expect(isDegradedSpawnFailure('boom')).toBe(false);
  });
});

describe('gitWorktreeAddWithRetry — degraded spawn does not retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails immediately (no retry) on a degraded-spawn-shaped error', async () => {
    vi.mocked(execCb).mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        const err = Object.assign(new Error('Command failed'), {
          stderr: '',
          killed: true,
        });
        callback(err);
      },
    );

    await expect(
      gitWorktreeAddWithRetry(
        'git worktree add /path branch',
        { cwd: '/project' },
        3,
        NO_DELAY,
      ),
    ).rejects.toMatchObject({ stderr: '', killed: true });
    expect(vi.mocked(execCb)).toHaveBeenCalledTimes(1);
  });
});

describe('sendOrResume — degraded spawn on worktree recreation is a backend-health condition', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(fsModule.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
    vi.mocked((fsModule as any).default.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
  });

  it('classifies as backend_spawn_degraded, does not hit the crash budget, and surfaces a restart-recommending detail', async () => {
    vi.mocked(execCb).mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        if (String(_cmd).includes('worktree add')) {
          const err = Object.assign(new Error('Command failed'), {
            stderr: '',
            killed: true,
          });
          return callback(err);
        }
        callback(null, { stdout: '', stderr: '' });
      },
    );

    const emittedMessages: any[] = [];
    sm.on('message', (msg) => emittedMessages.push(msg));

    const result = await sm.sendOrResume(SESSION_ID, 'hello');

    expect(result).toBe(SESSION_ID);
    // Backend-health condition, not a session/task-level failure — must not
    // count against the crash budget (would otherwise misattribute a
    // degraded backend spawn to the session/task).
    expect(vi.mocked(incrementTaskCrashCount)).not.toHaveBeenCalled();

    const lastErrorDetailCall = vi
      .mocked(setSessionLastErrorDetail)
      .mock.calls.find((call) => call[0] === SESSION_ID);
    expect(lastErrorDetailCall?.[1]).toMatch(/restart/i);

    expect(vi.mocked(updateSessionStatus)).toHaveBeenCalledWith(
      SESSION_ID,
      'error',
      expect.any(Number),
    );

    // The distinct reason code surfaced to the dashboard, not a generic
    // worktree_recreate_failed — lets the UI/operator recognize this as a
    // backend-health statement rather than a per-session error.
    const actionFailedMsg = emittedMessages.find(
      (m) => m.type === 'session_action_failed',
    );
    expect(actionFailedMsg?.reason).toBe(BACKEND_SPAWN_DEGRADED_REASON);
  });
});

// ── sendOrResume — lock-contention retry integration ─────────────────────────

describe('sendOrResume — lock-contention retry in worktree creation', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    // .git file absent → falls through to worktree creation.
    vi.mocked(fsModule.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
    vi.mocked((fsModule as any).default.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
  });

  it('lock error once then success → session created, crash count NOT incremented', async () => {
    let worktreeAddCalls = 0;
    vi.mocked(execCb).mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        if (String(_cmd).includes('worktree add')) {
          worktreeAddCalls++;
          if (worktreeAddCalls === 1) {
            const err = Object.assign(new Error('cmd failed'), {
              stderr: LOCK_STDERR,
            });
            return callback(err);
          }
        }
        callback(null, { stdout: '', stderr: '' });
      },
    );

    const p = sm.sendOrResume(SESSION_ID, 'hello');

    // Session is constructed after the successful retry (real timer, ~100-300ms).
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0), {
      timeout: 2000,
    });

    capturedSessions[0].emit('message', {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'boot',
    });

    const result = await p;

    expect(result).toBe(SESSION_ID);
    // Two worktree add attempts: lock error → retry → success.
    expect(worktreeAddCalls).toBe(2);
    // No crash budget hit — worktree eventually succeeded.
    expect(vi.mocked(incrementTaskCrashCount)).not.toHaveBeenCalled();
  });

  it('persistent lock error (all retries) → worktree_recreate_failed, crash count incremented', async () => {
    vi.mocked(execCb).mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        if (String(_cmd).includes('worktree add')) {
          const err = Object.assign(new Error('cmd failed'), {
            stderr: LOCK_STDERR,
          });
          return callback(err);
        }
        callback(null, { stdout: '', stderr: '' });
      },
    );

    // sendOrResume returns sessionId even on failure (errors are caught internally).
    const result = await sm.sendOrResume(SESSION_ID, 'hello');

    // sendOrResume returns sessionId even on failure.
    expect(result).toBe(SESSION_ID);
    // After exhausting retries, markSessionErrored is called → crash count incremented.
    expect(vi.mocked(incrementTaskCrashCount)).toHaveBeenCalledWith('task-1');
  });
});

// ── bootstrap failure / required_env / required_files gate ───────────────────

describe('start() — bootstrap gate', () => {
  let sm: SessionManager;

  const BASE_ORCH_CONFIG = {
    mcp_servers: undefined,
    allowed_tools: [],
    verify: [],
    bash_rules: [],
    session_rules: [],
    bootstrap_script: '',
    required_env: [] as string[],
    required_files: [] as string[],
    autofix: [],
    ci_check_name: [],
    test: [],
    test_timeout_sec: 300,
    test_max_rss_mb: 0,
    test_fail_fast: true,
    analyze: [],
    analyze_timeout_sec: 300,
    analyze_max_rss_mb: 0,
    analyze_fail_fast: true,
  };

  const START_OPTS = {
    projectId: PROJECT_ID,
    taskKind: 'non_milestone' as const,
    taskName: 'my-task',
  };

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    // .git absent → no worktree reuse; worktree add always succeeds
    vi.mocked(fsModule.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
    vi.mocked((fsModule as any).default.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
    // Default orchestrator config — no bootstrap_script, no required_*
    vi.mocked(loadOrchestratorConfig).mockReturnValue({ ...BASE_ORCH_CONFIG });
  });

  it('bootstrap exits non-zero → session marked error, last_error_detail set, runner not spawned', async () => {
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      ...BASE_ORCH_CONFIG,
      bootstrap_script: './scripts/bootstrap.sh',
    });

    // Make bootstrap exec fail; worktree add must still succeed
    vi.mocked(execCb).mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        if (String(_cmd).includes('bootstrap.sh')) {
          const err = Object.assign(new Error('Command failed'), {
            stderr: 'Error: .env not found',
          });
          return callback(err);
        }
        callback(null, { stdout: '', stderr: '' });
      },
    );

    sm.start('https://notion.so/task', 'https://notion.so/project', START_OPTS);

    await vi.waitFor(() =>
      expect(vi.mocked(setSessionLastErrorDetail)).toHaveBeenCalled(),
    );

    expect(vi.mocked(setSessionLastErrorDetail)).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('bootstrap failed'),
    );
    // AgentSession must NOT have been constructed
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
    // Session must be in error state
    expect(vi.mocked(updateSessionStatus)).toHaveBeenCalledWith(
      expect.any(String),
      'error',
      expect.any(Number),
    );
  });

  it('required_env var missing in process.env → launch aborts with clear reason', async () => {
    const missingVar = '__ORCH_TEST_MISSING_VAR_XYZ_NONEXISTENT__';
    delete process.env[missingVar];

    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      ...BASE_ORCH_CONFIG,
      required_env: [missingVar],
    });

    sm.start('https://notion.so/task', 'https://notion.so/project', START_OPTS);

    await vi.waitFor(() =>
      expect(vi.mocked(setSessionLastErrorDetail)).toHaveBeenCalled(),
    );

    expect(vi.mocked(setSessionLastErrorDetail)).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(missingVar),
    );
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
  });

  it('required_files entry missing in worktree → launch aborts with clear reason', async () => {
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      ...BASE_ORCH_CONFIG,
      required_files: ['.env'],
    });

    // existsSync returns false for paths containing '.env'
    vi.mocked((fsModule as any).default.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git') && !String(p).endsWith('.env'),
    );

    sm.start('https://notion.so/task', 'https://notion.so/project', START_OPTS);

    await vi.waitFor(() =>
      expect(vi.mocked(setSessionLastErrorDetail)).toHaveBeenCalled(),
    );

    expect(vi.mocked(setSessionLastErrorDetail)).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('.env'),
    );
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
  });

  it('no bootstrap_script and no required_* → session launches normally (AgentSession constructed)', async () => {
    // Default config has no bootstrap_script and empty required_* — already set in beforeEach.
    sm.start('https://notion.so/task', 'https://notion.so/project', START_OPTS);

    await vi.waitFor(() => expect(vi.mocked(AgentSession)).toHaveBeenCalled());

    // Bootstrap gate must not have fired — no bootstrap-related error detail set
    const calls = vi.mocked(setSessionLastErrorDetail).mock.calls;
    const bootstrapErrorCalls = calls.filter(([, detail]) =>
      String(detail).startsWith('bootstrap'),
    );
    expect(bootstrapErrorCalls).toHaveLength(0);
  });

  it('passes taskBackend: "jira" through to buildSessionContext for a jira-sourced project', async () => {
    vi.mocked(getProjectById).mockReturnValue({
      ...makeProject(),
      taskSource: 'jira',
    });

    sm.start(
      'https://jira.example.com/task',
      'https://jira.example.com/project',
      START_OPTS,
    );

    await vi.waitFor(() =>
      expect(vi.mocked(buildSessionContext)).toHaveBeenCalled(),
    );

    expect(vi.mocked(buildSessionContext)).toHaveBeenCalledWith(
      expect.objectContaining({ taskBackend: 'jira' }),
    );
  });
});

// ── start() — worktree_path persistence by session type ────────────────────

describe('start() — worktree_path persistence', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      mcp_servers: undefined,
      allowed_tools: [],
    } as any);
  });

  it.each(['groom', 'design', 'ops'] as const)(
    'persists worktree_path as null for a %s (planning) session — no worktree is ever created on disk',
    async (sessionType) => {
      await sm.start('https://notion.so/task', 'https://notion.so/project', {
        projectId: PROJECT_ID,
        taskKind: 'milestone',
        taskName: 'my-task',
        sessionType,
      });

      expect(vi.mocked(insertSession)).toHaveBeenCalledWith(
        expect.objectContaining({ worktree_path: null }),
      );
    },
  );

  it('persists a real worktree_path for a standard (code) session', async () => {
    await sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'non_milestone',
      taskName: 'my-task',
      sessionType: 'standard',
    });

    expect(vi.mocked(insertSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree_path: expect.stringContaining('.claude/worktrees/'),
      }),
    );
  });
});

// ── start() — planning/ops prompt assembly (gate-verify hardening) ─────────

describe('start() — planning/ops prompt assembly (gate-verify hardening)', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      mcp_servers: undefined,
      allowed_tools: [],
    } as any);
  });

  it('an ops session dispatched with injectedProcedureContent writes it verbatim and never runs buildSessionContext (the coding scaffold)', async () => {
    const procedure =
      '## Session Lifecycle\n\nGate-verify procedure content — read-only, one-shot.';

    await sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'non_milestone',
      taskName: 'gate-verify-task',
      sessionType: 'ops',
      injectedProcedureContent: procedure,
    });

    await vi.waitFor(() => expect(vi.mocked(AgentSession)).toHaveBeenCalled());

    expect(vi.mocked(buildSessionContext)).not.toHaveBeenCalled();

    const writeCalls = vi.mocked((fsModule as any).default.writeFileSync).mock
      .calls;
    const promptCall = writeCalls.find(([p]: [string]) =>
      String(p).includes('session-prompts'),
    );
    expect(promptCall).toBeDefined();
    const writtenContent = promptCall![1] as string;
    expect(writtenContent).toBe(procedure);
    expect(writtenContent).not.toMatch(/Pre-PR Gate/);
    expect(writtenContent).not.toMatch(/Open a draft PR/);
    expect(writtenContent).not.toMatch(/Responding to Review Comments/);
    expect(writtenContent).not.toMatch(/rebase/i);
  });

  it('an ops session dispatched with no injectedProcedureContent fails loud instead of falling back to buildOrchestratorClaudeMd', async () => {
    sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'non_milestone',
      taskName: 'gate-verify-task',
      sessionType: 'ops',
    });

    await vi.waitFor(() =>
      expect(vi.mocked(setSessionLastErrorDetail)).toHaveBeenCalled(),
    );

    expect(vi.mocked(setSessionLastErrorDetail)).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('injectedProcedureContent'),
    );
    expect(vi.mocked(buildSessionContext)).not.toHaveBeenCalled();
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
  });
});

// ── findLiveSessionIdForTask — planning session exclusion ──────────────────

describe('findLiveSessionIdForTask — planning session exclusion', () => {
  let sm: SessionManager;
  const TASK_ID = 'task-groom-1';

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
  });

  function registerInMemorySession(
    sessionId: string,
    sessionType: string,
    taskId: string,
  ): void {
    const session = makeMockSession();
    session.sessionType = sessionType;
    session.taskId = taskId;
    (session as any).sessionId = sessionId;
    (sm as any).sessions.set(sessionId, session);
  }

  it.each(['groom', 'design', 'ops'])(
    'returns undefined for a parked idle %s session — does not block a coding launch',
    (sessionType) => {
      registerInMemorySession('planning-session-1', sessionType, TASK_ID);
      vi.mocked(getSession).mockReturnValue({
        session_id: 'planning-session-1',
        status: 'idle',
      } as any);

      expect(sm.findLiveSessionIdForTask(TASK_ID)).toBeUndefined();
    },
  );

  it('still returns a live standard/coding session for the task (no regression to the double-launch guard)', () => {
    registerInMemorySession('coding-session-1', 'standard', TASK_ID);
    vi.mocked(getSession).mockReturnValue({
      session_id: 'coding-session-1',
      status: 'running',
    } as any);

    expect(sm.findLiveSessionIdForTask(TASK_ID)).toBe('coding-session-1');
  });
});
