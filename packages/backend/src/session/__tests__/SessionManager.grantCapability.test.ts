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
  TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
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
