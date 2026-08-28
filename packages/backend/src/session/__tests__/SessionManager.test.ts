import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  reclaimProcess: ReturnType<typeof vi.fn>;
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
  // Default: confirmed delivery (mirrors AgentSession.sendMessage's success
  // return) — tests that want to exercise the failed-write fallback path
  // override this per-test with .mockReturnValue(false).
  ee.sendMessage = vi.fn().mockReturnValue(true);
  ee.kill = vi.fn().mockResolvedValue(undefined);
  ee.endSession = vi.fn();
  // Mirrors AgentSession.reclaimProcess's real contract: hasEnded flips
  // unconditionally so a later sendOrResume's live-session fast path is
  // skipped in favor of a fresh --resume respawn.
  ee.reclaimProcess = vi.fn().mockImplementation(() => {
    ee.hasEnded = true;
    return Promise.resolve();
  });
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
  resolveResumeBranchSlug: vi.fn().mockReturnValue('feature/my-task'),
  resolveAvailableBranchSlug: vi.fn((base: string) => base),
}));
vi.mock('../orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    mcp_servers: undefined,
    allowed_tools: [],
    capability_pre_grants: {},
  }),
  resolvePreGrantCapabilities: vi.fn(() => []),
}));
vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../sessionCgroup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sessionCgroup')>();
  return { ...actual, killSessionCgroup: vi.fn() };
});
vi.mock('../processLiveness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../processLiveness')>();
  return { ...actual, killWorktreeProcessTree: vi.fn().mockReturnValue(0) };
});
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    updateStatus: vi.fn().mockResolvedValue(undefined),
    fetchTaskPage: vi.fn().mockResolvedValue(''),
  }),
}));
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('running'),
}));
vi.mock('../../tasks/taskId', () => ({
  formatTaskId: vi.fn().mockReturnValue('task-123'),
  normalizeBoardId: vi.fn((id: string) => id),
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
    getSessionDocsTargetSurface: vi.fn().mockReturnValue(undefined),
    setSessionDocsTargetSurface: vi.fn(),
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
    hasActivePlanningSessionForTask: vi.fn().mockReturnValue(false),
    incrementTaskCrashCount: vi.fn().mockReturnValue(1),
    getTerminalSessionsForTask: vi.fn().mockReturnValue([]),
    getTaskCache: vi.fn().mockReturnValue(undefined),
    setSessionPauseReason: vi.fn(),
    setSessionLastErrorDetail: vi.fn(),
    setTaskPauseReason: vi.fn(),
    listStagedIntentsBySession: vi.fn().mockReturnValue([]),
    TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
    enqueueFeedbackItem: vi.fn(),
    listUndeliveredInboxItems: vi.fn().mockReturnValue([]),
    markInboxItemsDelivered: vi.fn(),
    insertCompletingSignal: vi.fn(),
    // A canned resume_exhausted row so deriveSessionStatus (a real,
    // unmocked function) derives 'error' from flagResumeFailure's write —
    // mirrors what insertCompletingSignal would actually persist, without
    // wiring these tests through the real completing_signal_ledger table.
    listCompletingSignalsForSession: vi.fn().mockReturnValue([
      {
        id: 1,
        session_id: 'unused',
        task_id: null,
        session_type: 'standard',
        signal_class: 'resume_exhausted',
        signal_value: 'resume_failed',
        recorded_at: 1,
      },
    ]),
    setSessionTerminalCompletionReason: vi.fn(),
    incrementSessionPokeRetryCount: vi.fn().mockReturnValue(1),
    resetSessionPokeRetryCount: vi.fn(),
  }),
);

vi.mock('../../config', () => ({
  config: {},
  getProjectById: vi.fn(),
  normalizePath: vi.fn().mockImplementation((p: string) => p),
  runtimeSettings: {
    session_mode: 'cli',
    corporate_mode_enabled: false,
    max_concurrent_code_sessions: 5,
  },
}));

vi.mock('../../orchestration/memoryAdmission', () => ({
  // respawnSession's memory-admission gate — real os.freemem() is
  // unreliable/low in CI/sandboxed hosts, so tests always see headroom
  // unless a test explicitly overrides this mock.
  hasMemoryHeadroom: vi.fn().mockReturnValue({
    allowed: true,
    freeMemMB: 8192,
    minHostFreeMemoryMB: 4096,
    perSessionReserveMB: 3072,
    projectedFreeMB: 5120,
  }),
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
  execFile: vi.fn(),
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
  classifyWorktreeTeardownRefusal,
  isDegradedSpawnFailure,
  BACKEND_SPAWN_DEGRADED_REASON,
  buildResumeMessage,
  buildPlanningResumeMessage,
  RESUME_NUDGE_MESSAGE,
  PLANNING_RESUME_FALLBACK_MESSAGE,
  PLANNING_RESTART_RESUME_MESSAGE,
  fetchBaseBranchCoalesced,
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
  hasActivePlanningSessionForTask,
  getOtherRunningSessionsForTask,
  markSessionSuperseded,
  listUndeliveredInboxItems,
  markInboxItemsDelivered,
  setSessionPauseReason,
  getTaskCache,
  insertCompletingSignal,
  incrementSessionPokeRetryCount,
  getSessionDocsTargetSurface,
} from '../../db/queries';
import { getProjectById } from '../../config';
import { getCorporateMode } from '../../config/corporateMode';
import { reapOrphanContainers } from '../DockerSessionRunner';
import { AgentSession } from '../AgentSession';
import { buildSessionContext } from '../ContextBuilder';
import { deriveBranchSlug } from '../branchModel';
import { execSync, exec as execCb } from 'child_process';
import { recordEvent } from '../../audit/AuditLog';
import * as fsModule from 'fs';
import { loadOrchestratorConfig } from '../orchestrator-config';
import { getTaskBackend } from '../../tasks/TaskBackend';
import { hasMemoryHeadroom } from '../../orchestration/memoryAdmission';
import { killSessionCgroup } from '../sessionCgroup';
import { killWorktreeProcessTree } from '../processLiveness';

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

/**
 * Registers a live in-memory session on `sm` (via the resume path) and
 * returns its captured mock AgentSession, so tests can assert on
 * session.endSession()/kill() without spawning a real subprocess.
 */
async function registerLiveSession(sm: SessionManager, sessionId = SESSION_ID) {
  vi.mocked(getSession).mockReturnValue(makeDeadRow(sessionId)); // idle — resumable
  const p = sm.sendOrResume(sessionId, 'boot');
  await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
  const session = capturedSessions[capturedSessions.length - 1];
  session.emit('message', {
    type: 'session_event' as const,
    sessionId,
    eventType: 'system' as const,
    content: 'boot',
  });
  await p;
  return session;
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

  it('delivers the fast-path text exactly once, even if the respawned session emits multiple messages', async () => {
    await doResume('only-once');
    // A second event from the same respawned session must not trigger a
    // second send — the once('message', ...) gate only fires the first time.
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'assistant',
      content: 'second event',
    });

    expect(capturedSessions[0].sendMessage).toHaveBeenCalledTimes(1);
    expect(capturedSessions[0].sendMessage).toHaveBeenCalledWith('only-once');
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

  it('refuses to respawn an idle-but-archived session without allowTerminal — no AgentSession constructed', async () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'idle',
      archived: 1,
    } as any);

    const result = await sm.sendOrResume(SESSION_ID, 'feedback');

    expect(result).toBeNull();
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
  });

  it('with allowTerminal, resumes an idle-but-archived session — recovery paths still work', async () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'idle',
      archived: 1,
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
    const result = await p;

    expect(result).toBe(SESSION_ID);
    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();
  });

  it('an idle, unarchived session still resumes normally — idle is not reclassified as terminal', async () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'idle',
      archived: 0,
    } as any);

    const p = sm.sendOrResume(SESSION_ID, 'feedback');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    const result = await p;

    expect(result).toBe(SESSION_ID);
    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();
  });

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

// ── enqueueFeedback — attemptTerminalResume opt-out ──────────────────────────

