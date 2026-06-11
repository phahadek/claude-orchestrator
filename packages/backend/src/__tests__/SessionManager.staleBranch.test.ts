/**
 * Behavioral tests for fresh-launch stale-branch abandonment.
 * Source-structure (static) assertions live in SessionManager.staleBranch.source.test.ts.
 *
 * When completeStart hits a branch-already-exists error and the branch is owned
 * by a terminal predecessor session of the same task, the orchestrator:
 *   1. Closes the predecessor's open PR with a superseded comment
 *   2. Deletes the branch locally and on origin
 *   3. Emits a stale_branch_abandoned audit event
 *   4. Retries git worktree add once
 *
 * Any other branch-exists owner keeps the existing deterministic failure path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// child_process mocks
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
    projectDir: '/project',
    taskSource: 'notion',
    baseBranch: 'dev',
    gitMode: 'github',
    githubRepo: 'owner/repo',
  }),
  normalizePath: (p: string) => p,
}));

vi.mock('../db/queries', () => ({
  insertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateSessionWorktreePath: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionSuperseded: vi.fn(),
  insertEvent: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  getSessionsByStatus: vi.fn().mockReturnValue([]),
  getPRByNotionTaskId: vi.fn().mockReturnValue(null),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  getPRByNumber: vi.fn().mockReturnValue(null),
  getEventsBySession: vi.fn().mockReturnValue([]),
  getStuckResultSessionRows: vi.fn().mockReturnValue([]),
  getRunningSessionsWithMergedOrClosedPR: vi.fn().mockReturnValue([]),
  hasActiveSessionForTask: vi.fn().mockReturnValue(false),
  getOtherRunningSessionsForTask: vi.fn().mockReturnValue([]),
  setSessionPauseReason: vi.fn(),
  setSessionLastErrorDetail: vi.fn(),
  incrementTaskCrashCount: vi.fn().mockReturnValue(1),
  setTaskPauseReason: vi.fn(),
  getTerminalSessionsForTask: vi.fn().mockReturnValue([]),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue(''),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    bootstrap_script: null,
    verify: [],
    bash_rules: [],
    mcp_servers: undefined,
    allowed_tools: [],
  }),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue('context'),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue(''),
}));

vi.mock('../session/branchModel', () => ({
  resolveStartingPoint: vi
    .fn()
    .mockReturnValue({ startingPoint: 'dev', milestoneSlug: null }),
  ensureMilestoneBranch: vi.fn(),
  deriveBranchSlug: vi.fn().mockReturnValue('feature/my-task-abc12345'),
}));

vi.mock('../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../notion/NotionClient', () => ({
  parseSection: vi.fn().mockReturnValue(''),
}));
vi.mock('../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('starting'),
}));
vi.mock('../tasks/taskId', () => ({
  formatTaskId: vi.fn().mockReturnValue('notion:task-abc123'),
}));
vi.mock('../session/AgentSession', () => ({
  AgentSession: vi.fn().mockImplementation(() => ({
    sessionType: 'standard',
    taskId: 'notion:task-abc123',
    prUrl: null,
    hasEnded: true,
    on: vi.fn(),
    once: vi.fn(),
    run: vi.fn().mockReturnValue(new Promise(() => {})),
    injectContextFile: vi.fn(),
    setPendingOverflowText: vi.fn(),
  })),
  parseNotionPageIdDashed: vi.fn().mockReturnValue(''),
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
vi.mock('../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../config/corporateMode', () => ({
  getCorporateMode: vi
    .fn()
    .mockReturnValue({ gates: { dockerMandatory: false, requireZDR: false } }),
}));

import { exec as execCb } from 'child_process';
import * as queries from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import { SessionManager } from '../session/SessionManager';

const TASK_URL =
  'https://www.notion.so/My-Task-abc123def456789012345678901234';
const CTX_URL = 'https://www.notion.so/Context-abc123';
const START_OPTS = {
  sessionType: 'standard' as const,
  projectId: 'test-proj',
  taskName: 'my-task',
  taskKind: 'milestone' as const,
  taskId: 'notion:task-abc123',
};

const PREDECESSOR_SESSION_ID = 'predecessor-session-id-0000';
const PREDECESSOR_ROW = {
  session_id: PREDECESSOR_SESSION_ID,
  task_id: 'notion:task-abc123',
  task_url: TASK_URL,
  project_context_url: CTX_URL,
  project_id: 'test-proj',
  status: 'error' as const,
  session_type: 'standard',
  pr_url: null,
  worktree_path: '/project/.claude/worktrees/predecessor-session-id-0000',
  started_at: 1000,
  ended_at: 2000,
} as never;

const PR_ROW = {
  id: 1,
  pr_number: 42,
  pr_url: 'https://github.com/owner/repo/pull/42',
  task_id: 'notion:task-abc123',
  session_id: PREDECESSOR_SESSION_ID,
  repo: 'owner/repo',
  title: 'feat: my-task',
  state: 'open',
  draft: 1,
} as never;

function makeBranchExistsError() {
  const err = new Error('Command failed');
  (err as never as { stderr: string }).stderr =
    "fatal: A branch named 'feature/my-task-abc12345' already exists.";
  return err;
}

/** Makes exec fail the first worktree add -b call with branch-already-exists. */
function mockExecWithBranchExistsOnFirstCall() {
  let called = false;
  vi.mocked(execCb).mockImplementation(
    (
      cmd: string,
      _opts: unknown,
      cb: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (String(cmd).includes('worktree add -b') && !called) {
        called = true;
        process.nextTick(() =>
          callback(makeBranchExistsError(), { stdout: '', stderr: '' }),
        );
      } else {
        process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
      }
      return {} as never;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queries.hasActiveSessionForTask).mockReturnValue(false);
  vi.mocked(queries.getSession).mockReturnValue(null);
  vi.mocked(queries.getTerminalSessionsForTask).mockReturnValue([]);
  vi.mocked(queries.getPRBySessionId).mockReturnValue(null);
});

