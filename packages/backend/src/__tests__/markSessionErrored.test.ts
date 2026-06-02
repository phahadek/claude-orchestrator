/**
 * Unit tests for SessionManager.markSessionErrored().
 *
 * AC coverage:
 * - Helper exists and is the single owner of DB status + Notion task status + WS broadcast
 * - Per-cause target Notion status: runner_non_zero → Blocked, user_kill → Ready,
 *   pre-check failures → Ready
 * - session_ended WS broadcast fires from the helper
 * - audit_log event captures the cause
 * - Notion updateStatus failures are logged but not re-thrown
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '../ws/types';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('dev\n'),
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
}));

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

  it('sets Notion status to 🔴 Blocked for runner_non_zero', async () => {
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'runner_non_zero');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🔴 Blocked',
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

  it('sets Notion status to 🗂️ Ready for worktree_missing (pre-check failure)', async () => {
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

  it('sets Notion status to 🗂️ Ready for launch_failed (pre-check failure)', async () => {
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

  it('sets Notion status to 🔴 Blocked for run_error', async () => {
    const mockUpdate = setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'run_error');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockUpdate).toHaveBeenCalledWith(
      'notion-task-id',
      '🔴 Blocked',
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

describe('SessionManager.markSessionErrored() — task_status_changed + emitTaskUpdated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queries.getSession).mockReturnValue(makeSessionRow() as never);
  });

  it('broadcasts task_status_changed after Notion update resolves', async () => {
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
    expect(changed!.newStatus).toBe('🔴 Blocked');
  });

  it('calls emitTaskUpdated after Notion update resolves', async () => {
    setupFakeBackend();
    const sm = new SessionManager();
    sm.markSessionErrored('test-session', 'error', 'user_kill');
    await new Promise((r) => setTimeout(r, 0));

    expect(emitTaskUpdated).toHaveBeenCalledWith('notion-task-id');
  });
});
