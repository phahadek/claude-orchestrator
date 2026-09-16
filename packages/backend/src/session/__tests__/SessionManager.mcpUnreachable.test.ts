import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks ──────────────────────────────────────────────────────────────
// Mirrors SessionManager.grantCapability.test.ts's mock shape exactly — that
// file exercises the same suppress-reap/--resume respawn primitive
// (respawnSession) for a different trigger (capability grant); this file
// exercises it for reconcileMcpUnreachableSessions / respawnForMcpUnreachable.

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

function makeMockSession(hasActiveTurnInitial = true): MockSession {
  const ee = new EventEmitter() as MockSession;
  ee.prUrl = undefined;
  ee.hasEnded = false;
  ee.sessionType = 'standard';
  ee.run = vi.fn().mockReturnValue(new Promise(() => {}));
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
    const hasInitialPrompt = args[args.length - 1];
    const s = makeMockSession(
      typeof hasInitialPrompt === 'boolean' ? hasInitialPrompt : true,
    );
    capturedSessions.push(s);
    return s;
  }),
  parseNotionPageIdDashed: vi.fn().mockReturnValue(''),
  isMcpUnreachable: (params: {
    orchestratorMcpStatus: string | undefined;
    nowMs: number;
    lastSpawnMs: number;
    graceMs: number;
  }) => {
    if (params.orchestratorMcpStatus !== undefined) {
      return params.orchestratorMcpStatus !== 'connected';
    }
    return params.nowMs - params.lastSpawnMs >= params.graceMs;
  },
}));

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({})),
  PreSpawnConfigError: class PreSpawnConfigError extends Error {},
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

// Stateful MCP-unreachable bookkeeping — keyed by sessionId — mirroring
// grantCapability.test.ts's grantedCapabilitiesStore pattern, so the
// reconciler's real query calls read whatever the test set up.
let mcpOrchestratorStatus: Record<string, string | undefined>;
let mcpRespawnAttempts: Record<string, number>;
let mcpLatestRespawnTs: Record<string, number | null>;
let mcpExhausted: Record<string, boolean>;
let liveSessionRows: any[];