// ── AC: branch-exists + same-task terminal predecessor + open PR ───────────────

describe('stale-branch abandonment: terminal predecessor + open PR', () => {
  it('closes the predecessor PR with a superseded comment', async () => {
    vi.mocked(queries.getTerminalSessionsForTask).mockReturnValue([
      PREDECESSOR_ROW,
    ]);
    vi.mocked(queries.getPRBySessionId).mockReturnValue(PR_ROW);
    mockExecWithBranchExistsOnFirstCall();

    const ghClient = {
      closePRWithComment: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    };

    const sm = new SessionManager(ghClient as never);
    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((r) => setTimeout(r, 20));

    expect(ghClient.closePRWithComment).toHaveBeenCalledWith(
      'owner/repo',
      42,
      expect.stringMatching(/Superseded.*fresh-start policy/),
    );
  });

  it('deletes the branch on origin', async () => {
    vi.mocked(queries.getTerminalSessionsForTask).mockReturnValue([
      PREDECESSOR_ROW,
    ]);
    vi.mocked(queries.getPRBySessionId).mockReturnValue(PR_ROW);
    mockExecWithBranchExistsOnFirstCall();

    const ghClient = {
      closePRWithComment: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    };

    const sm = new SessionManager(ghClient as never);
    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((r) => setTimeout(r, 20));

    expect(ghClient.deleteBranch).toHaveBeenCalledWith(
      'owner/repo',
      'feature/my-task-abc12345',
    );
  });

  it('retries git worktree add — session starts without marking errored', async () => {
    vi.mocked(queries.getTerminalSessionsForTask).mockReturnValue([
      PREDECESSOR_ROW,
    ]);
    vi.mocked(queries.getPRBySessionId).mockReturnValue(PR_ROW);
    mockExecWithBranchExistsOnFirstCall();

    const ghClient = {
      closePRWithComment: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    };

    const sm = new SessionManager(ghClient as never);
    const markErroredSpy = vi.spyOn(sm, 'markSessionErrored');

    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((r) => setTimeout(r, 20));

    expect(markErroredSpy).not.toHaveBeenCalledWith(
      expect.any(String),
      'error',
      'launch_failed',
    );
  });

  it('emits stale_branch_abandoned audit event with prior session + PR refs', async () => {
    vi.mocked(queries.getTerminalSessionsForTask).mockReturnValue([
      PREDECESSOR_ROW,
    ]);
    vi.mocked(queries.getPRBySessionId).mockReturnValue(PR_ROW);
    mockExecWithBranchExistsOnFirstCall();

    const ghClient = {
      closePRWithComment: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    };

    const sm = new SessionManager(ghClient as never);
    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((r) => setTimeout(r, 20));

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'stale_branch_abandoned',
        payload: expect.objectContaining({
          priorSessionId: PREDECESSOR_SESSION_ID,
          prNumber: 42,
          prRepo: 'owner/repo',
        }),
      }),
    );
  });
});

