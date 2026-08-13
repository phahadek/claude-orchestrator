import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks ──────────────────────────────────────────────────────────────
// Mirrors SessionManager.test.ts's mock shape, with two additions:
//  - db/queries gets a *stateful* addGrantedCapability/getGrantedCapabilities
//    pair so persisted-before-respawn ordering can actually be observed.
//  - orchestrator-config keeps loadOrchestratorConfig mocked (it reads a YAML
//    file from disk) but re-exports the real isGrantable/isToolShapedCapability/
//    getSessionAllowedTools so the denylist and tool-shape gating under test
//    are the real production logic, not a stand-in.

let capturedSessions: ReturnType<typeof makeMockSession>[] = [];

type MockSession = EventEmitter & {
  prUrl?: string;
  hasEnded: boolean;
  sessionType: string;
  taskId?: string;
  run: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  hasActiveTurn: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  endSession: ReturnType<typeof vi.fn>;
  gracefulPause: ReturnType<typeof vi.fn>;
  setPendingOverflowText: ReturnType<typeof vi.fn>;
  lockFileForNextInjection: ReturnType<typeof vi.fn>;
};

// Mirrors AgentSession's real _turnInFlight initialization: hasActiveTurn()
// starts at whatever hasInitialPrompt (the constructor's final positional
// arg) says, defaulting true like the real constructor. respawnSession
// always passes false — this lets tests observe the real wiring rather than
// a value hardcoded independent of the constructor call under test.
function makeMockSession(hasActiveTurnInitial = true): MockSession {
  const ee = new EventEmitter() as MockSession;
  ee.prUrl = undefined;
  ee.hasEnded = false;
  ee.sessionType = 'standard';
  ee.run = vi.fn().mockReturnValue(new Promise(() => {}));
  // Default: confirmed delivery — mirrors AgentSession.sendMessage's success
  // return when the underlying stdin write actually reached the process.
  ee.sendMessage = vi.fn().mockReturnValue(true);
  ee.hasActiveTurn = vi.fn().mockReturnValue(hasActiveTurnInitial);
  ee.kill = vi.fn().mockResolvedValue(undefined);
  ee.endSession = vi.fn();
  ee.gracefulPause = vi.fn().mockResolvedValue(undefined);
  ee.setPendingOverflowText = vi.fn();
  ee.lockFileForNextInjection = vi.fn();
  return ee;
}

