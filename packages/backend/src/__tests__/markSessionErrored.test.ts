/**
 * Unit tests for SessionManager.markSessionErrored().
 *
 * AC coverage:
 * - Helper exists and is the single owner of DB status + Notion task status + WS broadcast
 * - All causes except user_kill/pr_closed use crash budget: crash #1 → 🗂️ Ready, crash #2+ → 🚫 Blocked
 * - Uncounted causes (user_kill, pr_closed) → 🗂️ Ready, counter untouched
 * - Blocked path writes task_pause_reasons row + emits auto_launch_paused broadcast + audit
 * - session_ended WS broadcast fires from the helper
 * - audit_log event captures the cause
 * - Notion updateStatus failures are logged but not re-thrown
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from './helpers/mockDbQueries';
import type { ServerMessage } from '../ws/types';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue('dev\n'),
    execFile: vi.fn(),
    spawn: vi.fn(),
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(true),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn().mockReturnValue(''),
      statSync: vi.fn().mockReturnValue({ isFile: () => false }),
    },
    existsSync: vi.fn().mockReturnValue(true),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(''),
    statSync: vi.fn().mockReturnValue({ isFile: () => false }),
  };
});

vi.mock('../config', () => ({
  config: {},
  runtimeSettings: { session_mode: 'cli', max_concurrent_code_sessions: 10 },
  getProjectById: vi.fn().mockReturnValue({
    id: 'test-proj',
    name: 'Test Project',
    projectDir: '/tmp/test',
    taskSource: 'notion',
    autoLaunchEnabled: false,
    boards: [],
  }),
  normalizePath: (p: string) => p,
  ALLOWED_TOOLS: [],
}));

vi.mock('../orchestration/memoryAdmission', () => ({
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

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(),
}));

vi.mock('../db/queries', () =>
  mockDbQueries({
    getGrantedCapabilities: vi.fn(() => []),
    insertSession: vi.fn(),
    updateSessionStatus: vi.fn(),
    getSession: vi.fn(),
    getSessionsByStatus: vi.fn().mockReturnValue([]),
    getPRByNotionTaskId: vi.fn().mockReturnValue(null),
    getPRByNumber: vi.fn().mockReturnValue(null),
    getPRBySessionId: vi.fn().mockReturnValue(null),
    insertEvent: vi.fn(),
    getEventsBySession: vi.fn().mockReturnValue([]),
    hasActiveSessionForTask: vi.fn().mockReturnValue(false),
    getSetting: vi.fn().mockReturnValue(null),
    getStuckResultSessionRows: vi.fn().mockReturnValue([]),
    incrementTaskCrashCount: vi.fn().mockReturnValue(1),
    resetTaskCrashCount: vi.fn(),
    setTaskPauseReason: vi.fn(),
    setSessionLastErrorDetail: vi.fn(),
    setSessionTerminalCompletionReason: vi.fn(),
    hasStagedIntentForTask: vi.fn().mockReturnValue(true),
  }),
);

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('error'),
}));

vi.mock('../notion/NotionClient', () => ({
  parseSection: vi.fn().mockReturnValue(''),
}));

vi.mock('../session/AgentSession', () => ({
  AgentSession: vi.fn().mockImplementation(() => ({
    sessionType: 'standard',
    taskId: 'task-id',
    prUrl: null,
    hasEnded: false,
    on: vi.fn(),
    run: vi.fn().mockReturnValue(new Promise(() => {})),
  })),
  parseNotionPageIdDashed: vi.fn().mockImplementation((url: string) => url),
  parseNotionPageId: vi.fn().mockImplementation((url: string) => url),
}));

vi.mock('../session/orchestrator-config', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    allowedTools: [],
    verify: [],
    bash_rules: [],
    bootstrap_script: null,
  }),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue(''),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue(''),
}));

vi.mock('../session/CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../session/ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../session/DockerSessionRunner', () => ({
  DockerSessionRunner: vi.fn().mockImplementation(() => ({})),
  reapOrphanContainers: vi.fn(),
}));

vi.mock('../config/corporateMode', () => ({
  getCorporateMode: vi.fn().mockReturnValue({
    gates: { dockerMandatory: false, requireZDR: false },
  }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { SessionManager } from '../session/SessionManager';
import * as queries from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import { emitTaskUpdated } from '../routes/tasks';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { ServerMessage } from '../ws/types';
import { db } from '../db/db.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'test-session',
    task_id: 'notion-task-id',
    task_url: 'https://notion.so/task',
    project_context_url: 'https://notion.so/ctx',
    project_id: 'test-proj',
    status: 'running',
    started_at: 1_000_000,
    ended_at: null,
    pr_url: null,
    worktree_path: '/tmp/worktree',
    session_type: 'standard',
    note: null,
    tags: null,
    model: null,
    task_name: 'test-task',
    archived: 0,
    favorited: 0,
    ...overrides,
  };
}

function setupFakeBackend(
  updateStatusImpl = vi.fn().mockResolvedValue(undefined),
) {
  vi.mocked(getTaskBackend).mockReturnValue({
    updateStatus: updateStatusImpl,
    fetchTaskPage: vi.fn().mockResolvedValue(''),
  } as never);
  return updateStatusImpl;
}

let nextStagedIntentId = 0;

/** Stages a real staged_intent row (real in-memory db — this file's db/queries
 * mock spreads actual exports) so reap behavior can be asserted on real state. */