describe('enqueueFeedback — terminal session behavior', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(listUndeliveredInboxItems).mockReturnValue([
      { id: 'item-1', source: 'operator-disposition', payload: 'feedback' },
    ] as any);
  });

  afterEach(() => {
    // vi.clearAllMocks() in the next describe's beforeEach clears call
    // history but not this mockReturnValue — without resetting it here it
    // leaks into every later describe in this file and silently swaps in
    // this stale pending item for whatever message that test actually sent.
    vi.mocked(listUndeliveredInboxItems).mockReturnValue([]);
  });

  it.each(['done', 'error', 'killed'])(
    'defaults to attempting a resume on a terminal (%s) session (no opts passed — existing callers unaffected)',
    async (terminalStatus) => {
      vi.mocked(getSession).mockReturnValue({
        ...makeDeadRow(),
        status: terminalStatus,
      } as any);
      const sendOrResumeSpy = vi
        .spyOn(sm, 'sendOrResume')
        .mockResolvedValue(SESSION_ID);

      await sm.enqueueFeedback(SESSION_ID, 'some-source', 'payload');

      expect(sendOrResumeSpy).toHaveBeenCalledWith(
        SESSION_ID,
        expect.any(String),
        { allowTerminal: true },
      );
      expect(vi.mocked(markInboxItemsDelivered)).toHaveBeenCalledWith([
        'item-1',
      ]);
    },
  );

  it.each(['done', 'error', 'killed'])(
    'with attemptTerminalResume:false on a terminal (%s) session, marks delivered without resuming, no spawn, no pause reason, no session_action_failed',
    async (terminalStatus) => {
      vi.mocked(getSession).mockReturnValue({
        ...makeDeadRow(),
        status: terminalStatus,
      } as any);
      const sendOrResumeSpy = vi.spyOn(sm, 'sendOrResume');
      const messageHandler = vi.fn();
      sm.on('message', messageHandler);

      await sm.enqueueFeedback(SESSION_ID, 'operator-disposition', 'payload', {
        attemptTerminalResume: false,
      });

      expect(sendOrResumeSpy).not.toHaveBeenCalled();
      expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
      expect(vi.mocked(markInboxItemsDelivered)).toHaveBeenCalledWith([
        'item-1',
      ]);
      expect(vi.mocked(setSessionPauseReason)).not.toHaveBeenCalled();
      expect(
        messageHandler.mock.calls.some(
          ([msg]) => msg.type === 'session_action_failed',
        ),
      ).toBe(false);
      expect(vi.mocked(recordEvent)).not.toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'session_terminal_reopened' }),
      );
    },
  );

  it('an idle (non-terminal) session still resumes and delivers regardless of attemptTerminalResume:false', async () => {
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    const sendOrResumeSpy = vi
      .spyOn(sm, 'sendOrResume')
      .mockResolvedValue(SESSION_ID);

    await sm.enqueueFeedback(SESSION_ID, 'operator-disposition', 'payload', {
      attemptTerminalResume: false,
    });

    expect(sendOrResumeSpy).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
    );
    expect(vi.mocked(markInboxItemsDelivered)).toHaveBeenCalledWith(['item-1']);
  });

  it('dispositioning an intent whose session is idle-but-archived marks the inbox item delivered and spawns no process, even with attemptTerminalResume defaulted to true', async () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'idle',
      archived: 1,
    } as any);
    const sendOrResumeSpy = vi.spyOn(sm, 'sendOrResume');

    await sm.enqueueFeedback(
      SESSION_ID,
      'operator-disposition',
      'staged intent declined',
    );

    expect(sendOrResumeSpy).not.toHaveBeenCalled();
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
    expect(vi.mocked(markInboxItemsDelivered)).toHaveBeenCalledWith(['item-1']);
  });
});

// ── enqueueFeedback — usage admission gate ───────────────────────────────────

describe('enqueueFeedback — usage admission gate', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(listUndeliveredInboxItems).mockReturnValue([
      { id: 'item-1', source: 'system:nudge', payload: 'nudge text' },
    ] as any);
  });

  afterEach(() => {
    // See the identical reset in "enqueueFeedback — terminal session
    // behavior" above — without it this leaks into every later describe.
    vi.mocked(listUndeliveredInboxItems).mockReturnValue([]);
  });

  it('a nudge withheld by a usage deferral (sendOrResume returns null) is not marked delivered', async () => {
    vi.spyOn(sm, 'sendOrResume').mockResolvedValue(null);

    await sm.enqueueFeedback(SESSION_ID, 'system:nudge', 'nudge text');

    expect(vi.mocked(markInboxItemsDelivered)).not.toHaveBeenCalled();
  });

  it('the same withheld item is delivered once the deferral clears (sendOrResume succeeds)', async () => {
    vi.spyOn(sm, 'sendOrResume').mockResolvedValueOnce(null);
    await sm.enqueueFeedback(SESSION_ID, 'system:nudge', 'nudge text');
    expect(vi.mocked(markInboxItemsDelivered)).not.toHaveBeenCalled();

    vi.spyOn(sm, 'sendOrResume').mockResolvedValueOnce(SESSION_ID);
    await sm.enqueueFeedback(SESSION_ID, 'system:nudge', 'nudge text');

    expect(vi.mocked(markInboxItemsDelivered)).toHaveBeenCalledWith(['item-1']);
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

// ── respawnSession — memory admission does not gate resume ────────────────────

describe('respawnSession — memory admission does not gate resume', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(hasMemoryHeadroom).mockReturnValue({
      allowed: false,
      freeMemMB: 500,
      minHostFreeMemoryMB: 4096,
      perSessionReserveMB: 3072,
      projectedFreeMB: -2572,
    });
  });

  it('spawns normally even when the (unconsulted) memory-admission check would deny it — resuming an existing session is not new work', async () => {
    const p = sm.sendOrResume(SESSION_ID, 'hello');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    await p;

    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();
    // Never consulted at all — the resume transition doesn't call it.
    expect(vi.mocked(hasMemoryHeadroom)).not.toHaveBeenCalled();
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

// ── resumeOrphanSessions — Docker orphan-container reap ordering ─────────────

describe('resumeOrphanSessions — Docker orphan-container reap ordering', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getStuckResultSessionRows).mockReturnValue([]);
    vi.mocked(getCorporateMode).mockReturnValue({
      gates: { dockerMandatory: true },
    } as ReturnType<typeof getCorporateMode>);
  });

  afterEach(() => {
    vi.mocked(getCorporateMode).mockReturnValue({
      gates: { dockerMandatory: false },
    } as ReturnType<typeof getCorporateMode>);
  });

  it('does not reap a status=running orphan session before it has had a chance to resume', async () => {
    const orphanRow = { ...makeDeadRow(), status: 'running' };
    vi.mocked(getSessionsByStatus).mockReturnValue([orphanRow]);

    await sm.resumeOrphanSessions();

    expect(reapOrphanContainers).toHaveBeenCalledTimes(1);
    const liveIds = vi.mocked(reapOrphanContainers).mock.calls[0][0];
    expect(liveIds.has(SESSION_ID)).toBe(true);
  });
});

// ── resumeOrphanSessions — usage admission gate ───────────────────────────────

describe('resumeOrphanSessions — usage admission gate', () => {
  let sm: SessionManager;

  beforeEach(async () => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getStuckResultSessionRows).mockReturnValue([]);
    const { clearUsageDeferral } = await import('../../db/queries.js');
    clearUsageDeferral('five_hour');
    clearUsageDeferral('seven_day');
  });

  it('does not spawn a resume while plan usage is exhausted, and tags the task as deferred', async () => {
    const { registerUsagePoller } =
      await import('../../orchestration/usageAdmission.js');
    const resetsAt = new Date(Date.now() + 60_000).toISOString();
    registerUsagePoller({
      getCache: () => ({
        available: true,
        fiveHour: { percent: 100, resetsAt, severity: 'exceeded' },
      }),
    });

    const orphanRow = { ...makeDeadRow(), status: 'running' };
    vi.mocked(getSessionsByStatus).mockReturnValue([orphanRow]);

    await sm.resumeOrphanSessions();

    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
    expect(vi.mocked(setTaskPauseReason)).toHaveBeenCalledWith(
      'task-1',
      'usage_limit_deferred',
      'five_hour',
    );
    // Not treated as a failure — the session row is left as-is, not driven
    // to a terminal 'error' status the way flagResumeFailure would.
    expect(vi.mocked(updateSessionStatus)).not.toHaveBeenCalled();
  });

  it('resumes normally once usage is available (existing resume behavior unaffected)', async () => {
    const { registerUsagePoller } =
      await import('../../orchestration/usageAdmission.js');
    registerUsagePoller({ getCache: () => ({ available: false }) });

    const orphanRow = { ...makeDeadRow(), status: 'running' };
    vi.mocked(getSessionsByStatus).mockReturnValue([orphanRow]);

    await sm.resumeOrphanSessions();

    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();
  });
});

// ── resumeOrphanSessions — max concurrent code sessions admission gate ───────
//
// Policy: orphans exceeding max_concurrent_code_sessions at boot were already
// running before the restart — they aren't stuck, just outnumbering the
// *new-dispatch* cap. They must be left resumable (row untouched, still
// 'running'), never driven to a terminal 'error' status.

