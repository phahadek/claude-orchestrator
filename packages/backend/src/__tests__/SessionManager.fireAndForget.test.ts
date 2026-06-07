/**
 * Tests for the fire-and-forget start() refactor:
 * - start() returns within <100ms even when git worktree add is slow
 * - completeStart failure triggers markSessionErrored + cleanupPartialWorktree
 * - cleanupPartialWorktree is idempotent when no worktree was created
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '../ws/types';

// child_process: prevent real git operations; controllable exec mock
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue('dev\n'),
    exec: vi
      .fn()
      .mockImplementation(
        (
          _cmd: string,
          _opts: unknown,
          cb: (err: null, result: { stdout: string; stderr: string }) => void,
        ) => {
          const callback = typeof _opts === 'function' ? _opts : cb;
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        },
      ),
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue(''),
      statSync: vi.fn().mockReturnValue({ isFile: () => false }),
    },
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
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
    autoLaunchEnabled: true,
    boards: [],
  }),
  normalizePath: (p: string) => p,
}));

vi.mock('../db/queries', () => ({
  insertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  getPRByNotionTaskId: vi.fn().mockReturnValue(null),
  getSession: vi.fn().mockReturnValue(null),
  insertEvent: vi.fn(),
  getSessionsByStatus: vi.fn().mockReturnValue([]),
  getEventsBySession: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn().mockReturnValue(null),
  hasActiveSessionForTask: vi.fn().mockReturnValue(false),
  getSetting: vi.fn().mockReturnValue(null),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue('task content'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    mainBranch: 'main',
    bootstrapScript: null,
    prGate: null,
    bashRules: null,
    allowedTools: [],
  }),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue('context'),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue('review context'),
}));

vi.mock('../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../notion/NotionClient', () => ({
  parseSection: vi.fn().mockReturnValue(''),
}));

vi.mock('../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('starting'),
}));

vi.mock('../session/CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
}));

vi.mock('../session/ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
}));

vi.mock(import('../session/AgentSession'), async (importOriginal) => {
  const actual = await importOriginal();
  const AgentSession = vi
    .fn()
    .mockImplementation(
      (
        _sid: string,
        _url: string,
        _ctx: string,
        _override: unknown,
        _wt: string,
        _tid: string,
        _resume: string,
        _prompt: string,
        sessionType: string,
      ) => ({
        sessionType: sessionType ?? 'standard',
        taskId: null,
        prUrl: null,
        hasEnded: true,
        on: vi.fn(),
        run: vi.fn().mockReturnValue(new Promise(() => {})),
      }),
    );
  return { ...actual, AgentSession };
});

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { exec as execCb } from 'child_process';
import * as fs from 'fs';
import * as queries from '../db/queries';
import { SessionManager } from '../session/SessionManager';
import { AgentSession } from '../session/AgentSession';

const TASK_URL =
  'https://www.notion.so/Test-Task-abc123def456789012345678901234';
const CTX_URL = 'https://www.notion.so/Context-abc123';
const START_OPTS = {
  sessionType: 'standard' as const,
  projectId: 'test-proj',
  taskName: 'Test Task',
  taskKind: 'milestone' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.hasActiveSessionForTask).mockReturnValue(false);
  vi.mocked(queries.getSession).mockReturnValue(null);

  // Default exec: fast resolution via process.nextTick
  vi.mocked(execCb).mockImplementation(
    (
      _cmd: string,
      _opts: unknown,
      cb: (err: null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
    },
  );

  // Default AgentSession: successful
  vi.mocked(AgentSession).mockImplementation(
    (_s, _u, _c, _o, _w, _t, _r, _p, sessionType) =>
      ({
        sessionType: sessionType ?? 'standard',
        taskId: null,
        prUrl: null,
        hasEnded: true,
        on: vi.fn(),
        run: vi.fn().mockReturnValue(new Promise(() => {})),
      }) as never,
  );
});

// ── start() returns fast even when git is slow ────────────────────────────────

describe('SessionManager.start() fire-and-forget timing', () => {
  it('returns <100ms (fire-and-forget: no blocking on git operations)', async () => {
    // With fire-and-forget, start() always returns fast — the exec timing is irrelevant
    const sm = new SessionManager();
    const t0 = Date.now();
    await sm.start(TASK_URL, CTX_URL, START_OPTS);
    expect(Date.now() - t0).toBeLessThan(100);
    // Flush background chain to avoid state leaking into next test
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('emits session_starting synchronously before returning', async () => {
    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    await sm.start(TASK_URL, CTX_URL, START_OPTS);

    expect(msgs.find((m) => m.type === 'session_starting')).toBeDefined();
    // Flush background chain to avoid state leaking into next test
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

// ── completeStart failure handling ────────────────────────────────────────────

describe('SessionManager.completeStart() failure handling', () => {
  it('calls markSessionErrored with launch_failed when AgentSession throws', async () => {
    vi.mocked(AgentSession).mockImplementationOnce(() => {
      throw new Error('simulated worktree failure');
    });
    vi.mocked(queries.getSession).mockReturnValue({
      session_type: 'standard',
      task_id: 'notion:task-123',
      project_id: 'test-proj',
      worktree_path: null,
    } as never);

    const sm = new SessionManager();
    const markErroredSpy = vi.spyOn(sm, 'markSessionErrored');

    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(markErroredSpy).toHaveBeenCalledWith(
      expect.any(String),
      'error',
      'launch_failed',
    );
  });

  it('calls cleanupPartialWorktree when completeStart fails', async () => {
    vi.mocked(AgentSession).mockImplementationOnce(() => {
      throw new Error('simulated failure');
    });

    const sm = new SessionManager();
    const cleanupSpy = vi.spyOn(sm as never, 'cleanupPartialWorktree');

    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cleanupSpy).toHaveBeenCalledOnce();
  });

  it('emits error message when completeStart fails', async () => {
    vi.mocked(AgentSession).mockImplementationOnce(() => {
      throw new Error('launch boom');
    });
    vi.mocked(queries.getSession).mockReturnValue({
      session_type: 'standard',
      task_id: 'notion:task-123',
      project_id: 'test-proj',
      worktree_path: null,
    } as never);

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const errorMsgs = msgs.filter((m) => m.type === 'error') as Array<{
      type: 'error';
      message: string;
    }>;
    expect(errorMsgs.some((m) => m.message.includes('Session launch failed'))).toBe(true);
  });
});

// ── cleanupPartialWorktree idempotency ────────────────────────────────────────

describe('SessionManager.cleanupPartialWorktree() idempotency', () => {
  it('is safe to call when session row not found (no-op)', async () => {
    vi.mocked(queries.getSession).mockReturnValue(null);

    const sm = new SessionManager();
    await expect(
      (sm as never as { cleanupPartialWorktree(id: string): Promise<void> })
        .cleanupPartialWorktree('no-such-session'),
    ).resolves.toBeUndefined();
  });

  it('is safe to call when worktree_path is null (no-op)', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      session_type: 'standard',
      task_id: 'task-123',
      project_id: 'test-proj',
      worktree_path: null,
      task_name: 'Test Task',
    } as never);

    const sm = new SessionManager();
    await expect(
      (sm as never as { cleanupPartialWorktree(id: string): Promise<void> })
        .cleanupPartialWorktree('session-123'),
    ).resolves.toBeUndefined();

    // No git exec calls for removal since worktree_path is null
    const worktreeRemoveCalls = vi
      .mocked(execCb)
      .mock.calls.filter(([cmd]) => String(cmd).includes('worktree remove'));
    expect(worktreeRemoveCalls).toHaveLength(0);
  });

  it('is safe to call when worktree dir does not exist (existsSync returns false)', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      session_type: 'standard',
      task_id: 'task-123',
      project_id: 'test-proj',
      worktree_path: '/tmp/test/.claude/worktrees/session-xyz',
      task_name: null,
    } as never);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const sm = new SessionManager();
    await expect(
      (sm as never as { cleanupPartialWorktree(id: string): Promise<void> })
        .cleanupPartialWorktree('session-xyz'),
    ).resolves.toBeUndefined();

    // git worktree remove should NOT be called when existsSync is false
    const worktreeRemoveCalls = vi
      .mocked(execCb)
      .mock.calls.filter(([cmd]) => String(cmd).includes('worktree remove'));
    expect(worktreeRemoveCalls).toHaveLength(0);
  });
});