function stageIntent(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): string {
  const id = `intent-${++nextStagedIntentId}`;
  queries.insertStagedIntent({
    id,
    kind: 'task.setStatus',
    payload: '{}',
    payload_hash: 'hash',
    task_id: null,
    project_id: 'test-proj',
    session_id: sessionId,
    group_id: null,
    milestone: null,
    state: 'staged',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    investigation: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    applied_task_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  } as never);
  return id;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionManager.markSessionErrored() — DB update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    setupFakeBackend();
  });

  it('calls updateSessionStatus with the provided status', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'test-session',
      'error',
      expect.any(Number),
    );
  });

  it('calls updateSessionStatus with "killed" for kill paths', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill');
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'test-session',
      'killed',
      expect.any(Number),
    );
  });
});

describe('SessionManager.markSessionErrored() — terminal_completion_reason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    setupFakeBackend();
  });

  it('persists terminal_completion_reason equal to the provided reason', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    expect(queries.setSessionTerminalCompletionReason).toHaveBeenCalledWith(
      'test-session',
      'runner_non_zero',
    );
  });

  it('persists the reason for a killed status too', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill');
    expect(queries.setSessionTerminalCompletionReason).toHaveBeenCalledWith(
      'test-session',
      'user_kill',
    );
  });
});

describe('SessionManager.markSessionErrored() — last_error_detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    setupFakeBackend();
  });

  it('persists the detail via setSessionLastErrorDetail when provided', () => {
    const sm = new SessionManager();
    sm.markSessionErrored(
      'test-session',
      'error',
      'run_error',
      'boom: SIGSEGV',
    );
    expect(queries.setSessionLastErrorDetail).toHaveBeenCalledWith(
      'test-session',
      'boom: SIGSEGV',
    );
  });

  it('does not write a detail when none is provided', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    expect(queries.setSessionLastErrorDetail).not.toHaveBeenCalled();
  });
});

describe('SessionManager.markSessionErrored() — WS broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    setupFakeBackend();
  });

  it('emits session_ended with the correct sessionId and status', () => {
    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');

    const ended = messages.filter((m) => m.type === 'session_ended');
    expect(ended).toHaveLength(1);
    expect((ended[0] as { sessionId: string; status: string }).sessionId).toBe(
      'test-session',
    );
    expect((ended[0] as { status: string }).status).toBe('error');
  });

  it('emits session_ended with "killed" status for user_kill cause', () => {
    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    sm.markSessionErrored('test-session', 'killed', 'user_kill');

    const ended = messages.filter((m) => m.type === 'session_ended');
    expect(ended).toHaveLength(1);
    expect((ended[0] as { status: string }).status).toBe('killed');
  });
});

describe('SessionManager.markSessionErrored() — audit_log event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    setupFakeBackend();
  });

  it('records a session_errored audit event capturing the cause', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_errored',
        actor_id: 'test-session',
        payload: expect.objectContaining({
          reason: 'runner_non_zero',
          status: 'error',
        }),
      }),
    );
  });

  it('includes sessionId in the audit payload', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('my-session-id', 'killed', 'user_kill');

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ sessionId: 'my-session-id' }),
      }),
    );
  });
});

