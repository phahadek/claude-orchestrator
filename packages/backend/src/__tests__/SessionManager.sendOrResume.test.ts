/**
 * Tests for sendOrResume() worktree-recreation failure handling.
 * Verifies: no rethrow, session marked errored, session_action_failed broadcast,
 * stderr captured in event, short-circuit on already-errored sessions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '../ws/types';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue(''),
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
      mkdirSync: vi.fn(),
      statSync: vi.fn().mockReturnValue({ isFile: () => false }),
    },
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    mkdirSync: vi.fn(),
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
    gitMode: 'local-only',
    autoLaunchEnabled: true,
    baseBranch: 'dev',
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
  getOtherRunningSessionsForTask: vi.fn().mockReturnValue([]),
  markSessionSuperseded: vi.fn(),
  markSessionDone: vi.fn(),
  updateSessionWorktreePath: vi.fn(),
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
    mcp_servers: undefined,
  }),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue('context'),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue('review context'),
}));

vi.mock('../session/branchModel', () => ({
  resolveStartingPoint: vi.fn().mockReturnValue({
    startingPoint: 'dev',
    milestoneSlug: null,
  }),
  ensureMilestoneBranch: vi.fn(),
  slugify: vi
    .fn()
    .mockImplementation((s: string) => s.toLowerCase().replace(/\s+/g, '-')),
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

vi.mock('../session/DockerSessionRunner', () => ({
  DockerSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
  reapOrphanContainers: vi.fn(),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config/corporateMode', () => ({
  getCorporateMode: vi
    .fn()
    .mockReturnValue({ gates: { dockerMandatory: false } }),
}));

import { execSync } from 'child_process';
import { SessionManager } from '../session/SessionManager';
import * as queries from '../db/queries';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
const IDLE_SESSION_ROW = {
  session_id: SESSION_ID,
  task_name: 'my-feature-task',
  task_id: 'notion:task-abc123',
  project_id: 'test-proj',
  status: 'idle',
  session_type: 'standard',
  worktree_path: null,
  pause_reason: null,
};

function makeWorktreeError(stderrContent: string): Error & { stderr: string } {
  const err = new Error(
    `Command failed: git worktree add\n${stderrContent}`,
  ) as Error & { stderr: string };
  err.stderr = stderrContent;
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getSession).mockReturnValue(IDLE_SESSION_ROW as never);
  vi.mocked(queries.getOtherRunningSessionsForTask).mockReturnValue([]);
});

// ── No rethrow — process stays alive ────────────────────────────────────────

describe('sendOrResume() worktree-recreate failure: no rethrow', () => {
  it('resolves without throwing when execSync throws during worktree add', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if ((cmd as string).includes('worktree add')) {
        throw makeWorktreeError(
          "fatal: a branch named 'feature/my-feature-task' already exists",
        );
      }
      return '' as never;
    });

    const sm = new SessionManager();
    await expect(
      sm.sendOrResume(SESSION_ID, 'fix this'),
    ).resolves.not.toThrow();
  });

  it('returns the session ID when worktree recreation fails', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if ((cmd as string).includes('worktree add')) {
        throw makeWorktreeError('fatal: branch already exists');
      }
      return '' as never;
    });

    const sm = new SessionManager();
    const result = await sm.sendOrResume(SESSION_ID, 'fix this');
    expect(result).toBe(SESSION_ID);
  });
});

// ── Session marked errored ───────────────────────────────────────────────────

describe('sendOrResume() worktree-recreate failure: session marked errored', () => {
  it('calls updateSessionStatus with error status when worktree add fails', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if ((cmd as string).includes('worktree add')) {
        throw makeWorktreeError('fatal: branch already exists');
      }
      return '' as never;
    });

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'fix this');

    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      SESSION_ID,
      'error',
      expect.any(Number),
    );
  });
});

// ── WS event broadcast ───────────────────────────────────────────────────────

describe('sendOrResume() worktree-recreate failure: session_action_failed broadcast', () => {
  it('broadcasts a session_action_failed WS event on worktree failure', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if ((cmd as string).includes('worktree add')) {
        throw makeWorktreeError('fatal: branch already exists');
      }
      return '' as never;
    });

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    await sm.sendOrResume(SESSION_ID, 'fix this');

    const failedMsg = msgs.find((m) => m.type === 'session_action_failed') as
      | {
          type: 'session_action_failed';
          sessionId: string;
          action: string;
          reason: string;
          detail: string;
        }
      | undefined;
    expect(failedMsg).toBeDefined();
    expect(failedMsg!.sessionId).toBe(SESSION_ID);
    expect(failedMsg!.reason).toBe('worktree_recreate_failed');
  });

  it('includes the git stderr in the WS event detail', async () => {
    const stderrContent =
      "fatal: a branch named 'feature/my-feature-task' already exists";
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if ((cmd as string).includes('worktree add')) {
        throw makeWorktreeError(stderrContent);
      }
      return '' as never;
    });

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    await sm.sendOrResume(SESSION_ID, 'fix this');

    const failedMsg = msgs.find((m) => m.type === 'session_action_failed') as
      | { type: 'session_action_failed'; detail: string }
      | undefined;
    expect(failedMsg).toBeDefined();
    expect(failedMsg!.detail).toContain(stderrContent);
  });
});

// ── Short-circuit on already-errored session ────────────────────────────────

describe('sendOrResume() short-circuit: already-errored session', () => {
  it('does not attempt worktree-add when session status is error', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...IDLE_SESSION_ROW,
      status: 'error',
    } as never);

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'fix this');

    const worktreeCalls = vi
      .mocked(execSync)
      .mock.calls.filter((c) => (c[0] as string).includes('worktree add'));
    expect(worktreeCalls).toHaveLength(0);
  });

  it('does not attempt worktree-add when session status is done', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...IDLE_SESSION_ROW,
      status: 'done',
    } as never);

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'fix this');

    const worktreeCalls = vi
      .mocked(execSync)
      .mock.calls.filter((c) => (c[0] as string).includes('worktree add'));
    expect(worktreeCalls).toHaveLength(0);
  });
});