describe('resumeOrphanSessions — max concurrent code sessions admission gate', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getStuckResultSessionRows).mockReturnValue([]);
  });

  it('does not error excess code-session orphans beyond the cap — leaves them running/resumable', async () => {
    // runtimeSettings.max_concurrent_code_sessions is mocked to 5 — seed 7
    // running code-session orphans so 2 exceed it.
    const orphanRows = Array.from({ length: 7 }, (_, i) => ({
      ...makeDeadRow(`orphan-${i}`),
      status: 'running',
    }));
    vi.mocked(getSessionsByStatus).mockReturnValue(orphanRows);

    await sm.resumeOrphanSessions();

    expect(vi.mocked(AgentSession)).toHaveBeenCalledTimes(5);
    // The excess must never be marked terminal via markSessionErrored's
    // updateSessionStatus write.
    expect(vi.mocked(updateSessionStatus)).not.toHaveBeenCalledWith(
      expect.stringMatching(/^orphan-/),
      'error',
      expect.any(Number),
    );
  });

  it('resumes review/depth_review orphans regardless of the code-session cap', async () => {
    const codeOrphans = Array.from({ length: 5 }, (_, i) => ({
      ...makeDeadRow(`code-${i}`),
      status: 'running',
    }));
    const reviewOrphan = {
      ...makeDeadRow('review-0'),
      status: 'running',
      session_type: 'review',
    };
    vi.mocked(getSessionsByStatus).mockReturnValue([
      ...codeOrphans,
      reviewOrphan,
    ]);

    await sm.resumeOrphanSessions();

    expect(vi.mocked(AgentSession)).toHaveBeenCalledTimes(6);
    expect(vi.mocked(AgentSession).mock.calls.map((c) => c[0])).toContain(
      'review-0',
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
      expect.stringContaining('path recorded but absent on disk'),
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

  it('a planning session resumed after an intent was declined names that intent and reason, with no instruction to revise/re-stage/supersede/withdraw', () => {
    const row = { ...makeDeadRow(), session_type: 'design' };
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      {
        id: 'intent-1',
        kind: 'task.create',
        payload: JSON.stringify({ title: 'Fix the flaky test' }),
        state: 'rejected',
        disposition_reason: 'duplicate of task-42',
        updated_at: 100,
      } as any,
    ]);

    const message = buildResumeMessage(row);
    expect(message).toContain('task.create "Fix the flaky test"');
    expect(message).toContain('duplicate of task-42');
    expect(message.toLowerCase()).not.toMatch(
      /revise|re-stage|restage|supersede|withdraw/,
    );
  });

  it('a planning session resumed after an intent was sent back (needs_revision) names that intent, the reason, and instructs revision', () => {
    const row = { ...makeDeadRow(), session_type: 'design' };
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      {
        id: 'intent-1',
        kind: 'task.create',
        payload: JSON.stringify({ title: 'Fix the flaky test' }),
        state: 'needs_revision',
        disposition_reason: 'needs more detail',
        updated_at: 100,
      } as any,
    ]);

    const message = buildResumeMessage(row);
    expect(message).toContain('task.create "Fix the flaky test"');
    expect(message).toContain('needs more detail');
    expect(message.toLowerCase()).toContain('revise');
  });

  it('picks the most recently updated reject-state intent when multiple exist', () => {
    const row = { ...makeDeadRow(), session_type: 'groom' };
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      {
        id: 'intent-1',
        kind: 'task.setStatus',
        payload: JSON.stringify({ taskId: 'task-1' }),
        state: 'rejected',
        disposition_reason: 'first reason',
        updated_at: 100,
      } as any,
      {
        id: 'intent-2',
        kind: 'task.setStatus',
        payload: JSON.stringify({ taskId: 'task-2' }),
        state: 'rejected',
        disposition_reason: 'second reason',
        updated_at: 200,
      } as any,
    ]);

    const message = buildPlanningResumeMessage(row);
    expect(message).toContain('task-2');
    expect(message).toContain('second reason');
    expect(message).not.toContain('first reason');
  });

  it('when a session holds both a rejected and a needs_revision intent, the more recently updated one determines the branch', () => {
    const row = { ...makeDeadRow(), session_type: 'groom' };
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      {
        id: 'intent-1',
        kind: 'task.setStatus',
        payload: JSON.stringify({ taskId: 'task-1' }),
        state: 'rejected',
        disposition_reason: 'declined reason',
        updated_at: 100,
      } as any,
      {
        id: 'intent-2',
        kind: 'task.setStatus',
        payload: JSON.stringify({ taskId: 'task-2' }),
        state: 'needs_revision',
        disposition_reason: 'pushback reason',
        updated_at: 200,
      } as any,
    ]);

    const message = buildPlanningResumeMessage(row);
    expect(message).toContain('task-2');
    expect(message).toContain('pushback reason');
    expect(message.toLowerCase()).toContain('revise');
    expect(message).not.toContain('declined reason');
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

// ── buildResumeMessage / buildPlanningResumeMessage — restart cause ─────────