describe('SessionManager.markSessionErrored() — per-cause Notion status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
  });

  it('sets Notion status to 🗂️ Ready for runner_non_zero (first crash)', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(1);
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🗂️ Ready',
      expect.anything(),
    );
  });

  it('sets Notion status to 🚫 Blocked for runner_non_zero (second consecutive crash)', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(2);
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🚫 Blocked',
      expect.anything(),
    );
  });

  it('sets Notion status to 🗂️ Ready for user_kill', async () => {
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🗂️ Ready',
      expect.anything(),
    );
  });

  it('sets Notion status to 🗂️ Ready for worktree_missing (first crash)', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(1);
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'worktree_missing');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🗂️ Ready',
      expect.anything(),
    );
  });

  it('sets Notion status to 🗂️ Ready for launch_failed (first failure — never auto-blocks)', async () => {
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'launch_failed');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🗂️ Ready',
      expect.anything(),
    );
  });

  it('sets Notion status to 🗂️ Ready for launch_failed (second consecutive — never 🚫 Blocked)', async () => {
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'launch_failed');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🗂️ Ready',
      expect.anything(),
    );
  });

  it('sets Notion status to 🗂️ Ready for pr_closed (operator-intentional)', async () => {
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'pr_closed');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🗂️ Ready',
      expect.anything(),
    );
  });

  it('sets Notion status to 🗂️ Ready for run_error (first crash)', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(1);
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'run_error');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🗂️ Ready',
      expect.anything(),
    );
  });
});

describe('SessionManager.markSessionErrored() — Notion failure tolerance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
  });

  it('does not throw when Notion updateStatus rejects', async () => {
    setupFakeBackend(vi.fn().mockRejectedValue(new Error('Notion API down')));
    const sm = new SessionManager();

    await expect(
      (async () => {
        sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
        await new Promise((r) => setTimeout(r, 10));
      })(),
    ).resolves.not.toThrow();
  });

  it('still updates DB and emits session_ended even when Notion fails', async () => {
    setupFakeBackend(vi.fn().mockRejectedValue(new Error('Notion down')));

    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 10));

    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'test-session',
      'error',
      expect.any(Number),
    );
    expect(messages.find((m) => m.type === 'session_ended')).toBeDefined();
  });
});

describe('SessionManager.markSessionErrored() — session_type guard', () => {
  it('does not update Notion for review sessions', async () => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ session_type: 'review' }) as never,
    );
    const mockUpdate = setupFakeBackend();

    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not update Notion when session has no task_id', async () => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ task_id: null }) as never,
    );
    const mockUpdate = setupFakeBackend();

    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not update Notion when getSession returns null', async () => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(null as never);
    const mockUpdate = setupFakeBackend();

    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 10));

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('SessionManager.markSessionErrored() — planning session (design) crash path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ session_type: 'design' }) as never,
    );
  });

  it('reverts the design target to 🔲 Backlog and does NOT surface on first crash', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(1);
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 0));

    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🔲 Backlog',
      expect.anything(),
    );
    expect(queries.setTaskPauseReason).not.toHaveBeenCalled();
    expect(
      messages.find((m) => m.type === 'auto_launch_paused'),
    ).toBeUndefined();
  });

  it('surfaces needs_attention (planning_crashed) on the second consecutive crash', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(2);
    setupFakeBackend();
    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 0));

    expect(queries.setTaskPauseReason).toHaveBeenCalledWith(
      'notion-task-id',
      'planning_crashed',
      'runner_non_zero',
    );
    const paused = messages.find((m) => m.type === 'auto_launch_paused') as
      | { reason: string; taskId: string }
      | undefined;
    expect(paused).toBeDefined();
    expect(paused!.reason).toBe('planning_crashed');
    expect(paused!.taskId).toBe('notion-task-id');
  });

  it('surfaces planning_terminal_no_decision when no attempt ever staged an intent', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(2);
    vi.mocked(queries.hasStagedIntentForTask).mockReturnValueOnce(false);
    setupFakeBackend();
    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 0));

    expect(queries.setTaskPauseReason).toHaveBeenCalledWith(
      'notion-task-id',
      'planning_terminal_no_decision',
      'runner_non_zero',
    );
    const paused = messages.find((m) => m.type === 'auto_launch_paused') as
      | { reason: string; taskId: string }
      | undefined;
    expect(paused).toBeDefined();
    expect(paused!.reason).toBe('planning_terminal_no_decision');
    expect(paused!.taskId).toBe('notion-task-id');
  });

  it('never redirects a groom session target (never left Backlog, nothing to revert)', async () => {
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ session_type: 'groom' }) as never,
    );
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(1);
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();

    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 0));

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does NOT count user_kill against the planning crash budget or revert', async () => {
    setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill');
    await new Promise((r) => setTimeout(r, 0));

    expect(queries.incrementTaskCrashCount).not.toHaveBeenCalled();
    expect(queries.setTaskPauseReason).not.toHaveBeenCalled();
  });
});