// ── AC: branch-exists + terminal predecessor but no PR ────────────────────────

describe('stale-branch abandonment: terminal predecessor, no PR', () => {
  it('deletes branch and retries without calling closePRWithComment', async () => {
    vi.mocked(queries.getTerminalSessionsForTask).mockReturnValue([
      PREDECESSOR_ROW,
    ]);
    vi.mocked(queries.getPRBySessionId).mockReturnValue(null);
    mockExecWithBranchExistsOnFirstCall();

    const ghClient = {
      closePRWithComment: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    };

    const sm = new SessionManager(ghClient as never);
    const markErroredSpy = vi.spyOn(sm, 'markSessionErrored');

    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((r) => setTimeout(r, 20));

    expect(ghClient.closePRWithComment).not.toHaveBeenCalled();
    expect(ghClient.deleteBranch).toHaveBeenCalled();
    expect(markErroredSpy).not.toHaveBeenCalledWith(
      expect.any(String),
      'error',
      'launch_failed',
    );
  });

  it('emits stale_branch_abandoned audit event with null PR refs', async () => {
    vi.mocked(queries.getTerminalSessionsForTask).mockReturnValue([
      PREDECESSOR_ROW,
    ]);
    vi.mocked(queries.getPRBySessionId).mockReturnValue(null);
    mockExecWithBranchExistsOnFirstCall();

    const ghClient = {
      closePRWithComment: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    };

    const sm = new SessionManager(ghClient as never);
    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((r) => setTimeout(r, 20));

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'stale_branch_abandoned',
        payload: expect.objectContaining({
          priorSessionId: PREDECESSOR_SESSION_ID,
          prNumber: null,
          prRepo: null,
        }),
      }),
    );
  });
});

// ── AC: branch-exists + no terminal predecessor → deterministic failure ────────

describe('stale-branch abandonment: no terminal predecessor — deterministic failure', () => {
  it('marks session errored when no terminal predecessor found', async () => {
    vi.mocked(queries.getTerminalSessionsForTask).mockReturnValue([]);

    let called = false;
    vi.mocked(execCb).mockImplementation(
      (
        cmd: string,
        _opts: unknown,
        cb: (
          err: Error | null,
          result: { stdout: string; stderr: string },
        ) => void,
      ) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        if (String(cmd).includes('worktree add -b') && !called) {
          called = true;
          process.nextTick(() =>
            callback(makeBranchExistsError(), { stdout: '', stderr: '' }),
          );
        } else {
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        }
        return {} as never;
      },
    );

    const ghClient = {
      closePRWithComment: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    };

    const sm = new SessionManager(ghClient as never);
    const markErroredSpy = vi.spyOn(sm, 'markSessionErrored');

    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((r) => setTimeout(r, 20));

    expect(ghClient.closePRWithComment).not.toHaveBeenCalled();
    expect(ghClient.deleteBranch).not.toHaveBeenCalled();
    expect(markErroredSpy).toHaveBeenCalledWith(
      expect.any(String),
      'error',
      'launch_failed',
    );
  });
});

// ── AC: single retry only — second branch-exists failure fails normally ────────

describe('stale-branch abandonment: single retry only', () => {
  it('marks session errored when second worktree add also fails', async () => {
    vi.mocked(queries.getTerminalSessionsForTask).mockReturnValue([
      PREDECESSOR_ROW,
    ]);
    vi.mocked(queries.getPRBySessionId).mockReturnValue(null);

    // Every worktree add -b call fails
    vi.mocked(execCb).mockImplementation(
      (
        cmd: string,
        _opts: unknown,
        cb: (
          err: Error | null,
          result: { stdout: string; stderr: string },
        ) => void,
      ) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        if (String(cmd).includes('worktree add -b')) {
          process.nextTick(() =>
            callback(makeBranchExistsError(), { stdout: '', stderr: '' }),
          );
        } else {
          process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        }
        return {} as never;
      },
    );

    const ghClient = {
      closePRWithComment: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
    };

    const sm = new SessionManager(ghClient as never);
    const markErroredSpy = vi.spyOn(sm, 'markSessionErrored');

    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((r) => setTimeout(r, 20));

    expect(markErroredSpy).toHaveBeenCalledWith(
      expect.any(String),
      'error',
      'launch_failed',
    );
    // Audit event still emitted for the abandonment attempt
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'stale_branch_abandoned' }),
    );
  });
});
