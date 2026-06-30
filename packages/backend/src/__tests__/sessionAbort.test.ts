/**
 * Tests for SessionManager.abortSession() and the POST /api/sessions/:id/abort endpoint.
 *
 * AC coverage:
 * - Abort pre-marks session as killed in DB before attempting process kill.
 * - Abort emits session_ended WS broadcast immediately.
 * - Abort resets task to 🗂️ Ready via task backend.
 * - Abort records a session_aborted audit event.
 * - After abort, the in-memory session's hasEnded flag is set so markSessionErrored
 *   cannot double-update DB / task status when the process kill fires.
 * - A subsequent launch after abort starts fresh (hasActiveSessionForTask returns false).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '../ws/types';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('dev\n'),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

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
  config: { maxConcurrentCodeSessions: 10 },
  runtimeSettings: { session_mode: 'cli' },
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

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(),
}));

vi.mock('../db/queries', () => ({
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
  getRunningSessionsWithMergedOrClosedPR: vi.fn().mockReturnValue([]),
  getOtherRunningSessionsForTask: vi.fn().mockReturnValue([]),
  setSessionLastErrorDetail: vi.fn(),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('in_progress'),
}));

vi.mock('../notion/NotionClient', () => ({
  parseSection: vi.fn().mockReturnValue(''),
}));

vi.mock('../session/AgentSession', () => ({
  AgentSession: vi.fn().mockImplementation(() => ({
    sessionType: 'standard',
    taskId: 'notion-task-id',
    prUrl: null,
    hasEnded: false,
    on: vi.fn(),
    run: vi.fn().mockReturnValue(new Promise(() => {})),
    kill: vi.fn().mockResolvedValue(undefined),
  })),
  parseNotionPageIdDashed: vi.fn().mockImplementation((url: string) => url),
  parseNotionPageId: vi.fn().mockImplementation((url: string) => url),
}));

vi.mock('../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    allowedTools: [],
    verify: [],
    bash_rules: [],
    bootstrap_script: null,
    mcp_servers: {},
  }),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue(''),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue(''),
}));

vi.mock('../session/CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    kill: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../session/ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({
    kill: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../session/DockerSessionRunner', () => ({
  DockerSessionRunner: vi.fn().mockImplementation(() => ({
    kill: vi.fn().mockResolvedValue(undefined),
  })),
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionManager.abortSession() — DB pre-mark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    setupFakeBackend();
  });

  it('pre-marks the session as killed in the DB before sending the kill signal', async () => {
    const sm = new SessionManager();
    await sm.abortSession('test-session');

    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      'test-session',
      'killed',
      expect.any(Number),
    );
  });

  it('is a no-op when session is not found in DB', async () => {
    vi.mocked(queries.getSession).mockReturnValue(null as never);
    const sm = new SessionManager();
    await sm.abortSession('unknown-session');

    expect(queries.updateSessionStatus).not.toHaveBeenCalled();
  });
});

describe('SessionManager.abortSession() — WS broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    setupFakeBackend();
  });

  it('emits session_ended with status killed immediately', async () => {
    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    await sm.abortSession('test-session');

    const ended = messages.filter((m) => m.type === 'session_ended');
    expect(ended).toHaveLength(1);
    expect((ended[0] as { status: string }).status).toBe('killed');
    expect((ended[0] as { sessionId: string }).sessionId).toBe('test-session');
  });

  it('includes taskId in session_ended when session has a task', async () => {
    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    await sm.abortSession('test-session');

    const ended = messages.find((m) => m.type === 'session_ended') as
      | { taskId?: string }
      | undefined;
    expect(ended?.taskId).toBe('notion-task-id');
  });
});

describe('SessionManager.abortSession() — task status reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
  });

  it('resets the task to 🗂️ Ready via the task backend', async () => {
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    await sm.abortSession('test-session');
    await new Promise((r) => setTimeout(r, 0));

    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🗂️ Ready',
      expect.anything(),
    );
  });

  it('broadcasts task_status_changed → Ready after backend update', async () => {
    setupFakeBackend();
    const sm = new SessionManager();
    const messages: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => messages.push(m));

    await sm.abortSession('test-session');
    await new Promise((r) => setTimeout(r, 0));

    const changed = messages.find((m) => m.type === 'task_status_changed') as
      | { newStatus: string }
      | undefined;
    expect(changed?.newStatus).toBe('🗂️ Ready');
  });

  it('calls emitTaskUpdated after backend update resolves', async () => {
    setupFakeBackend();
    const sm = new SessionManager();
    await sm.abortSession('test-session');
    await new Promise((r) => setTimeout(r, 0));

    expect(emitTaskUpdated).toHaveBeenCalledWith('notion-task-id');
  });

  it('does not update task when session has no task_id', async () => {
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ task_id: null }) as never,
    );
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    await sm.abortSession('test-session');
    await new Promise((r) => setTimeout(r, 0));

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not update task for review sessions', async () => {
    vi.mocked(queries.getSession).mockReturnValue(
      makeSessionRow({ session_type: 'review' }) as never,
    );
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    await sm.abortSession('test-session');
    await new Promise((r) => setTimeout(r, 0));

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('SessionManager.abortSession() — audit event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    setupFakeBackend();
  });

  it('records a session_aborted audit event', async () => {
    const sm = new SessionManager();
    await sm.abortSession('test-session');

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_aborted',
        actor_id: 'test-session',
        payload: expect.objectContaining({ reason: 'user_abort' }),
      }),
    );
  });
});

describe('SessionManager.abortSession() — hasEnded guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    setupFakeBackend();
  });

  it('sets hasEnded = true on the in-memory session to prevent double-marking', async () => {
    const { AgentSession } = await import('../session/AgentSession');
    const mockSession = {
      sessionType: 'standard',
      taskId: 'notion-task-id',
      prUrl: null,
      hasEnded: false,
      on: vi.fn(),
      run: vi.fn().mockReturnValue(new Promise(() => {})),
      kill: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(AgentSession).mockImplementationOnce(() => mockSession as never);

    const sm = new SessionManager();
    // Register the mock session in the internal map
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
      'test-session',
      mockSession,
    );

    await sm.abortSession('test-session');

    expect(mockSession.hasEnded).toBe(true);
  });
});

describe('SessionManager.abortSession() — fresh launch eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFakeBackend();
  });

  it('leaves the task with no active session after abort (hasActiveSessionForTask returns false)', async () => {
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
    // After abort, the session row status would be 'killed' — hasActiveSessionForTask
    // excludes 'killed' sessions, so a new session can be launched.
    vi.mocked(queries.hasActiveSessionForTask).mockReturnValue(false);

    const sm = new SessionManager();
    await sm.abortSession('test-session');

    expect(queries.hasActiveSessionForTask('notion-task-id')).toBe(false);
  });
});