describe('SessionManager.markSessionErrored() — planning session (ops) crash path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ session_type: 'ops' }) as never,
    );
  });

  it('reverts the ops target to 🗂️ Ready (not Backlog) on first crash', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(1);
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();

    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 0));

    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🗂️ Ready',
      expect.anything(),
    );
  });
});

describe('SessionManager.markSessionErrored() — task_status_changed + emitTaskUpdated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
  });

  it('broadcasts task_status_changed with 🚫 Blocked on second crash', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(2);
    setupFakeBackend();
    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 0));

    const changed = messages.find((m) => m.type === 'task_status_changed') as
      | { newStatus: string }
      | undefined;
    expect(changed).toBeDefined();
    expect(changed!.newStatus).toBe('🚫 Blocked');
  });

  it('broadcasts task_status_changed with 🗂️ Ready on first crash', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(1);
    setupFakeBackend();
    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 0));

    const changed = messages.find((m) => m.type === 'task_status_changed') as
      | { newStatus: string }
      | undefined;
    expect(changed).toBeDefined();
    expect(changed!.newStatus).toBe('🗂️ Ready');
  });

  it('calls emitTaskUpdated after Notion update resolves', async () => {
    setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'user_kill');
    await new Promise((r) => setTimeout(r, 0));

    expect(emitTaskUpdated).toHaveBeenCalledWith('notion-task-id');
  });
});

describe('SessionManager.markSessionErrored() — crash budget counter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    setupFakeBackend();
  });

  it('increments crash counter for BLOCKED_REASONS causes', () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(1);
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    expect(queries.incrementTaskCrashCount).toHaveBeenCalledWith(
      'notion-task-id',
    );
  });

  it('does NOT increment crash counter for user_kill (operator-intentional)', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill');
    expect(queries.incrementTaskCrashCount).not.toHaveBeenCalled();
  });

  it('does NOT increment crash counter for pr_closed (operator-intentional)', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'pr_closed');
    expect(queries.incrementTaskCrashCount).not.toHaveBeenCalled();
  });

  it('does NOT increment crash counter for launch_failed (infra error, not in-session crash)', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'launch_failed');
    expect(queries.incrementTaskCrashCount).not.toHaveBeenCalled();
  });

  it('DOES increment crash counter for worktree_recreate_failed', () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(1);
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'worktree_recreate_failed');
    expect(queries.incrementTaskCrashCount).toHaveBeenCalledWith(
      'notion-task-id',
    );
  });

  it('first runner_non_zero crash → 🗂️ Ready (counter = 1)', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(1);
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🗂️ Ready',
      expect.anything(),
    );
  });

  it('second consecutive runner_non_zero crash → 🚫 Blocked (counter = 2)', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(2);
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🚫 Blocked',
      expect.anything(),
    );
  });

  it('counter at 3+ still maps to 🚫 Blocked', async () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(3);
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'sendOrResume_run_error');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🚫 Blocked',
      expect.anything(),
    );
  });
});

// ── Blocked path: task_pause_reasons + auto_launch_paused ────────────────────