vi.mock('../../db/queries', () => ({
  insertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateSessionWorktreePath: vi.fn(),
  setSessionDocsTargetSurface: vi.fn(),
  getSessionDocsTargetSurface: vi.fn().mockReturnValue(undefined),
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
  getGrantedCapabilities: vi.fn().mockReturnValue([]),
  addGrantedCapability: vi.fn(),
  insertCompletingSignal: vi.fn(),
  listCompletingSignalsForSession: vi.fn().mockReturnValue([]),
  setSessionTerminalCompletionReason: vi.fn(),
  incrementSessionPokeRetryCount: vi.fn().mockReturnValue(1),
  resetSessionPokeRetryCount: vi.fn(),
  expireStagedIntentsForSession: vi.fn(),
  reapStagedIntentsForNeverStagedSession: vi.fn(() => 0),
  listLiveSessionRows: vi.fn(() => liveSessionRows),
  countMcpUnreachableRespawnAttempts: vi.fn(
    (sessionId: string) => mcpRespawnAttempts[sessionId] ?? 0,
  ),
  getMcpUnreachableSweepFacts: vi.fn((sessionIds: string[]) => {
    const facts = new Map<
      string,
      { exhausted: boolean; lastRespawnTs: number | null }
    >();
    for (const id of sessionIds) {
      facts.set(id, {
        exhausted: mcpExhausted[id] ?? false,
        lastRespawnTs: mcpLatestRespawnTs[id] ?? null,
      });
    }
    return facts;
  }),
  getOrchestratorMcpStatusEventsForSessions: vi.fn((sessionIds: string[]) => {
    const events = new Map<
      string,
      { ts: number; status: string | undefined }[]
    >();
    for (const id of sessionIds) {
      if (mcpOrchestratorStatus[id] !== undefined) {
        events.set(id, [
          { ts: Number.MAX_SAFE_INTEGER, status: mcpOrchestratorStatus[id] },
        ]);
      }
    }
    return events;
  }),
  resolveLatestOrchestratorMcpStatus: vi.fn(
    (events: { ts: number; status: string | undefined }[] | undefined) =>
      events && events.length > 0 ? events[0].status : undefined,
  ),
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
  setSessionPauseReason,
  listLiveSessionRows,
  getMcpUnreachableSweepFacts,
  getOrchestratorMcpStatusEventsForSessions,
} from '../../db/queries';
import { getProjectById, runtimeSettings } from '../../config';
import { AgentSession } from '../AgentSession';
import { recordEvent } from '../../audit/AuditLog';
import fs from 'fs';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SESSION_ID = 'original-session-abc123';
const PROJECT_ID = 'project-1';
const PROJECT_DIR = '/project';
const GRACE_MS = 3 * 60_000;

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: SESSION_ID,
    task_id: 'task-1',
    task_name: 'my-task',
    task_url: 'https://notion.so/task',
    project_context_url: 'https://notion.so/project',
    project_id: PROJECT_ID,
    status: 'running',
    session_type: 'ops',
    pr_url: null,
    worktree_path: `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
    started_at: Date.now() - GRACE_MS - 60_000,
    ended_at: null,
    ...overrides,
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

describe('reconcileMcpUnreachableSessions', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mcpOrchestratorStatus = {};
    mcpRespawnAttempts = {};
    mcpLatestRespawnTs = {};
    mcpExhausted = {};
    liveSessionRows = [];
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('does not fire inside the startup grace window', async () => {
    liveSessionRows = [makeRow({ started_at: Date.now() - 1000 })];

    const result = await sm.reconcileMcpUnreachableSessions();

    expect(result.detected).toEqual([]);
    expect(result.respawned).toEqual([]);
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
  });

  it('does not fire for a session whose init reports the orchestrator server connected', async () => {
    liveSessionRows = [makeRow()];
    mcpOrchestratorStatus[SESSION_ID] = 'connected';

    const result = await sm.reconcileMcpUnreachableSessions();

    expect(result.detected).toEqual([]);
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
  });

  it('fires for a session whose init reports the orchestrator server failed, even inside what would otherwise be the grace window', async () => {
    // A connection may have opened and immediately closed with an error —
    // the init-reported status is authoritative regardless of connection
    // history or elapsed time since spawn.
    liveSessionRows = [makeRow({ started_at: Date.now() - 1000 })];
    mcpOrchestratorStatus[SESSION_ID] = 'failed';

    const result = await sm.reconcileMcpUnreachableSessions();

    expect(result.detected).toEqual([SESSION_ID]);
  });

  it('detects and respawns in place, past the grace window with no connection', async () => {
    liveSessionRows = [makeRow()];

    const result = await sm.reconcileMcpUnreachableSessions();

    expect(result.detected).toEqual([SESSION_ID]);
    expect(result.respawned).toEqual([SESSION_ID]);

    // Same session id, --resume — respawnSession's resumeSessionId arg.
    expect(vi.mocked(AgentSession)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(AgentSession).mock.calls[0];
    expect(call[0]).toBe(SESSION_ID);
    expect(call[6]).toBe(SESSION_ID);

    const eventTypes = vi
      .mocked(recordEvent)
      .mock.calls.map((c) => c[0].event_type);
    expect(eventTypes).toContain('session_mcp_unreachable_detected');
    expect(eventTypes).toContain('session_mcp_unreachable_respawned');
    const respawnedEvent = vi
      .mocked(recordEvent)
      .mock.calls.find(
        (c) => c[0].event_type === 'session_mcp_unreachable_respawned',
      )![0];
    expect(respawnedEvent.actor_id).toBe(SESSION_ID);
    expect((respawnedEvent.payload as any).attempt_number).toBe(1);
  });

  it('does not touch task pause reason on a successful respawn', async () => {
    liveSessionRows = [makeRow()];

    await sm.reconcileMcpUnreachableSessions();

    expect(vi.mocked(setSessionPauseReason)).not.toHaveBeenCalled();
  });

  it('declines the respawn cleanly when the worktree is missing, without erroring', async () => {
    liveSessionRows = [makeRow()];
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = await sm.reconcileMcpUnreachableSessions();

    expect(result.detected).toEqual([SESSION_ID]);
    expect(result.respawned).toEqual([]);
    expect(result.declined).toEqual([SESSION_ID]);
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();

    const declinedEvent = vi
      .mocked(recordEvent)
      .mock.calls.find(
        (c) => c[0].event_type === 'session_mcp_unreachable_respawn_declined',
      )![0];
    expect(declinedEvent.actor_id).toBe(SESSION_ID);
    expect((declinedEvent.payload as any).reason).toBe('worktree_missing');
    expect((declinedEvent.payload as any).attempt_number).toBe(1);
  });

  it('never detects a permanently idle, worktree-less session across repeated sweeps', async () => {
    liveSessionRows = [makeRow({ status: 'idle' })];
    vi.mocked(fs.existsSync).mockReturnValue(false);

    for (let i = 0; i < 3; i++) {
      const result = await sm.reconcileMcpUnreachableSessions();
      expect(result.detected).toEqual([]);
      expect(result.skippedNotRespawnable).toBe(1);
    }

    const eventTypes = vi
      .mocked(recordEvent)
      .mock.calls.map((c) => c[0].event_type);
    expect(eventTypes).not.toContain('session_mcp_unreachable_detected');
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
  });

  it('records a declined respawn as an attempt so a permanently un-respawnable session reaches exhaustion and is then skipped forever', async () => {
    liveSessionRows = [makeRow()];
    vi.mocked(fs.existsSync).mockReturnValue(false);

    // Sweep 1: detected + declined, attempt 1.
    let result = await sm.reconcileMcpUnreachableSessions();
    expect(result.detected).toEqual([SESSION_ID]);
    expect(result.declined).toEqual([SESSION_ID]);
    expect(result.exhausted).toEqual([]);
    mcpRespawnAttempts[SESSION_ID] = 1; // persisted decline counted as an attempt

    // Sweep 2: detected + declined again, attempt 2 — reaches
    // MAX_MCP_UNREACHABLE_RESPAWNS worth of declined attempts.
    result = await sm.reconcileMcpUnreachableSessions();
    expect(result.detected).toEqual([SESSION_ID]);
    expect(result.declined).toEqual([SESSION_ID]);
    expect(result.exhausted).toEqual([]);
    mcpRespawnAttempts[SESSION_ID] = 2;

    // Sweep 3: attemptsSoFar (2) >= MAX_MCP_UNREACHABLE_RESPAWNS — exhausted,
    // paused, no further respawn attempt.
    result = await sm.reconcileMcpUnreachableSessions();
    expect(result.detected).toEqual([SESSION_ID]);
    expect(result.exhausted).toEqual([SESSION_ID]);
    expect(vi.mocked(setSessionPauseReason)).toHaveBeenCalledWith(
      SESSION_ID,
      'mcp_unreachable_exhausted',
    );
    mcpExhausted[SESSION_ID] = true; // persisted exhaustion event

    // Sweep 4+: skipped entirely — no audit rows at all.
    vi.mocked(recordEvent).mockClear();
    result = await sm.reconcileMcpUnreachableSessions();
    expect(result.detected).toEqual([]);
    expect(result.exhausted).toEqual([]);
    expect(result.skippedNotRespawnable).toBe(1);
    expect(vi.mocked(recordEvent)).not.toHaveBeenCalled();
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
  });

  it('items_processed reflects actions (respawned + exhausted), not the number of rows examined or detected', async () => {
    const SESSION_A = 'sess-a-respawns';
    const SESSION_B = 'sess-b-declines';
    const rowA = makeRow({
      session_id: SESSION_A,
      task_id: 'task-a',
      worktree_path: `${PROJECT_DIR}/.claude/worktrees/${SESSION_A}`,
    });
    const rowB = makeRow({
      session_id: SESSION_B,
      task_id: 'task-b',
      worktree_path: `${PROJECT_DIR}/.claude/worktrees/${SESSION_B}`,
    });
    liveSessionRows = [rowA, rowB];
    vi.mocked(getSession).mockImplementation(
      (id: string) => [rowA, rowB].find((r) => r.session_id === id) as any,
    );
    vi.mocked(fs.existsSync).mockImplementation(
      (p: unknown) => !String(p).includes(SESSION_B),
    );

    const result = await sm.reconcileMcpUnreachableSessions();

    expect([...result.detected].sort()).toEqual([SESSION_A, SESSION_B].sort());
    expect(result.respawned).toEqual([SESSION_A]);
    expect(result.declined).toEqual([SESSION_B]);
    expect(result.exhausted).toEqual([]);
    expect(result.itemsProcessed).toBe(1);
  });

  it('surfaces to the operator at the respawn cap instead of respawning again', async () => {
    liveSessionRows = [makeRow()];
    mcpRespawnAttempts[SESSION_ID] = 2; // already at MAX_MCP_UNREACHABLE_RESPAWNS
    mcpLatestRespawnTs[SESSION_ID] = Date.now() - GRACE_MS - 60_000;

    const result = await sm.reconcileMcpUnreachableSessions();

    expect(result.exhausted).toEqual([SESSION_ID]);
    expect(result.respawned).toEqual([]);
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
    expect(vi.mocked(setSessionPauseReason)).toHaveBeenCalledWith(
      SESSION_ID,
      'mcp_unreachable_exhausted',
    );
    const eventTypes = vi
      .mocked(recordEvent)
      .mock.calls.map((c) => c[0].event_type);
    expect(eventTypes).toContain('session_mcp_unreachable_respawn_exhausted');
  });

  it('does not count a prior respawn as a successful recovery when its own init still does not report connected, and escalates once the budget is spent', async () => {
    liveSessionRows = [makeRow()];
    mcpRespawnAttempts[SESSION_ID] = 2; // already at MAX_MCP_UNREACHABLE_RESPAWNS
    mcpLatestRespawnTs[SESSION_ID] = Date.now() - GRACE_MS - 60_000;
    mcpOrchestratorStatus[SESSION_ID] = 'failed'; // the respawned process's own init still failed

    const result = await sm.reconcileMcpUnreachableSessions();

    expect(result.detected).toEqual([SESSION_ID]);
    expect(result.respawned).toEqual([]);
    expect(result.exhausted).toEqual([SESSION_ID]);
    expect(vi.mocked(setSessionPauseReason)).toHaveBeenCalledWith(
      SESSION_ID,
      'mcp_unreachable_exhausted',
    );
  });

  it('clears the condition once the respawned session reports connected', async () => {
    liveSessionRows = [makeRow()];
    mcpRespawnAttempts[SESSION_ID] = 1;
    mcpLatestRespawnTs[SESSION_ID] = Date.now() - GRACE_MS - 60_000;
    mcpOrchestratorStatus[SESSION_ID] = 'connected';

    const result = await sm.reconcileMcpUnreachableSessions();

    expect(result.detected).toEqual([]);
    expect(result.respawned).toEqual([]);
    expect(result.exhausted).toEqual([]);
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
  });

  it('never re-surfaces a session once already exhausted', async () => {
    liveSessionRows = [makeRow()];
    mcpExhausted[SESSION_ID] = true;

    const result = await sm.reconcileMcpUnreachableSessions();

    expect(result.detected).toEqual([]);
    expect(result.exhausted).toEqual([]);
  });

  it('hits the DB with a bounded number of statements per sweep regardless of live-row count', async () => {
    liveSessionRows = Array.from({ length: 25 }, (_, i) =>
      makeRow({ session_id: `sess-${i}`, task_id: `task-${i}` }),
    );

    await sm.reconcileMcpUnreachableSessions();

    expect(vi.mocked(listLiveSessionRows)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getMcpUnreachableSweepFacts)).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(getOrchestratorMcpStatusEventsForSessions),
    ).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileMcpUnreachableSessions — api session_mode', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mcpOrchestratorStatus = {};
    mcpRespawnAttempts = {};
    mcpLatestRespawnTs = {};
    mcpExhausted = {};
    liveSessionRows = [];
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('does not run when session_mode is api', async () => {
    (runtimeSettings as { session_mode: string }).session_mode = 'api';
    liveSessionRows = [makeRow()];

    const result = await sm.reconcileMcpUnreachableSessions();

    expect(result.detected).toEqual([]);
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();

    (runtimeSettings as { session_mode: string }).session_mode = 'cli';
  });
});