vi.mock('../AgentSession', () => ({
  AgentSession: vi.fn().mockImplementation((...args: unknown[]) => {
    // Last positional constructor arg — see AgentSession's hasInitialPrompt param.
    const hasInitialPrompt = args[args.length - 1];
    const s = makeMockSession(
      typeof hasInitialPrompt === 'boolean' ? hasInitialPrompt : true,
    );
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
}));
vi.mock('../orchestrator-config', async () => {
  const actual = await vi.importActual<typeof import('../orchestrator-config')>(
    '../orchestrator-config',
  );
  return {
    ...actual,
    loadOrchestratorConfig: vi
      .fn()
      .mockReturnValue({ mcp_servers: undefined, allowed_tools: [] }),
  };
});
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

// Stateful capability store — keyed by sessionId — so the test can observe
// "persist, then respawn reads the committed value" rather than asserting on
// opaque mock-call args.
let grantedCapabilitiesStore: Map<string, string[]>;

vi.mock('../../db/queries', () => ({
  insertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateSessionWorktreePath: vi.fn(),
  markSessionDone: vi.fn(),
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
  enqueueFeedbackItem: vi.fn(),
  listUndeliveredInboxItems: vi.fn().mockReturnValue([]),
  markInboxItemsDelivered: vi.fn(),
  TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
  getUsageDeferral: vi.fn().mockReturnValue(null),
  getGrantedCapabilities: vi.fn(
    (sessionId: string) =>
      grantedCapabilitiesStore.get(sessionId)?.slice() ?? [],
  ),
  addGrantedCapability: vi.fn((sessionId: string, capability: string) => {
    const existing = grantedCapabilitiesStore.get(sessionId) ?? [];
    const next = existing.includes(capability)
      ? existing
      : [...existing, capability];
    grantedCapabilitiesStore.set(sessionId, next);
    return next;
  }),
}));

vi.mock('../../config', () => ({
  config: {},
  getProjectById: vi.fn(),
  normalizePath: vi.fn().mockImplementation((p: string) => p),
  runtimeSettings: {
    session_mode: 'cli',
    corporate_mode_enabled: false,
    max_concurrent_code_sessions: 5,
  },
  ALLOWED_TOOLS: ['Read', 'Grep', 'Glob'],
  GROOM_ALLOWED_TOOLS: ['Read', 'Grep', 'Glob'],
  DESIGN_ALLOWED_TOOLS: ['Read', 'Grep', 'Glob'],
  OPS_ALLOWED_TOOLS: ['Read', 'Grep', 'Glob'],
  NOTION_READ_MCP_TOOLS: [],
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

// Worktree + .git always present — exercises the surviving-worktree fast path.
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    readFileSync: vi.fn().mockReturnValue(''),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { SessionManager } from '../SessionManager';
import {
  getSession,
  addGrantedCapability,
  getGrantedCapabilities,
  listUndeliveredInboxItems,
  markInboxItemsDelivered,
} from '../../db/queries';
import { getProjectById } from '../../config';
import { AgentSession } from '../AgentSession';
import { getSessionAllowedTools } from '../orchestrator-config';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SESSION_ID = 'original-session-abc123';
const PROJECT_ID = 'project-1';
const PROJECT_DIR = '/project';

function makeRow(sessionId = SESSION_ID) {
  return {
    session_id: sessionId,
    task_id: 'task-1',
    task_name: 'my-task',
    task_url: 'https://notion.so/task',
    project_context_url: 'https://notion.so/project',
    project_id: PROJECT_ID,
    status: 'running',
    session_type: 'ops',
    pr_url: null,
    worktree_path: `${PROJECT_DIR}/.claude/worktrees/${sessionId}`,
    started_at: 1000,
    ended_at: null,
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

describe('grantCapability — takes effect on a live session', () => {
  let sm: SessionManager;

  beforeEach(async () => {
    capturedSessions = [];
    grantedCapabilitiesStore = new Map();
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  /** Registers SESSION_ID as a live in-memory session via the sendOrResume respawn path. */
  async function establishLiveSession(): Promise<void> {
    const p = sm.sendOrResume(SESSION_ID, 'boot');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    await p;
    vi.mocked(AgentSession).mockClear();
    vi.mocked(addGrantedCapability).mockClear();
  }

  it('respawns a live session, and the respawned allow-list contains the granted capability', async () => {
    await establishLiveSession();
    const originalSession = capturedSessions[capturedSessions.length - 1];

    await sm.grantCapability(SESSION_ID, 'Bash(sudo systemctl:*)');

    // Persisted.
    expect(vi.mocked(addGrantedCapability)).toHaveBeenCalledWith(
      SESSION_ID,
      'Bash(sudo systemctl:*)',
    );

    // Old process killed, a new AgentSession spawned in its place.
    expect(originalSession.kill).toHaveBeenCalledTimes(1);
    expect(vi.mocked(AgentSession)).toHaveBeenCalledTimes(1);

    // What AgentSession.run() would compute at spawn time now includes the grant.
    const allowed = getSessionAllowedTools(
      'ops',
      { allowed_tools: [] },
      getGrantedCapabilities(SESSION_ID),
    );
    expect(allowed).toContain('Bash(sudo systemctl:*)');
  });

  it('persists the grant before the respawn reads it', async () => {
    await establishLiveSession();

    await sm.grantCapability(SESSION_ID, 'Bash(sudo install:*)');

    const persistOrder =
      vi.mocked(addGrantedCapability).mock.invocationCallOrder[0];
    const respawnOrder = vi.mocked(AgentSession).mock.invocationCallOrder[0];
    expect(persistOrder).toBeLessThan(respawnOrder);

    // By the time the new AgentSession is constructed, the DB-backed capability
    // read (what AgentSession.run() itself calls) already reflects the grant.
    expect(getGrantedCapabilities(SESSION_ID)).toContain(
      'Bash(sudo install:*)',
    );
  });

  it('reuses the session id and resumes, preserving the same worktree', async () => {
    await establishLiveSession();

    await sm.grantCapability(SESSION_ID, 'Bash(sudo systemctl:*)');

    expect(vi.mocked(AgentSession)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(AgentSession).mock.calls[0];
    // constructor positional args: (sessionId, ..., worktreePath, taskId, resumeSessionId, ...)
    expect(call[0]).toBe(SESSION_ID); // sessionId
    expect(call[4]).toBe(`${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`); // worktreePath
    expect(call[6]).toBe(SESSION_ID); // resumeSessionId — passes --resume to the CLI

    // The session is still registered live under the same id.
    expect((sm as any).sessions.get(SESSION_ID)).toBe(
      capturedSessions[capturedSessions.length - 1],
    );
  });

  it('does not respawn or merge a capability matching GRANT_DENYLIST_PATTERNS', async () => {
    await establishLiveSession();
    const liveSession = capturedSessions[capturedSessions.length - 1];

    await sm.grantCapability(SESSION_ID, 'Bash(git apply:*)');

    // Still recorded for bookkeeping...
    expect(getGrantedCapabilities(SESSION_ID)).toContain('Bash(git apply:*)');
    // ...but never merged into the allow-list...
    const allowed = getSessionAllowedTools(
      'ops',
      { allowed_tools: [] },
      getGrantedCapabilities(SESSION_ID),
    );
    expect(allowed).not.toContain('Bash(git apply:*)');
    // ...and no respawn was triggered for it.
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
    expect(liveSession.kill).not.toHaveBeenCalled();
  });

  it('does not respawn or alter the allow-list for a non-tool-shaped grant', async () => {
    await establishLiveSession();
    const liveSession = capturedSessions[capturedSessions.length - 1];

    const capability = `read:session-record:${SESSION_ID}`;
    await sm.grantCapability(SESSION_ID, capability);

    expect(getGrantedCapabilities(SESSION_ID)).toContain(capability);
    const allowed = getSessionAllowedTools(
      'ops',
      { allowed_tools: [] },
      getGrantedCapabilities(SESSION_ID),
    );
    expect(allowed).not.toContain(capability);
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
    expect(liveSession.kill).not.toHaveBeenCalled();
  });

  it('does not respawn a session that is not currently live', async () => {
    // No establishLiveSession() — the session is not registered in-memory.
    await sm.grantCapability(SESSION_ID, 'Bash(sudo systemctl:*)');

    expect(vi.mocked(addGrantedCapability)).toHaveBeenCalledWith(
      SESSION_ID,
      'Bash(sudo systemctl:*)',
    );
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
  });
});

// ── regression: lone read-capability grant on a live-but-idle session ────────
// A non-tool-shaped grant (e.g. read:audit-log:*) never triggers
// grantCapability's respawn branch — the session's only route to a real turn
// is resumeCapabilityRequester's enqueueFeedback call. Previously, when the
// live session's direct stdin write silently failed (closed pipe / dead
// process), enqueueFeedback -> deliverUndeliveredInboxItems -> sendOrResume
// still returned "success" and the item was marked delivered, parking the
// session forever with no automatic recovery. It must now fall back to the
// same --resume respawn path grantCapability itself uses for tool-shaped
// grants.
describe('enqueueFeedback — lone capability-request approval on a live-but-idle session', () => {
  let sm: SessionManager;

  beforeEach(async () => {
    capturedSessions = [];
    grantedCapabilitiesStore = new Map();
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  async function establishLiveSession(): Promise<void> {
    const p = sm.sendOrResume(SESSION_ID, 'boot');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    await p;
    vi.mocked(AgentSession).mockClear();
  }

  const APPROVAL_MESSAGE =
    'Capability request approved: "read:audit-log:claude-dashboard" has been granted for this session.';

  it('falls back to a --resume respawn (a real turn starts) when the direct send to the live session fails', async () => {
    await establishLiveSession();
    const liveSession = capturedSessions[capturedSessions.length - 1];

    // Simulate the fire-and-forget stdin write silently failing — a closed
    // pipe or synchronous write() throw on an already-exited process.
    liveSession.sendMessage.mockReturnValue(false);

    vi.mocked(listUndeliveredInboxItems).mockReturnValue([
      {
        id: 1,
        session_id: SESSION_ID,
        source: 'operator-disposition',
        payload: APPROVAL_MESSAGE,
      } as any,
    ]);

    const feedbackPromise = sm.enqueueFeedback(
      SESSION_ID,
      'operator-disposition',
      APPROVAL_MESSAGE,
      { attemptTerminalResume: false },
    );

    // The failed direct send falls through into the respawn path.
    await vi.waitFor(() =>
      expect(vi.mocked(AgentSession)).toHaveBeenCalledTimes(1),
    );
    const resumedSession = capturedSessions[capturedSessions.length - 1];
    resumedSession.emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'resumed',
    });

    await feedbackPromise;

    // A real turn started on the resumed session with the capability message.
    expect(resumedSession.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('read:audit-log:claude-dashboard'),
    );
    // Only marked delivered once the respawn actually delivered it.
    expect(vi.mocked(markInboxItemsDelivered)).toHaveBeenCalledWith([1]);
  });

  it('delivers directly, with no respawn, when the direct send to the live session succeeds', async () => {
    await establishLiveSession();
    const liveSession = capturedSessions[capturedSessions.length - 1];

    vi.mocked(listUndeliveredInboxItems).mockReturnValue([
      {
        id: 2,
        session_id: SESSION_ID,
        source: 'operator-disposition',
        payload: APPROVAL_MESSAGE,
      } as any,
    ]);

    await sm.enqueueFeedback(
      SESSION_ID,
      'operator-disposition',
      APPROVAL_MESSAGE,
      { attemptTerminalResume: false },
    );

    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
    expect(liveSession.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('read:audit-log:claude-dashboard'),
    );
    expect(vi.mocked(markInboxItemsDelivered)).toHaveBeenCalledWith([2]);
  });
});

// ── regression: prompt-less capability-grant respawn vs enqueueFeedback's
// active-turn guard ───────────────────────────────────────────────────────
// resumeCapabilityRequester calls grantCapability() then enqueueFeedback()
// in sequence. For a tool-shaped capability, grantCapability's own respawn
// (respawnForCapabilityGrant -> respawnSession) kills the live process and
// constructs a fresh AgentSession with no initial prompt (--resume only).
// Before the fix, AgentSession's _turnInFlight always started true, so the
// respawned session's hasActiveTurn() lied about a turn being in flight and
// enqueueFeedback's live-session guard deferred forever — the message was
// never delivered because no turn boundary could ever occur. The fix makes
// hasActiveTurn() reflect reality (false immediately after a prompt-less
// respawn), so enqueueFeedback falls through to deliverUndeliveredInboxItems
// and actually delivers.
describe('grantCapability + enqueueFeedback — tool-shaped grant respawn does not deadlock', () => {
  let sm: SessionManager;

  beforeEach(async () => {
    capturedSessions = [];
    grantedCapabilitiesStore = new Map();
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  async function establishLiveSession(): Promise<void> {
    const p = sm.sendOrResume(SESSION_ID, 'boot');
    await vi.waitFor(() => expect(capturedSessions.length).toBeGreaterThan(0));
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    await p;
    vi.mocked(AgentSession).mockClear();
  }

  const GRANT_MESSAGE =
    'Capability request approved: "Bash(sudo systemctl:*)" has been granted for this session.';

  it('delivers the feedback item (not left pending) after a tool-shaped grant respawns the session', async () => {
    await establishLiveSession();

    // grantCapability respawns: kills the live session, constructs a fresh
    // AgentSession with hasInitialPrompt=false (no prompt sent at spawn).
    await sm.grantCapability(SESSION_ID, 'Bash(sudo systemctl:*)');
    expect(vi.mocked(AgentSession)).toHaveBeenCalledTimes(1);
    const respawnedSession = capturedSessions[capturedSessions.length - 1];

    // The respawned session correctly reports no turn in flight — nothing
    // was actually sent to it yet.
    expect(respawnedSession.hasActiveTurn()).toBe(false);

    vi.mocked(listUndeliveredInboxItems).mockReturnValue([
      {
        id: 3,
        session_id: SESSION_ID,
        source: 'operator-disposition',
        payload: GRANT_MESSAGE,
      } as any,
    ]);

    await sm.enqueueFeedback(SESSION_ID, 'operator-disposition', GRANT_MESSAGE);

    // enqueueFeedback did not bail out at the active-turn guard: it delivered
    // directly to the (now live) respawned session and marked the item done.
    expect(respawnedSession.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Bash(sudo systemctl:*)'),
    );
    expect(vi.mocked(markInboxItemsDelivered)).toHaveBeenCalledWith([3]);
  });
});