describe('SessionManager.markSessionErrored() — blocked path side-effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(2);
    setupFakeBackend();
  });

  it('writes task_pause_reasons row on 2nd consecutive crash', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'worktree_recreate_failed');
    expect(queries.setTaskPauseReason).toHaveBeenCalledWith(
      'notion-task-id',
      'launch_failed',
      'worktree_recreate_failed',
    );
  });

  it('does NOT write task_pause_reasons for launch_failed (AutoLauncher owns escalation)', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'launch_failed');
    expect(queries.setTaskPauseReason).not.toHaveBeenCalled();
  });

  it('does NOT write task_pause_reasons for user_kill', () => {
    vi.mocked(queries.incrementTaskCrashCount).mockReturnValue(999);
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill');
    expect(queries.setTaskPauseReason).not.toHaveBeenCalled();
  });

  it('emits auto_launch_paused broadcast on 2nd consecutive crash', () => {
    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    sm.markSessionErrored('test-session', 'error', 'worktree_recreate_failed');

    const pausedMsg = msgs.find((m) => m.type === 'auto_launch_paused') as
      | {
          type: 'auto_launch_paused';
          taskId: string;
          reason: string;
          detail: string;
        }
      | undefined;
    expect(pausedMsg).toBeDefined();
    expect(pausedMsg!.taskId).toBe('notion-task-id');
    expect(pausedMsg!.reason).toBe('launch_failed');
    expect(pausedMsg!.detail).toBe('worktree_recreate_failed');
  });

  it('emits auto_launch_paused audit event on 2nd consecutive crash (non-launch_failed reason)', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'worktree_recreate_failed');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'auto_launch_paused',
        task_id: 'notion-task-id',
      }),
    );
  });

  it('emits session_launch_failed (not auto_launch_paused) for launch_failed reason', () => {
    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    sm.markSessionErrored('test-session', 'error', 'launch_failed');

    expect(msgs.find((m) => m.type === 'auto_launch_paused')).toBeUndefined();
    const launchFailedMsg = msgs.find(
      (m) => m.type === 'session_launch_failed',
    ) as { type: string; taskId: string; sessionId: string } | undefined;
    expect(launchFailedMsg).toBeDefined();
    expect(launchFailedMsg!.taskId).toBe('notion-task-id');
    expect(launchFailedMsg!.sessionId).toBe('test-session');
  });
});

// ── Staged-intent reap suppression (grant-respawn kill is not a real death) ──

describe('SessionManager.markSessionErrored() — staged-intent reap suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    setupFakeBackend();
  });

  it("a genuine kill (no opts) does NOT expire the session's uncommitted staged intents — a killed session must not void the findings it already staged", () => {
    const staged = stageIntent('test-session');
    const approved = stageIntent('test-session', { state: 'approved' });

    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill');

    expect(queries.getStagedIntent(staged)!.state).toBe('staged');
    expect(queries.getStagedIntent(staged)!.disposition_reason).toBeNull();
    expect(queries.getStagedIntent(approved)!.state).toBe('approved');
  });

  it("a genuine error also does NOT expire the session's uncommitted staged intents", () => {
    const staged = stageIntent('test-session');

    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');

    expect(queries.getStagedIntent(staged)!.state).toBe('staged');
    expect(queries.getStagedIntent(staged)!.disposition_reason).toBeNull();
  });

  it('a session that never staged anything has nothing to reap either way (the narrowed reap is a documented no-op)', () => {
    const sm = new SessionManager();

    expect(() =>
      sm.markSessionErrored('test-session', 'killed', 'user_kill'),
    ).not.toThrow();
  });

  it('opts.suppressReap leaves a staged intent exactly as it was — the grant-respawn kill path', () => {
    const staged = stageIntent('test-session');

    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill', undefined, {
      suppressReap: true,
    });

    expect(queries.getStagedIntent(staged)!.state).toBe('staged');
    expect(queries.getStagedIntent(staged)!.disposition_reason).toBeNull();
  });

  it('opts.suppressReap leaves a sibling capability-request intent staged by the same session untouched (regression for live instance 2)', () => {
    const requestA = stageIntent('test-session', {
      kind: 'session.requestCapability',
      state: 'staged',
    });
    const requestB = stageIntent('test-session', {
      kind: 'session.requestCapability',
      state: 'staged',
    });

    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill', undefined, {
      suppressReap: true,
    });

    expect(queries.getStagedIntent(requestA)!.state).toBe('staged');
    expect(queries.getStagedIntent(requestB)!.state).toBe('staged');
  });

  it("opts.suppressReap on one session does not touch a different session's staged intents either way", () => {
    const own = stageIntent('test-session');
    const other = stageIntent('other-session');

    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill', undefined, {
      suppressReap: true,
    });

    expect(queries.getStagedIntent(own)!.state).toBe('staged');
    expect(queries.getStagedIntent(other)!.state).toBe('staged');
  });

  it('suppressReap is scoped to a single call, but neither call reaps a session with real staged content', () => {
    const staged = stageIntent('test-session');

    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill', undefined, {
      suppressReap: true,
    });
    expect(queries.getStagedIntent(staged)!.state).toBe('staged');

    // A subsequent, genuine kill (no suppressReap) must also leave the
    // intent alone — the session's own history of having staged something
    // is what protects it, not the suppressReap flag.
    sm.markSessionErrored('test-session', 'killed', 'user_kill');
    expect(queries.getStagedIntent(staged)!.state).toBe('staged');
  });
});

