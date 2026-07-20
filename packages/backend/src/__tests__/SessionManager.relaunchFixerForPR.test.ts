/**
 * Tests for SessionManager.relaunchFixerForPR() — PR-scoped fixer relaunch used
 * by StalledPRReconciler/AutoMerger to recover a stalled gate-failed/conflicted
 * PR whose implementing session has died, instead of the futile re-review.
 *
 * Verifies:
 * - terminal + no worktree (confirmed dead): fresh worktree attached to the
 *   existing branch, session respawned.
 * - terminal + worktree present: resumes in place (no fresh worktree add).
 * - idle + worktree present: resumes in place, same as sendOrResume.
 * - idle + no worktree: surfaced to the operator (stalled_idle), no relaunch.
 * - does not consult hasLiveSessionForTask.
 * - evicts a lingering in-memory session entry before respawning.
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
  getGrantedCapabilities: vi.fn(() => []),
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
  incrementTaskCrashCount: vi.fn().mockReturnValue(1),
  setTaskPauseReason: vi.fn(),
  setSessionPauseReason: vi.fn(),
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
  deriveBranchSlug: vi
    .fn()
    .mockImplementation(
      (s: string) => `feature/${s.toLowerCase().replace(/\s+/g, '-')}`,
    ),
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
    // Never resolves so wireSession's run() fires session_status (resolving firstEvent)
    // but never completes, avoiding asynchronous markSessionErrored('run_error') noise.
    run: vi.fn().mockReturnValue(new Promise(() => {})),
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

import { exec } from 'child_process';
import fs from 'fs';
import { SessionManager } from '../session/SessionManager';
import * as queries from '../db/queries';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
const BASE_SESSION_ROW = {
  session_id: SESSION_ID,
  task_name: 'my-feature-task',
  task_id: 'notion:task-abc123',
  project_id: 'test-proj',
  status: 'idle',
  session_type: 'standard',
  worktree_path: null,
  pause_reason: null,
};

const PR = { pr_number: 42, repo: 'org/repo', session_id: SESSION_ID };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.getOtherRunningSessionsForTask).mockReturnValue([]);
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

describe('relaunchFixerForPR() confirmed-dead: terminal + no worktree', () => {
  it('recreates a worktree attached to the existing branch and respawns the session', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...BASE_SESSION_ROW,
      status: 'error',
    } as never);

    const sm = new SessionManager();
    const result = await sm.relaunchFixerForPR(PR, 'gate failure feedback');

    expect(result).toBe(SESSION_ID);
    const addCalls = vi
      .mocked(exec)
      .mock.calls.map((c) => c[0] as string)
      .filter((c) => c.includes('worktree add'));
    expect(addCalls.length).toBeGreaterThan(0);
    // Attaches to the existing branch (no -b create) since the fixer must
    // land on the same branch/PR.
    expect(addCalls[0]).not.toContain('-b');
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
  });
});

describe('relaunchFixerForPR() terminal + worktree present: resume, not fresh spawn', () => {
  it('reuses the surviving worktree without a git worktree add', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...BASE_SESSION_ROW,
      status: 'killed',
      worktree_path:
        '/tmp/test/.claude/worktrees/aaaabbbb-cccc-dddd-eeee-ffffffffffff',
    } as never);
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const sm = new SessionManager();
    const result = await sm.relaunchFixerForPR(PR, 'gate failure feedback');

    expect(result).toBe(SESSION_ID);
    const addCalls = vi
      .mocked(exec)
      .mock.calls.map((c) => c[0] as string)
      .filter((c) => c.includes('worktree add'));
    expect(addCalls).toHaveLength(0);
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
  });
});

describe('relaunchFixerForPR() idle + worktree present: resume, not fresh spawn', () => {
  it('reuses the surviving worktree without a git worktree add', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...BASE_SESSION_ROW,
      status: 'idle',
      worktree_path:
        '/tmp/test/.claude/worktrees/aaaabbbb-cccc-dddd-eeee-ffffffffffff',
    } as never);
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const sm = new SessionManager();
    const result = await sm.relaunchFixerForPR(PR, 'gate failure feedback');

    expect(result).toBe(SESSION_ID);
    const addCalls = vi
      .mocked(exec)
      .mock.calls.map((c) => c[0] as string)
      .filter((c) => c.includes('worktree add'));
    expect(addCalls).toHaveLength(0);
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
  });
});

describe('relaunchFixerForPR() idle + no worktree: operator-surfaced, no relaunch', () => {
  it('sets stalled_idle pause reason and does not spawn or resume', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...BASE_SESSION_ROW,
      status: 'idle',
    } as never);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const sm = new SessionManager();
    const msgs: ServerMessage[] = [];
    sm.on('message', (m: ServerMessage) => msgs.push(m));

    const result = await sm.relaunchFixerForPR(PR, 'rebase please');

    expect(result).toBeNull();
    expect(queries.setSessionPauseReason).toHaveBeenCalledWith(
      SESSION_ID,
      'stalled_idle',
    );
    expect(queries.updateSessionStatus).not.toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
    const failedMsg = msgs.find((m) => m.type === 'session_action_failed') as
      | { reason: string }
      | undefined;
    expect(failedMsg?.reason).toBe('worktree_missing');
  });
});

describe('relaunchFixerForPR() does not consult hasLiveSessionForTask', () => {
  it('never calls hasLiveSessionForTask during a relaunch', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...BASE_SESSION_ROW,
      status: 'error',
    } as never);

    const sm = new SessionManager();
    const spy = vi.spyOn(sm, 'hasLiveSessionForTask');

    await sm.relaunchFixerForPR(PR, 'gate failure feedback');

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('relaunchFixerForPR() evicts a lingering in-memory session entry first', () => {
  it('does not deliver via the stale live-session entry — respawns instead', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      ...BASE_SESSION_ROW,
      status: 'error',
    } as never);

    const sm = new SessionManager();
    const staleSendMessage = vi.fn();
    // Simulate a lingering in-memory entry for a session the DB already
    // considers dead (race between process exit and map cleanup).
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
      SESSION_ID,
      { sendMessage: staleSendMessage },
    );

    const result = await sm.relaunchFixerForPR(PR, 'gate failure feedback');

    expect(staleSendMessage).not.toHaveBeenCalled();
    expect(result).toBe(SESSION_ID);
    expect(queries.updateSessionStatus).toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
  });
});

describe('relaunchFixerForPR() no session_id on the PR', () => {
  it('returns null without touching session state', async () => {
    const sm = new SessionManager();
    const result = await sm.relaunchFixerForPR(
      { pr_number: 42, repo: 'org/repo', session_id: null },
      'prompt',
    );

    expect(result).toBeNull();
    expect(queries.getSession).not.toHaveBeenCalled();
  });
});