describe('buildResumeMessage — restart cause', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    vi.mocked(listStagedIntentsBySession).mockReturnValue([]);
  });

  it('a planning session resumed by the boot-orphan path with zero staged intents states it was interrupted by a restart, and mentions no disposition feedback or staged intents', () => {
    const row = { ...makeDeadRow(), session_type: 'groom' };
    const message = buildResumeMessage(row, 'restart');
    expect(message).toBe(PLANNING_RESTART_RESUME_MESSAGE);
    expect(message.length).toBeGreaterThan(0);
    expect(message.toLowerCase()).not.toMatch(/disposition|staged intent/);
  });

  it('a restart-resumed planning session with a needs_revision intent still receives the sent-back-revise message', () => {
    const row = { ...makeDeadRow(), session_type: 'design' };
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      {
        id: 'intent-1',
        kind: 'task.create',
        payload: JSON.stringify({ title: 'Fix the flaky test' }),
        state: 'needs_revision',
        disposition_reason: 'needs more detail',
        updated_at: 100,
      } as any,
    ]);

    const message = buildResumeMessage(row, 'restart');
    expect(message).toContain('task.create "Fix the flaky test"');
    expect(message).toContain('needs more detail');
    expect(message.toLowerCase()).toContain('revise');
    expect(message).not.toBe(PLANNING_RESTART_RESUME_MESSAGE);
  });

  it('a restart-resumed planning session with a rejected intent still receives the declined-final message', () => {
    const row = { ...makeDeadRow(), session_type: 'design' };
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      {
        id: 'intent-1',
        kind: 'task.create',
        payload: JSON.stringify({ title: 'Fix the flaky test' }),
        state: 'rejected',
        disposition_reason: 'duplicate of task-42',
        updated_at: 100,
      } as any,
    ]);

    const message = buildResumeMessage(row, 'restart');
    expect(message).toContain('task.create "Fix the flaky test"');
    expect(message).toContain('duplicate of task-42');
    expect(message).toContain('final');
    expect(message).not.toBe(PLANNING_RESTART_RESUME_MESSAGE);
  });

  it('a restart-resumed session holding a reject-state intent produces exactly one message, not the restart fallback layered on top', () => {
    const row = { ...makeDeadRow(), session_type: 'groom' };
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      {
        id: 'intent-1',
        kind: 'task.setStatus',
        payload: JSON.stringify({ taskId: 'task-1' }),
        state: 'rejected',
        disposition_reason: 'declined reason',
        updated_at: 100,
      } as any,
    ]);

    const message = buildResumeMessage(row, 'restart');
    expect(message).not.toContain(PLANNING_RESTART_RESUME_MESSAGE);
    expect(message.toLowerCase()).not.toMatch(/restart|backend process/);
  });

  it('a restart-resumed code session with a stored needs_changes verdict still receives the formatted review feedback', () => {
    const row = { ...makeDeadRow(), session_type: 'standard' };
    vi.mocked(getPRBySessionId).mockReturnValue({
      review_result: JSON.stringify({ verdict: 'needs_changes' }),
      review_iteration: 1,
      merge_state: 'clean',
      base_branch: 'dev',
    } as any);

    expect(buildResumeMessage(row, 'restart')).toBe('review-feedback');
  });

  it('a restart-resumed code session with no stored verdict still receives RESUME_NUDGE_MESSAGE', () => {
    const row = { ...makeDeadRow(), session_type: 'standard' };
    vi.mocked(getPRBySessionId).mockReturnValue(null);

    expect(buildResumeMessage(row, 'restart')).toBe(RESUME_NUDGE_MESSAGE);
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

  it('idle session with NO PR — guard also fires (idle is non-terminal regardless of PR)', () => {
    // A planning session is exactly this shape (idle, pr_url null) — the
    // guard must protect it too, not just idle sessions with an open PR.
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
    expect(removeCalls).toHaveLength(0);
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

// ── cleanupWorktree — kills the session's test-command process tree before
//    the worktree it's rooted in is ever removed ────────────────────────────

describe('cleanupWorktree — process-tree termination', () => {
  let sm: SessionManager;
  const WORKTREE_PATH = `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('a session reaching a terminal status has killSessionCgroup invoked for it — reaches a test-command tree that carries no --session-id of its own', () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'done',
    });

    (sm as any).cleanupWorktree(
      SESSION_ID,
      WORKTREE_PATH,
      'https://github.com/org/repo/pull/1',
      PROJECT_DIR,
    );

    expect(vi.mocked(killSessionCgroup)).toHaveBeenCalledWith(SESSION_ID);
  });

  it('worktree teardown kills the worktree-path-attributed process tree before attempting git worktree remove', () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'done',
    });

    (sm as any).cleanupWorktree(
      SESSION_ID,
      WORKTREE_PATH,
      'https://github.com/org/repo/pull/1',
      PROJECT_DIR,
    );

    expect(vi.mocked(killWorktreeProcessTree)).toHaveBeenCalledWith(
      WORKTREE_PATH,
    );

    const killCallOrder = vi.mocked(killWorktreeProcessTree).mock
      .invocationCallOrder[0];
    const removeCall = vi
      .mocked(execSync)
      .mock.calls.findIndex(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    const removeCallOrder =
      vi.mocked(execSync).mock.invocationCallOrder[removeCall];
    expect(killCallOrder).toBeLessThan(removeCallOrder);
  });

  it('a live, non-terminal (idle) session is never a termination candidate — the chokepoint guard fires before any kill', () => {
    vi.mocked(getSession).mockReturnValue(makeDeadRow()); // status='idle'

    (sm as any).cleanupWorktree(
      SESSION_ID,
      WORKTREE_PATH,
      'https://github.com/org/repo/pull/1',
      PROJECT_DIR,
    );

    expect(vi.mocked(killSessionCgroup)).not.toHaveBeenCalled();
    expect(vi.mocked(killWorktreeProcessTree)).not.toHaveBeenCalled();
  });
});

// ── cleanupWorktree — stage-credential revocation is gated by the terminal
//    status guard, not by an unconditional teardown ──────────────────────────

describe('cleanupWorktree — stage credential revocation ordering', () => {
  let sm: SessionManager;
  const PLANNING_SESSION_ID = 'planning-session-xyz789';

  /** Planning-session row shape: worktree_path === the project checkout, pr_url null. */
  function makePlanningSessionRow(status: string) {
    return {
      session_id: PLANNING_SESSION_ID,
      task_id: 'task-1',
      task_name: 'my-task',
      task_url: 'https://notion.so/task',
      project_context_url: 'https://notion.so/project',
      project_id: PROJECT_ID,
      status,
      session_type: 'groom',
      pr_url: null,
      worktree_path: PROJECT_DIR,
      started_at: 1000,
      ended_at: status === 'idle' ? null : 2000,
    } as any;
  }

  beforeEach(async () => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    const { _resetStageCredentialsForTesting } =
      await import('../../auth/SessionStageAuth');
    _resetStageCredentialsForTesting();
  });

  it('a subprocess exit while DB status is non-terminal retains the stage credential (no revocation recorded)', async () => {
    const { mintStageCredential } = await import('../../auth/SessionStageAuth');
    const token = mintStageCredential(PLANNING_SESSION_ID);
    vi.mocked(getSession).mockReturnValue(makePlanningSessionRow('idle'));

    (sm as any).cleanupWorktree(
      PLANNING_SESSION_ID,
      PROJECT_DIR, // planning sessions use the project checkout as their worktree_path
      undefined,
      PROJECT_DIR,
    );

    expect(
      vi
        .mocked(recordEvent)
        .mock.calls.some(
          ([evt]) => evt.event_type === 'mcp_session_credential_revoked',
        ),
    ).toBe(false);

    // The credential is still the one the CLI's mcp config carries.
    const { mintStageCredential: remint } =
      await import('../../auth/SessionStageAuth');
    expect(remint(PLANNING_SESSION_ID)).toBe(token);
  });

  it.each(['done', 'error', 'killed'])(
    'a session reaching genuinely terminal status %s still has its credential revoked',
    async (status) => {
      const { mintStageCredential } =
        await import('../../auth/SessionStageAuth');
      mintStageCredential(PLANNING_SESSION_ID);
      vi.mocked(getSession).mockReturnValue(makePlanningSessionRow(status));

      (sm as any).cleanupWorktree(
        PLANNING_SESSION_ID,
        PROJECT_DIR,
        undefined,
        PROJECT_DIR,
      );

      expect(
        vi
          .mocked(recordEvent)
          .mock.calls.some(
            ([evt]) =>
              evt.event_type === 'mcp_session_credential_revoked' &&
              (evt.payload as any)?.sessionId === PLANNING_SESSION_ID,
          ),
      ).toBe(true);
    },
  );

  it('the idle guard is evaluated before any credential revocation or in-memory session deletion', () => {
    // Seed an in-memory session entry the way wireSession would.
    const fakeSession = { sessionType: 'groom' } as any;
    (sm as any).sessions.set(PLANNING_SESSION_ID, fakeSession);
    vi.mocked(getSession).mockReturnValue(makePlanningSessionRow('idle'));

    (sm as any).cleanupWorktree(
      PLANNING_SESSION_ID,
      PROJECT_DIR,
      undefined,
      PROJECT_DIR,
    );

    // Guard fired first — the in-memory entry must survive the non-terminal exit.
    expect((sm as any).sessions.get(PLANNING_SESSION_ID)).toBe(fakeSession);
    expect(
      vi
        .mocked(recordEvent)
        .mock.calls.some(
          ([evt]) => evt.event_type === 'mcp_session_credential_revoked',
        ),
    ).toBe(false);
  });

  it('the idle guard protects a planning session row (project checkout as worktree_path, pr_url null)', () => {
    vi.mocked(getSession).mockReturnValue(makePlanningSessionRow('idle'));

    (sm as any).cleanupWorktree(
      PLANNING_SESSION_ID,
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

// ── classifyWorktreeTeardownRefusal ──────────────────────────────────────────

describe('classifyWorktreeTeardownRefusal', () => {
  it('classifies a planning-type session with no worktree of its own as expected', () => {
    expect(
      classifyWorktreeTeardownRefusal('design', PROJECT_DIR, PROJECT_DIR),
    ).toEqual({ expected: true });
    expect(
      classifyWorktreeTeardownRefusal('groom', PROJECT_DIR, PROJECT_DIR),
    ).toEqual({ expected: true });
  });

  it('classifies a worktree-owning session type presenting a non-removable path as anomalous, with a reason', () => {
    const result = classifyWorktreeTeardownRefusal(
      'standard',
      PROJECT_DIR,
      PROJECT_DIR,
    );
    expect(result.expected).toBe(false);
    expect(result.reason).toEqual(expect.stringContaining('standard'));
    expect(result.reason).toEqual(expect.stringContaining(PROJECT_DIR));
  });

  it('classifies an "ops" session (worktree-owning, per usesWorktree) as anomalous even though it plans', () => {
    const result = classifyWorktreeTeardownRefusal(
      'ops',
      PROJECT_DIR,
      PROJECT_DIR,
    );
    expect(result.expected).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('classifies a "docs" session with an undeclared/Notion-page Target surface as expected (stage-only, no worktree)', () => {
    expect(
      classifyWorktreeTeardownRefusal(
        'docs',
        PROJECT_DIR,
        PROJECT_DIR,
        undefined,
      ),
    ).toEqual({ expected: true });
    expect(
      classifyWorktreeTeardownRefusal(
        'docs',
        PROJECT_DIR,
        PROJECT_DIR,
        'https://www.notion.so/some-page-abc123',
      ),
    ).toEqual({ expected: true });
  });

  it('classifies a "docs" session with a repo-file Target surface as anomalous — it is worktree-eligible like ops', () => {
    const result = classifyWorktreeTeardownRefusal(
      'docs',
      PROJECT_DIR,
      PROJECT_DIR,
      'docs/some-doc.md',
    );
    expect(result.expected).toBe(false);
    expect(result.reason).toEqual(expect.stringContaining('docs'));
  });
});

// ── cleanupWorktree — expected vs anomalous refusal reporting ───────────────

describe('cleanupWorktree — classifies the refusal it reports', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('planning session, worktreePath === projectDir: refused, no audit event (expected case)', () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'done',
      session_type: 'design',
    });

    (sm as any).cleanupWorktree(
      SESSION_ID,
      PROJECT_DIR,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked(recordEvent)).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'worktree_teardown_refused' }),
    );
    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(0);
    expect(vi.mocked((fsModule as any).default.rmSync)).not.toHaveBeenCalled();
  });

  it('worktree-owning session type, non-removable path: refused, audit event with expected:false and reason (anomalous case)', () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'done',
      session_type: 'standard',
    });

    (sm as any).cleanupWorktree(
      SESSION_ID,
      PROJECT_DIR,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'worktree_teardown_refused',
        payload: expect.objectContaining({
          worktreePath: PROJECT_DIR,
          projectDir: PROJECT_DIR,
          expected: false,
          reason: expect.stringContaining('standard'),
        }),
      }),
    );
    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(0);
    expect(vi.mocked((fsModule as any).default.rmSync)).not.toHaveBeenCalled();
  });

  it('docs session with an undeclared Target surface, worktreePath === projectDir: refused, no audit event (expected case)', () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'done',
      session_type: 'docs',
    });
    vi.mocked(getSessionDocsTargetSurface).mockReturnValue(undefined);

    (sm as any).cleanupWorktree(
      SESSION_ID,
      PROJECT_DIR,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked(recordEvent)).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'worktree_teardown_refused' }),
    );
  });

  it('docs session with a repo-file Target surface (worktree-eligible), non-removable path: refused, audit event with expected:false (anomalous case, threaded from getSessionDocsTargetSurface)', () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'done',
      session_type: 'docs',
    });
    vi.mocked(getSessionDocsTargetSurface).mockReturnValue('docs/some-doc.md');

    (sm as any).cleanupWorktree(
      SESSION_ID,
      PROJECT_DIR,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'worktree_teardown_refused',
        payload: expect.objectContaining({
          expected: false,
          reason: expect.stringContaining('docs'),
        }),
      }),
    );
    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(0);
    expect(vi.mocked((fsModule as any).default.rmSync)).not.toHaveBeenCalled();
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
    // First read is markSessionErrored's pre-write terminal guard — row is
    // still non-terminal ('idle') at that point. Later reads (teardown's own
    // getSession calls, including cleanupWorktree's chokepoint guard) see
    // the row as it stands after the (mocked) write: 'error'. No task_id so
    // getTaskBackend is skipped.
    vi.mocked(getSession)
      .mockReturnValueOnce({
        ...makeDeadRow(),
        task_id: null,
      })
      .mockReturnValue({
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

// ── markSessionErrored: revert guard on the task's current status ────────────
//
// A dying standard session must never demote a task that already reached a
// terminal state (Done/Deferred) — see UNCOUNTED_REASONS handling and the
// crash-budget branch in markSessionErrored.

describe('markSessionErrored — Notion status revert respects the task current status', () => {
  let sm: SessionManager;

  function taskCacheRow(status: string) {
    return {
      task_id: 'task-1',
      fetched_at: 0,
      raw_json: JSON.stringify({ status }),
    } as any;
  }

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('user_kill on a ✅ Done task performs no updateStatus call', () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
    });
    vi.mocked(getTaskCache).mockReturnValue(taskCacheRow('✅ Done'));

    sm.markSessionErrored(SESSION_ID, 'killed', 'user_kill');

    const backend = vi.mocked(getTaskBackend)('');
    expect(vi.mocked(backend.updateStatus)).not.toHaveBeenCalled();
  });

  it('user_kill on a ⏭️ Deferred task performs no updateStatus call', () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
    });
    vi.mocked(getTaskCache).mockReturnValue(taskCacheRow('⏭️ Deferred'));

    sm.markSessionErrored(SESSION_ID, 'killed', 'user_kill');

    const backend = vi.mocked(getTaskBackend)('');
    expect(vi.mocked(backend.updateStatus)).not.toHaveBeenCalled();
  });

  it('user_kill on a 🔄 In Progress task still reverts it to 🗂️ Ready (majority case)', () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
    });
    vi.mocked(getTaskCache).mockReturnValue(taskCacheRow('🔄 In Progress'));

    sm.markSessionErrored(SESSION_ID, 'killed', 'user_kill');

    const backend = vi.mocked(getTaskBackend)('');
    expect(vi.mocked(backend.updateStatus)).toHaveBeenCalledWith(
      'task-1',
      '🗂️ Ready',
      expect.objectContaining({
        source: 'orchestrator',
        sessionId: SESSION_ID,
      }),
    );
  });

  it('a cache miss falls back to the existing revert behaviour rather than silently skipping it', () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
    });
    vi.mocked(getTaskCache).mockReturnValue(undefined);

    sm.markSessionErrored(SESSION_ID, 'killed', 'user_kill');

    const backend = vi.mocked(getTaskBackend)('');
    expect(vi.mocked(backend.updateStatus)).toHaveBeenCalledWith(
      'task-1',
      '🗂️ Ready',
      expect.objectContaining({
        source: 'orchestrator',
        sessionId: SESSION_ID,
      }),
    );
  });

  it('a counted reason (crash budget path) does not set 🚫 Blocked on an already ✅ Done task', () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
    });
    vi.mocked(getTaskCache).mockReturnValue(taskCacheRow('✅ Done'));
    vi.mocked(incrementTaskCrashCount).mockReturnValue(2);

    sm.markSessionErrored(SESSION_ID, 'error', 'run_error');

    const backend = vi.mocked(getTaskBackend)('');
    expect(vi.mocked(backend.updateStatus)).not.toHaveBeenCalled();
  });

  it.each([
    'user_kill',
    'pr_closed',
    'launch_failed',
    'backend_spawn_degraded',
  ])(
    'handlePlanningSessionCrash still returns early for %s (UNCOUNTED_REASONS), unchanged',
    (reason) => {
      vi.mocked(getSession).mockReturnValue({
        ...makeDeadRow(),
        session_type: 'groom',
      });
      vi.mocked(getTaskCache).mockReturnValue(taskCacheRow('🔄 In Progress'));

      sm.markSessionErrored(SESSION_ID, 'killed', reason);

      const backend = vi.mocked(getTaskBackend)('');
      expect(vi.mocked(backend.updateStatus)).not.toHaveBeenCalled();
      expect(vi.mocked(incrementTaskCrashCount)).not.toHaveBeenCalled();
    },
  );
});

// ── endSession: terminal-status guard + escalation delegation ────────────────

describe('endSession — refuses to escalate against a non-terminal (idle) session', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('does not call session.endSession() when the row is idle — idle is never terminal', async () => {
    const session = await registerLiveSession(sm);
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'idle' });

    sm.endSession(SESSION_ID);

    expect(session.endSession).not.toHaveBeenCalled();
  });

  it('does not call session.endSession() when the row is running (mid-turn, not idle either)', async () => {
    const session = await registerLiveSession(sm);
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'running',
    });

    sm.endSession(SESSION_ID);

    expect(session.endSession).not.toHaveBeenCalled();
  });

  it.each(['done', 'error', 'killed'] as const)(
    'calls session.endSession() once the row is terminal (%s)',
    async (status) => {
      const session = await registerLiveSession(sm);
      vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status });

      sm.endSession(SESSION_ID);

      expect(session.endSession).toHaveBeenCalledTimes(1);
    },
  );
});

// ── reclaimSessionProcess: process-only reclamation, no session-kill ─────────

describe('reclaimSessionProcess — reclaims the OS process without terminating the session', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    // Fast-path worktree reuse for the post-reclaim respawn test below —
    // mirrors 'sendOrResume — surviving worktree reuse (idle resume fast path)'.
    vi.mocked(fsModule.existsSync).mockImplementation(() => true);
    vi.mocked((fsModule as any).default.existsSync).mockImplementation(
      () => true,
    );
  });

  it('calls session.reclaimProcess() against a live, idle (non-terminal) row — unlike endSession(), no terminal-status guard applies', async () => {
    const session = await registerLiveSession(sm);
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'idle' });

    sm.reclaimSessionProcess(SESSION_ID);

    expect(session.reclaimProcess).toHaveBeenCalledTimes(1);
    expect(session.endSession).not.toHaveBeenCalled();
  });

  it('never writes a session status or session_errored audit row', async () => {
    const session = await registerLiveSession(sm);
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'idle' });
    // registerLiveSession's own resume drives status/audit writes of its
    // own — clear those before isolating reclaimSessionProcess's effects.
    vi.mocked(updateSessionStatus).mockClear();
    vi.mocked(recordEvent).mockClear();

    sm.reclaimSessionProcess(SESSION_ID);

    expect(session.reclaimProcess).toHaveBeenCalledTimes(1);
    expect(updateSessionStatus).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'session_errored' }),
    );
  });

  it('falls back to killSessionCgroup only when no in-memory handle exists (no worktree teardown)', () => {
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'idle' });

    sm.reclaimSessionProcess(SESSION_ID);

    expect(killSessionCgroup).toHaveBeenCalledWith(SESSION_ID);
    expect(updateSessionStatus).not.toHaveBeenCalled();
  });

  it('a reclaimed session (hasEnded set) is routed to the --resume respawn path, never the live direct-send path, on the next sendOrResume', async () => {
    const session = await registerLiveSession(sm);
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'idle' });
    // registerLiveSession's own boot delivery already called
    // session.sendMessage once — clear that call history so the assertion
    // below isolates what happens *after* reclaim.
    session.sendMessage.mockClear();

    sm.reclaimSessionProcess(SESSION_ID);
    expect(session.hasEnded).toBe(true);

    vi.mocked(getSession).mockReturnValue(makeDeadRow()); // idle — resumable
    // sendOrResume's very first check is `liveSession && !liveSession.hasEnded`
    // (SessionManager.ts) — with hasEnded now true, the live direct-send
    // branch (this.send(), which reads session.sendMessage off the stale
    // map entry) is structurally unreachable, and execution instead falls
    // through into the --resume respawn path documented right above that
    // check. Swallow any rejection from the respawn attempt itself; how far
    // it gets isn't what this test is verifying.
    sm.sendOrResume(SESSION_ID, 'follow-up after reclaim').catch(() => {});

    expect(session.sendMessage).not.toHaveBeenCalled();
  });
});

describe('archiveAndEndSession — honours its "reap any live subprocess" docstring', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('delegates to endSession() so a live session with a terminal row is actually torn down', async () => {
    const session = await registerLiveSession(sm);
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'done' });

    sm.archiveAndEndSession(SESSION_ID);

    expect(session.endSession).toHaveBeenCalledTimes(1);
  });
});

// ── reconcileSessionsMap: reap-before-evict ───────────────────────────────────

describe('reconcileSessionsMap — reaps the process before dropping a stale entry', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('calls session.endSession() before evicting an entry whose row went terminal underneath it', async () => {
    const session = await registerLiveSession(sm);
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'done' });

    const result = sm.reconcileSessionsMap();

    expect(session.endSession).toHaveBeenCalledTimes(1);
    expect(result.dropped).toBe(1);
  });

  it('calls session.endSession() before evicting an entry whose row disappeared entirely', async () => {
    const session = await registerLiveSession(sm);
    vi.mocked(getSession).mockReturnValue(undefined);

    const result = sm.reconcileSessionsMap();

    expect(session.endSession).toHaveBeenCalledTimes(1);
    expect(result.dropped).toBe(1);
  });

  it('never touches a live session whose row is still idle (non-terminal)', async () => {
    const session = await registerLiveSession(sm);
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'idle' });

    const result = sm.reconcileSessionsMap();

    expect(session.endSession).not.toHaveBeenCalled();
    expect(result.dropped).toBe(0);
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
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
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

  it('passes the resuming (standard) session type through to getOtherRunningSessionsForTask', async () => {
    await doResume();
    expect(vi.mocked(getOtherRunningSessionsForTask)).toHaveBeenCalledWith(
      'task-1',
      SESSION_ID,
      'standard',
    );
  });

  it('planning-session resume (groom) passes its own type through — supersede sweep must not run', async () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(SESSION_ID),
      session_type: 'groom',
      worktree_path: null,
    });
    await doResume();
    expect(vi.mocked(getOtherRunningSessionsForTask)).toHaveBeenCalledWith(
      'task-1',
      SESSION_ID,
      'groom',
    );
    expect(vi.mocked(markSessionSuperseded)).not.toHaveBeenCalled();
  });

  it('a checkout-only planning session (groom, worktree_path=null) never has the resolved projectDir fallback written back to worktree_path', async () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(SESSION_ID),
      session_type: 'groom',
      worktree_path: null,
    });
    await doResume();
    // respawnSession is passed the resolved fallback cwd (projectDir) so the
    // CLI has somewhere to run --resume from, but that resolved value must
    // never be persisted — the DB column must stay null for this session
    // shape, same as start() would leave it.
    expect(vi.mocked(updateSessionWorktreePath)).not.toHaveBeenCalled();
  });
});

describe('sendOrResume — usage admission gate', () => {
  let sm: SessionManager;

  beforeEach(async () => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(fsModule.existsSync).mockImplementation(() => true);
    vi.mocked((fsModule as any).default.existsSync).mockImplementation(
      () => true,
    );
    const { clearUsageDeferral } = await import('../../db/queries.js');
    clearUsageDeferral('five_hour');
    clearUsageDeferral('seven_day');
  });

  it('does not spawn a process when usage is exhausted, and records a deferral carrying the window resets_at', async () => {
    const { registerUsagePoller } =
      await import('../../orchestration/usageAdmission.js');
    const { getUsageDeferral } = await import('../../db/queries.js');
    const resetsAt = new Date(Date.now() + 60_000).toISOString();
    registerUsagePoller({
      getCache: () => ({
        available: true,
        fiveHour: { percent: 100, resetsAt, severity: 'exceeded' },
      }),
    });

    const result = await sm.sendOrResume(SESSION_ID, 'hello');

    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(getUsageDeferral('five_hour')).toBe(Date.parse(resetsAt));
  });

  it('a deferred respawn leaves the session row unchanged — no status rewrite, no task-status revert — and does not kill the session', async () => {
    const { registerUsagePoller } =
      await import('../../orchestration/usageAdmission.js');
    const resetsAt = new Date(Date.now() + 60_000).toISOString();
    registerUsagePoller({
      getCache: () => ({
        available: true,
        fiveHour: { percent: 100, resetsAt, severity: 'exceeded' },
      }),
    });

    await sm.sendOrResume(SESSION_ID, 'hello');

    expect(vi.mocked(updateSessionStatus)).not.toHaveBeenCalled();
    // The task is tagged as deferred (visibility), never reverted off its
    // current status the way a hard failure would.
    expect(vi.mocked(setTaskPauseReason)).toHaveBeenCalledWith(
      'task-1',
      'usage_limit_deferred',
      'five_hour',
    );
  });

  it('resumes normally once usage is available (existing sendOrResume behavior unaffected)', async () => {
    const { registerUsagePoller } =
      await import('../../orchestration/usageAdmission.js');
    registerUsagePoller({ getCache: () => ({ available: false }) });

    const p = sm.sendOrResume(SESSION_ID, 'hello');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    const sess = capturedSessions[0];
    sess.emit('message', {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'boot',
    });
    await p;

    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();
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

  it('passes the resuming (standard) session type through to getOtherRunningSessionsForTask on the recreation path', async () => {
    const p = sm.sendOrResume(SESSION_ID, 'hello');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'boot',
    });
    await p;

    expect(vi.mocked(getOtherRunningSessionsForTask)).toHaveBeenCalledWith(
      'task-1',
      SESSION_ID,
      'standard',
    );
  });

  it('a pre-resume fetch failure records a diagnosable signal but the session still resumes', async () => {
    vi.mocked(getProjectById).mockReturnValue({
      ...makeProject(),
      projectDir: '/project-resume-fetch-fail',
    });
    vi.mocked(execCb).mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).startsWith('git fetch')) {
          const err = Object.assign(new Error('cmd failed'), {
            stderr:
              "error: cannot lock ref 'refs/remotes/origin/dev': is at ae9f9803 but expected 066b562e",
          });
          return callback(err);
        }
        callback(null, { stdout: '', stderr: '' });
      },
    );

    const p = sm.sendOrResume(SESSION_ID, 'hello');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'boot',
    });
    await p;

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'base_fetch_failed' }),
    );
    expect(vi.mocked(setSessionLastErrorDetail)).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('stale'),
    );
    // The resume still proceeded despite the fetch failure.
    expect(capturedSessions.length).toBeGreaterThan(0);
  });

  it('a benign lost ref-lock race on resume does not set a stale-base error or record base_fetch_failed', async () => {
    vi.mocked(getProjectById).mockReturnValue({
      ...makeProject(),
      projectDir: '/project-resume-fetch-benign',
    });
    vi.mocked(execCb).mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).startsWith('git fetch')) {
          const err = Object.assign(new Error('cmd failed'), {
            stderr:
              "error: cannot lock ref 'refs/remotes/origin/dev': is at fc7b2df8 but expected 863d2513",
          });
          return callback(err);
        }
        // The ref already holds the value the fetch wanted to write.
        callback(null, {
          stdout: 'fc7b2df8870355a1bb8b3cbb0eda4fac44f31456\n',
        });
      },
    );

    const p = sm.sendOrResume(SESSION_ID, 'hello');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'boot',
    });
    await p;

    expect(vi.mocked(recordEvent)).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'base_fetch_failed' }),
    );
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'base_fetch_ref_lock_benign' }),
    );
    expect(vi.mocked(setSessionLastErrorDetail)).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('stale'),
    );
    // The resume still proceeded despite the ref-lock race.
    expect(capturedSessions.length).toBeGreaterThan(0);
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

// ── fetchBaseBranchCoalesced — per-project pre-launch fetch serialization ─────
//
// Each test uses its own unique project directory so the module-level
// coalescing cache (deliberately shared across calls within a short window)
// can never leak an outcome from one test into another.

describe('fetchBaseBranchCoalesced — direct unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes concurrent fetches for the same project (never > 1 in flight, one exec call)', async () => {
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

    const dir = '/fetch-test-serialize';
    const results = await Promise.all([
      fetchBaseBranchCoalesced(dir, 'dev'),
      fetchBaseBranchCoalesced(dir, 'dev'),
      fetchBaseBranchCoalesced(dir, 'dev'),
    ]);

    expect(maxActive).toBe(1);
    expect(vi.mocked(execCb)).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('coalesces a burst that arrives after completion — reuses the outcome without a new exec call', async () => {
    vi.mocked(execCb).mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
      },
    );

    const dir = '/fetch-test-coalesce';
    const first = await fetchBaseBranchCoalesced(dir, 'dev');
    const second = await fetchBaseBranchCoalesced(dir, 'dev');
    const third = await fetchBaseBranchCoalesced(dir, 'dev');

    expect(vi.mocked(execCb)).toHaveBeenCalledTimes(1);
    expect(first.ok).toBe(true);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('does not serialize or coalesce fetches for different projects', async () => {
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
      fetchBaseBranchCoalesced('/fetch-test-projA', 'dev'),
      fetchBaseBranchCoalesced('/fetch-test-projB', 'dev'),
    ]);

    expect(maxActive).toBe(2);
    expect(vi.mocked(execCb)).toHaveBeenCalledTimes(2);
  });

  it('returns ok:false on failure without throwing, retrying, or forcing past the lock', async () => {
    vi.mocked(execCb).mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).startsWith('git fetch')) {
          const err = Object.assign(new Error('cmd failed'), {
            stderr:
              "error: cannot lock ref 'refs/remotes/origin/dev': is at ae9f9803 but expected 066b562e",
          });
          return callback(err);
        }
        // rev-parse ref-lock classification calls: leave unresolvable so the
        // outcome is classified as a non-benign (genuine) failure.
        callback(new Error('unknown revision'));
      },
    );

    const outcome = await fetchBaseBranchCoalesced(
      '/fetch-test-failure',
      'dev',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeDefined();
    // Exactly one fetch attempt — no retry loop chasing the lock mismatch.
    const fetchCalls = vi
      .mocked(execCb)
      .mock.calls.filter(([cmd]) => String(cmd).startsWith('git fetch'));
    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0][0])).not.toContain('--force');
  });

  it('classifies a lost ref-lock race as benign when the ref already holds the value the fetch wanted', async () => {
    vi.mocked(execCb).mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).startsWith('git fetch')) {
          const err = Object.assign(new Error('cmd failed'), {
            stderr:
              "error: cannot lock ref 'refs/remotes/origin/dev': is at fc7b2df8 but expected 863d2513",
          });
          return callback(err);
        }
        // Both the local ref and FETCH_HEAD now hold the winner's value.
        callback(null, {
          stdout: 'fc7b2df8870355a1bb8b3cbb0eda4fac44f31456\n',
        });
      },
    );

    const outcome = await fetchBaseBranchCoalesced(
      '/fetch-test-benign-ref-lock',
      'dev',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.benignRefLock).toBe(true);
  });

  it('does not classify a ref-lock loss as benign when the ref differs from FETCH_HEAD', async () => {
    vi.mocked(execCb).mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).startsWith('git fetch')) {
          const err = Object.assign(new Error('cmd failed'), {
            stderr:
              "error: cannot lock ref 'refs/remotes/origin/dev': is at ae9f9803 but expected 066b562e",
          });
          return callback(err);
        }
        if (String(cmd).includes('refs/remotes/origin/dev')) {
          return callback(null, {
            stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
          });
        }
        // FETCH_HEAD
        callback(null, {
          stdout: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n',
        });
      },
    );

    const outcome = await fetchBaseBranchCoalesced(
      '/fetch-test-genuine-stale',
      'dev',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.benignRefLock).toBe(false);
  });

  it('does not classify a non-ref-lock failure (network/timeout) as benign', async () => {
    vi.mocked(execCb).mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).startsWith('git fetch')) {
          const err = Object.assign(new Error('cmd failed'), {
            stderr: 'fatal: unable to access origin: Could not resolve host',
          });
          return callback(err);
        }
        callback(null, {
          stdout: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n',
        });
      },
    );

    const outcome = await fetchBaseBranchCoalesced(
      '/fetch-test-network-failure',
      'dev',
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.benignRefLock).toBe(false);
    // Never re-reads refs for a non-ref-lock failure.
    const revParseCalls = vi
      .mocked(execCb)
      .mock.calls.filter(([cmd]) => String(cmd).startsWith('git rev-parse'));
    expect(revParseCalls).toHaveLength(0);
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

  it('below the poke-retry limit: classifies as backend_spawn_degraded, does not hit the crash budget or terminalize the session', async () => {
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
    // Default mock (1) — below POKE_RETRY_LIMIT (3), so this is a retriable
    // failure, not yet routed to flagResumeFailure.
    vi.mocked(incrementSessionPokeRetryCount).mockReturnValue(1);

    const emittedMessages: any[] = [];
    sm.on('message', (msg) => emittedMessages.push(msg));

    const result = await sm.sendOrResume(SESSION_ID, 'hello');

    expect(result).toBe(SESSION_ID);
    // Backend-health condition, not a session/task-level failure — must not
    // count against the crash budget (would otherwise misattribute a
    // degraded backend spawn to the session/task).
    expect(vi.mocked(incrementTaskCrashCount)).not.toHaveBeenCalled();
    expect(vi.mocked(incrementSessionPokeRetryCount)).toHaveBeenCalledWith(
      SESSION_ID,
    );

    // Not yet exhausted — the session row must be left untouched so a later
    // poke can retry, not driven to a terminal 'error' on the first failure.
    expect(vi.mocked(updateSessionStatus)).not.toHaveBeenCalled();
    expect(vi.mocked(setSessionLastErrorDetail)).not.toHaveBeenCalled();
    expect(vi.mocked(setTaskPauseReason)).not.toHaveBeenCalled();

    // The distinct reason code surfaced to the dashboard, not a generic
    // worktree_recreate_failed — lets the UI/operator recognize this as a
    // backend-health statement rather than a per-session error.
    const actionFailedMsg = emittedMessages.find(
      (m) => m.type === 'session_action_failed',
    );
    expect(actionFailedMsg?.reason).toBe(BACKEND_SPAWN_DEGRADED_REASON);
    expect(actionFailedMsg?.detail).toMatch(/restart/i);
  });

  it('poke-retry limit exhausted: routes to flagResumeFailure exactly once instead of retrying indefinitely', async () => {
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
    // The 3rd consecutive poke failure (N=3, per acceptance criteria).
    vi.mocked(incrementSessionPokeRetryCount).mockReturnValue(3);

    const result = await sm.sendOrResume(SESSION_ID, 'hello');

    expect(result).toBe(SESSION_ID);
    expect(vi.mocked(incrementTaskCrashCount)).not.toHaveBeenCalled();

    // flagResumeFailure's terminal disposition fires exactly once.
    expect(vi.mocked(updateSessionStatus)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateSessionStatus)).toHaveBeenCalledWith(
      SESSION_ID,
      'error',
      expect.any(Number),
    );
    // The write goes through the single status deriver's completing-signal
    // ledger, not a bare column write.
    expect(vi.mocked(insertCompletingSignal)).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: SESSION_ID,
        signal_class: 'resume_exhausted',
        signal_value: 'resume_failed',
      }),
    );
    expect(vi.mocked(setTaskPauseReason)).toHaveBeenCalledWith(
      'task-1',
      'resume_failed',
      expect.stringMatching(/restart/i),
    );

    const lastErrorDetailCall = vi
      .mocked(setSessionLastErrorDetail)
      .mock.calls.find((call) => call[0] === SESSION_ID);
    expect(lastErrorDetailCall?.[1]).toMatch(/restart/i);
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

  it('persistent lock error (all retries) → worktree_recreate_failed, routed through the poke-retry counter (not the crash budget)', async () => {
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
    // This live-poke failure path no longer feeds the task_crash_counts
    // circuit breaker directly — it goes through the session-scoped
    // poke-retry counter instead (see handlePokeFailure).
    expect(vi.mocked(incrementTaskCrashCount)).not.toHaveBeenCalled();
    expect(vi.mocked(incrementSessionPokeRetryCount)).toHaveBeenCalledWith(
      SESSION_ID,
    );
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

// ── start() — two same-titled tasks dispatched concurrently ───────────────

describe('start() — two same-titled tasks dispatched concurrently', () => {
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

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(fsModule.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
    vi.mocked((fsModule as any).default.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
    vi.mocked(loadOrchestratorConfig).mockReturnValue({ ...BASE_ORCH_CONFIG });

    // Restore the real title+id derivation for this describe block so the
    // two dispatches below actually diverge instead of both resolving to the
    // module-wide fixed mock value ('feature/my-task').
    vi.mocked(deriveBranchSlug).mockImplementation(
      (title: string, taskId?: string | null, prefix = 'feature') => {
        const slug = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        return taskId ? `${prefix}/${slug}-${taskId}` : `${prefix}/${slug}`;
      },
    );
  });

  it('same task_name, different task_id → distinct branch names, both launch (no isBranchAlreadyExists path)', async () => {
    const wtAddCommands: string[] = [];
    vi.mocked(execCb).mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).includes('worktree add')) wtAddCommands.push(cmd);
        callback(null, { stdout: '', stderr: '' });
      },
    );

    await Promise.all([
      sm.start('https://notion.so/task', 'https://notion.so/project', {
        projectId: PROJECT_ID,
        taskKind: 'non_milestone',
        taskName: 'Duplicate title task',
        taskId: 'task-id-one',
      }),
      sm.start('https://notion.so/task', 'https://notion.so/project', {
        projectId: PROJECT_ID,
        taskKind: 'non_milestone',
        taskName: 'Duplicate title task',
        taskId: 'task-id-two',
      }),
    ]);

    await vi.waitFor(() =>
      expect(vi.mocked(AgentSession)).toHaveBeenCalledTimes(2),
    );

    const branchArgs = vi
      .mocked(deriveBranchSlug)
      .mock.calls.map(([title, taskId]) => `${title}::${taskId}`);
    expect(new Set(branchArgs).size).toBe(branchArgs.length);

    const branchesUsed = wtAddCommands.map((cmd) => {
      const m = cmd.match(/-b "([^"]+)"/);
      return m?.[1];
    });
    expect(new Set(branchesUsed).size).toBe(2);

    // Neither dispatch hit the "A branch named ... already exists" recovery path.
    expect(vi.mocked(setSessionPauseReason)).not.toHaveBeenCalledWith(
      expect.any(String),
      'launch_failed',
    );
  });
});

// ── start() — pre-launch fetch serialization/coalescing (integration) ──────

describe('start() — pre-launch fetch serialization/coalescing (integration)', () => {
  let sm: SessionManager;

  const ORCH_CONFIG = {
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

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(fsModule.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
    vi.mocked((fsModule as any).default.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
    vi.mocked(loadOrchestratorConfig).mockReturnValue({ ...ORCH_CONFIG });
  });

  it('two launches for the same project issue one coalesced fetch and both sessions still launch', async () => {
    const projectDir = '/project-integ-same';
    vi.mocked(getProjectById).mockReturnValue({
      ...makeProject(),
      projectDir,
    });
    vi.mocked(execCb).mockImplementation(
      (_cmd: string, _opts: unknown, callback: any) => {
        setTimeout(() => callback(null, { stdout: '', stderr: '' }), 5);
      },
    );

    sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'non_milestone',
      taskName: 'task-a',
    });
    sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'non_milestone',
      taskName: 'task-b',
    });

    await vi.waitFor(() => expect(capturedSessions).toHaveLength(2));

    const fetchCalls = vi
      .mocked(execCb)
      .mock.calls.filter(([cmd]) => String(cmd).startsWith('git fetch'));
    expect(fetchCalls).toHaveLength(1);
  });

  it('launches for different projects still fetch concurrently', async () => {
    let fetchActive = 0;
    let fetchMaxActive = 0;
    vi.mocked(execCb).mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).startsWith('git fetch')) {
          fetchActive++;
          fetchMaxActive = Math.max(fetchMaxActive, fetchActive);
          setTimeout(() => {
            fetchActive--;
            callback(null, { stdout: '', stderr: '' });
          }, 15);
          return;
        }
        callback(null, { stdout: '', stderr: '' });
      },
    );
    vi.mocked(getProjectById).mockImplementation(
      (id: string) =>
        ({
          ...makeProject(),
          projectDir: `/project-integ-${id}`,
        }) as any,
    );

    sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: 'proj-a',
      taskKind: 'non_milestone',
      taskName: 'task-a',
    });
    sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: 'proj-b',
      taskKind: 'non_milestone',
      taskName: 'task-b',
    });

    await vi.waitFor(() => expect(capturedSessions).toHaveLength(2));

    expect(fetchMaxActive).toBe(2);
  });

  it('a fetch failure records a diagnosable signal but the session still launches', async () => {
    const projectDir = '/project-integ-fail';
    vi.mocked(getProjectById).mockReturnValue({
      ...makeProject(),
      projectDir,
    });
    vi.mocked(execCb).mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).startsWith('git fetch')) {
          const err = Object.assign(new Error('cmd failed'), {
            stderr:
              "error: cannot lock ref 'refs/remotes/origin/dev': is at ae9f9803 but expected 066b562e",
          });
          return callback(err);
        }
        callback(null, { stdout: '', stderr: '' });
      },
    );

    sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'non_milestone',
      taskName: 'task-fail',
    });

    await vi.waitFor(() => expect(capturedSessions).toHaveLength(1));

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'base_fetch_failed' }),
    );
    expect(vi.mocked(setSessionLastErrorDetail)).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('stale'),
    );
  });

  it('a benign lost ref-lock race on launch does not set a stale-base error or record base_fetch_failed', async () => {
    const projectDir = '/project-integ-benign-ref-lock';
    vi.mocked(getProjectById).mockReturnValue({
      ...makeProject(),
      projectDir,
    });
    vi.mocked(execCb).mockImplementation(
      (cmd: string, _opts: unknown, callback: any) => {
        if (String(cmd).startsWith('git fetch')) {
          const err = Object.assign(new Error('cmd failed'), {
            stderr:
              "error: cannot lock ref 'refs/remotes/origin/dev': is at fc7b2df8 but expected 863d2513",
          });
          return callback(err);
        }
        // The ref already holds the value the fetch wanted to write.
        callback(null, {
          stdout: 'fc7b2df8870355a1bb8b3cbb0eda4fac44f31456\n',
        });
      },
    );

    sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'non_milestone',
      taskName: 'task-benign',
    });

    await vi.waitFor(() => expect(capturedSessions).toHaveLength(1));

    expect(vi.mocked(recordEvent)).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'base_fetch_failed' }),
    );
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'base_fetch_ref_lock_benign' }),
    );
    expect(vi.mocked(setSessionLastErrorDetail)).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('stale'),
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
      required_env: [],
      required_files: [],
    } as any);
  });

  it.each(['groom', 'design'] as const)(
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

  it.each(['standard', 'ops'] as const)(
    'persists a real worktree_path for a %s session',
    async (sessionType) => {
      await sm.start('https://notion.so/task', 'https://notion.so/project', {
        projectId: PROJECT_ID,
        taskKind: 'non_milestone',
        taskName: 'my-task',
        sessionType,
      });

      expect(vi.mocked(insertSession)).toHaveBeenCalledWith(
        expect.objectContaining({
          worktree_path: expect.stringContaining('.claude/worktrees/'),
        }),
      );
    },
  );

  it('persists a real worktree_path for a docs session whose task declares a repo-file Target surface', async () => {
    await sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'milestone',
      taskName: 'my-task',
      sessionType: 'docs',
      docsTargetSurface: 'docs/api/webhooks.md',
    });

    expect(vi.mocked(insertSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree_path: expect.stringContaining('.claude/worktrees/'),
      }),
    );
  });

  it('persists worktree_path as null for a docs session whose task declares a Notion-page Target surface — regression guard', async () => {
    await sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'milestone',
      taskName: 'my-task',
      sessionType: 'docs',
      docsTargetSurface: '20a1b2c3-d4e5-4f60-8a1b-2c3d4e5f6071',
    });

    expect(vi.mocked(insertSession)).toHaveBeenCalledWith(
      expect.objectContaining({ worktree_path: null }),
    );
  });

  it('persists worktree_path as null for a docs session with no declared Target surface', async () => {
    await sm.start('https://notion.so/task', 'https://notion.so/project', {
      projectId: PROJECT_ID,
      taskKind: 'milestone',
      taskName: 'my-task',
      sessionType: 'docs',
    });

    expect(vi.mocked(insertSession)).toHaveBeenCalledWith(
      expect.objectContaining({ worktree_path: null }),
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
      required_env: [],
      required_files: [],
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

// ── start() — planning-flow dedup (regression: concurrent groom dispatch) ──

describe('start() — planning-flow dedup', () => {
  let sm: SessionManager;

  const PLANNING_START_OPTS = {
    projectId: PROJECT_ID,
    taskKind: 'milestone' as const,
    taskName: 'my-task',
  };

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(loadOrchestratorConfig).mockReturnValue({
      mcp_servers: undefined,
      allowed_tools: [],
      required_env: [],
      required_files: [],
    } as any);
    // clearAllMocks() clears call history but not implementations set by an
    // earlier test in this file — reset every planning-dedup predicate to
    // its "nothing holds this task" default before each test opts in.
    vi.mocked(hasActivePlanningSessionForTask).mockReturnValue(false);
  });

  it('rejects a second groom dispatch for the same task while the first is still running — the observed concurrent 68e8b7f6/c159505c pair', async () => {
    await sm.start('https://notion.so/task', 'https://notion.so/project', {
      ...PLANNING_START_OPTS,
      sessionType: 'groom',
    });
    await vi.waitFor(() => expect(vi.mocked(insertSession)).toHaveBeenCalled());

    // Second dispatch tick: a groom session for this task is now running.
    vi.mocked(hasActivePlanningSessionForTask).mockImplementation(
      (_taskId, flow) => flow === 'groom',
    );

    await expect(
      sm.start('https://notion.so/task', 'https://notion.so/project', {
        ...PLANNING_START_OPTS,
        sessionType: 'groom',
      }),
    ).rejects.toMatchObject({ alreadyRunning: true });
  });

  it('rejects a groom dispatch while a groom session is parked idle — idle blocks unconditionally, regardless of any undispositioned intent', async () => {
    vi.mocked(hasActivePlanningSessionForTask).mockImplementation(
      (_taskId, flow) => flow === 'groom',
    );

    await expect(
      sm.start('https://notion.so/task', 'https://notion.so/project', {
        ...PLANNING_START_OPTS,
        sessionType: 'groom',
      }),
    ).rejects.toMatchObject({ alreadyRunning: true });
  });

  it('admits a groom dispatch once the prior groom session has reached a terminal state', async () => {
    vi.mocked(hasActivePlanningSessionForTask).mockReturnValue(false);

    await sm.start('https://notion.so/task', 'https://notion.so/project', {
      ...PLANNING_START_OPTS,
      sessionType: 'groom',
    });

    expect(vi.mocked(insertSession)).toHaveBeenCalled();
  });

  it.each(['design', 'ops'] as const)(
    'rejects a second %s dispatch for the same task while a non-terminal %s session already holds it',
    async (sessionType) => {
      vi.mocked(hasActivePlanningSessionForTask).mockImplementation(
        (_taskId, flow) => flow === sessionType,
      );

      await expect(
        sm.start('https://notion.so/task', 'https://notion.so/project', {
          ...PLANNING_START_OPTS,
          sessionType,
        }),
      ).rejects.toMatchObject({ alreadyRunning: true });
    },
  );

  it('a done gate-verify ops session does not suppress a fresh ops re-verify dispatch', async () => {
    // hasActivePlanningSessionForTask already excludes 'done' sessions at the
    // query layer (see queries.ts) — a fresh ops dispatch for the same task
    // must not be blocked once the prior verify session is terminal.
    vi.mocked(hasActivePlanningSessionForTask).mockReturnValue(false);

    await sm.start('https://notion.so/task', 'https://notion.so/project', {
      ...PLANNING_START_OPTS,
      sessionType: 'ops',
    });

    expect(vi.mocked(insertSession)).toHaveBeenCalled();
  });
});