// ── Expiry notification — retired for any session with real content ────────
//
// The "N intents expired while you were gone" notice was only ever accurate
// while markSessionErrored actually reaped a session's staged/approved
// intents on kill/error. Now that reaping is narrowed to sessions that never
// staged anything (see reapStagedIntentsForNeverStagedSession), the notice
// can never have anything real to report — a session with staged content is
// never reaped, and a session with none has nothing to notify about.

describe('SessionManager.markSessionErrored() — expiry notification (now unreachable for a session with real content)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    setupFakeBackend();
    db.prepare('DELETE FROM session_feedback_inbox').run();
  });

  it('does not enqueue an expiry notice for a killed session with staged and approved intents — they were not reaped', () => {
    stageIntent('test-session', { kind: 'task.create' });
    stageIntent('test-session', {
      kind: 'journal.setState',
      state: 'approved',
    });

    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill');

    expect(queries.listUndeliveredInboxItems('test-session')).toHaveLength(0);
  });

  it('does not enqueue feedback when the session expires nothing', () => {
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill');

    expect(queries.listUndeliveredInboxItems('test-session')).toHaveLength(0);
  });

  it('a group-tagged staged intent survives a kill untouched, with no notice sent', () => {
    const staged = stageIntent('test-session', {
      kind: 'task.create',
      group_id: 'md-path-validation-descope-1617',
    });

    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill');

    expect(queries.listUndeliveredInboxItems('test-session')).toHaveLength(0);
    expect(queries.getStagedIntent(staged)!.state).toBe('staged');
  });

  it('a session with many staged intents keeps every one of them, with no summarized notice sent', () => {
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) {
      ids.push(stageIntent('test-session', { kind: 'task.create' }));
    }

    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill');

    expect(queries.listUndeliveredInboxItems('test-session')).toHaveLength(0);
    for (const id of ids) {
      expect(queries.getStagedIntent(id)!.state).toBe('staged');
    }
  });

  it('opts.suppressReap (grant-respawn kill) also enqueues no feedback', () => {
    stageIntent('test-session');

    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'killed', 'user_kill', undefined, {
      suppressReap: true,
    });

    expect(queries.listUndeliveredInboxItems('test-session')).toHaveLength(0);
  });
});

// ── Terminal guard: reap of an already-terminal row must never downgrade it ──

describe('SessionManager.markSessionErrored() — terminal guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFakeBackend();
  });

  it('skips the DB write and records a skip audit event when the row is already done (SIGTERM/143 reap)', () => {
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ status: 'done' }) as never,
    );
    const sm = new SessionManager();

    sm.markSessionErrored(
      'test-session',
      'error',
      'runner_non_zero',
      'process exited with code 143',
    );

    expect(queries.updateSessionStatus).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_errored_write_skipped_terminal',
        actor_id: 'test-session',
        payload: expect.objectContaining({
          status_before: 'done',
          attempted_status: 'error',
        }),
      }),
    );
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'session_errored' }),
    );
  });

  it('leaves an already-error or already-killed row alone the same way', () => {
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ status: 'killed' }) as never,
    );
    const sm = new SessionManager();

    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');

    expect(queries.updateSessionStatus).not.toHaveBeenCalled();
  });

  it('does not emit session_ended, reap staged intents, or touch Notion when skipped', async () => {
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ status: 'done' }) as never,
    );
    const staged = stageIntent('test-session');
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 0));

    expect(messages.find((m) => m.type === 'session_ended')).toBeUndefined();
    expect(queries.getStagedIntent(staged)!.state).toBe('staged');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('sets hasEnded on the live in-memory session even though the DB write is skipped', () => {
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ status: 'done' }) as never,
    );
    const sm = new SessionManager();
    const liveSession = { hasEnded: false } as never;
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
      'test-session',
      liveSession,
    );

    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');

    expect((liveSession as { hasEnded: boolean }).hasEnded).toBe(true);
  });

  it('a genuine non-zero exit on a NOT-terminal row still transitions to error unchanged', () => {
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ status: 'running' }) as never,
    );
    const sm = new SessionManager();

    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');

    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'test-session',
      'error',
      expect.any(Number),
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_errored',
        payload: expect.objectContaining({ reason: 'runner_non_zero' }),
      }),
    );
  });

  it('guard is based on the persisted status, not any in-memory hasEnded flag', () => {
    // No live in-memory session is ever registered for this id — the guard
    // must still fire purely from the persisted row, exactly the case where
    // sessionLivenessReconciler reaps an orphaned process whose AgentSession
    // object never observed a clean end (or no longer exists at all).
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ status: 'done' }) as never,
    );
    const sm = new SessionManager();

    sm.markSessionErrored('test-session', 'killed', 'runner_killed_unexpected');

    expect(queries.updateSessionStatus).not.toHaveBeenCalled();
  });
});

// ── Backstop-sweep expiry notification (this task) ──────────────────────────

function insertRealSession(sessionId: string, status: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
       status, started_at, session_type)
     VALUES (?, 'task-1', 'https://notion.so/task', 'https://notion.so/ctx', ?, ?, 'standard')`,
  ).run(sessionId, status, Date.now() - 10 * 60 * 1000);
}

describe('SessionManager.reapStagedIntentsBackstopSweep() — now a permanent no-op (session status alone never reaps)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    setupFakeBackend();
    db.prepare('DELETE FROM session_feedback_inbox').run();
    db.prepare('DELETE FROM sessions').run();
  });

  it('does not reap or notify a session whose staged/approved intents belong to a session sitting at a terminal DB status', () => {
    insertRealSession('sess-backstop', 'killed');
    const staged = stageIntent('sess-backstop', { kind: 'task.create' });
    const approved = stageIntent('sess-backstop', {
      kind: 'journal.setState',
      state: 'approved',
    });

    const sm = new SessionManager();
    const total = sm.reapStagedIntentsBackstopSweep();

    expect(total).toBe(0);
    expect(queries.listUndeliveredInboxItems('sess-backstop')).toHaveLength(0);
    expect(queries.getStagedIntent(staged)!.state).toBe('staged');
    expect(queries.getStagedIntent(approved)!.state).toBe('approved');
  });

  it('a group-tagged intent belonging to an errored session is untouched too', () => {
    insertRealSession('sess-backstop-group', 'error');
    const staged = stageIntent('sess-backstop-group', {
      kind: 'decision.pickOne',
      group_id: 'md-path-validation-descope-1617',
    });

    const sm = new SessionManager();
    sm.reapStagedIntentsBackstopSweep();

    expect(
      queries.listUndeliveredInboxItems('sess-backstop-group'),
    ).toHaveLength(0);
    expect(queries.getStagedIntent(staged)!.state).toBe('staged');
  });

  it('a session with many staged intents keeps every one of them, with no summarized notice sent', () => {
    insertRealSession('sess-backstop-many', 'killed');
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) {
      ids.push(stageIntent('sess-backstop-many', { kind: 'task.create' }));
    }

    const sm = new SessionManager();
    sm.reapStagedIntentsBackstopSweep();

    expect(
      queries.listUndeliveredInboxItems('sess-backstop-many'),
    ).toHaveLength(0);
    for (const id of ids) {
      expect(queries.getStagedIntent(id)!.state).toBe('staged');
    }
  });

  it('enqueues no inbox row when the sweep expires nothing', () => {
    insertRealSession('sess-backstop-clean', 'done');

    const sm = new SessionManager();
    sm.reapStagedIntentsBackstopSweep();

    expect(
      queries.listUndeliveredInboxItems('sess-backstop-clean'),
    ).toHaveLength(0);
  });

  it('leaves no expiry row behind at all — there is nothing to sweep', () => {
    insertRealSession('sess-backstop-undelivered', 'killed');
    stageIntent('sess-backstop-undelivered', { kind: 'task.create' });

    const sm = new SessionManager();
    sm.reapStagedIntentsBackstopSweep();

    const row = db
      .prepare(
        `SELECT delivered_at FROM session_feedback_inbox WHERE session_id = ? AND source = 'staged-intent-expiry'`,
      )
      .get('sess-backstop-undelivered') as
      | { delivered_at: number | null }
      | undefined;
    expect(row).toBeUndefined();
  });
});
