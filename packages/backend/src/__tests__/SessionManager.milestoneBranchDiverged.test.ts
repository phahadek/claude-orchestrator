/**
 * A diverged local milestone ref must make sendOrResume refuse to cut the
 * resumed worktree from it — see MilestoneBranchDivergedError's doc comment
 * in branchModel.ts. Before this test's fix, the pre-existing try/catch
 * around ensureMilestoneBranch in SessionManager.ts's sendOrResume swallowed
 * every failure (including this one) and logged "continuing", so the stale
 * ref was used anyway. This asserts the call site now special-cases
 * MilestoneBranchDivergedError: it routes through handlePokeFailure and
 * returns before any `git worktree add`/`git worktree prune` runs, instead
 * of falling through to worktree recreation.
 *
 * The branchModel mock below defines its own MilestoneBranchDivergedError
 * class rather than spreading the real module's exports — SessionManager.ts
 * and this test both resolve `../session/branchModel` to this same mocked
 * module, so the class identity `instanceof` depends on stays consistent
 * either way; keeping the mock fully self-contained (no importOriginal)
 * avoids any dependency on branchModel.ts's own transitive imports
 * (ProjectService, corporateMode) resolving cleanly in this test's module
 * graph.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from './helpers/mockDbQueries';

const { mockExecCallback } = vi.hoisted(() => ({
  mockExecCallback: vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      cb?: (err: null, result: { stdout: string; stderr: string }) => void,
    ) => {
      const callback = (typeof _opts === 'function' ? _opts : cb) as (
        err: null,
        result: { stdout: string; stderr: string },
      ) => void;
      process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
    },
  ),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
  exec: mockExecCallback,
}));

vi.mock('../config', () => ({
  config: {},
  runtimeSettings: { session_mode: 'cli', max_concurrent_code_sessions: 10 },
  ALLOWED_TOOLS: [],
  GITHUB_REPO: 'phahadek/test-repo',
  getProjectById: vi.fn().mockReturnValue({
    id: 'test-proj',
    name: 'Test Project',
    projectDir: '/tmp/test',
    taskSource: 'notion',
    gitMode: 'remote',
    milestoneBranching: 'two_tier',
    autoLaunchEnabled: true,
    baseBranch: 'dev',
    boards: [],
  }),
  normalizePath: (p: string) => p,
}));

vi.mock('../orchestration/memoryAdmission', () => ({
  hasMemoryHeadroom: vi.fn().mockReturnValue({
    allowed: true,
    freeMemMB: 8192,
    minHostFreeMemoryMB: 4096,
    perSessionReserveMB: 3072,
    projectedFreeMB: 5120,
  }),
}));

vi.mock('../db/queries', () =>
  mockDbQueries({
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
    getSessionMilestoneId: vi.fn().mockReturnValue('ms-6'),
    incrementSessionPokeRetryCount: vi.fn().mockReturnValue(1),
  }),
);

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue('task content'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../session/orchestrator-config', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    mainBranch: 'main',
    bootstrap_script: null,
    prGate: null,
    bash_rules: [],
    allowed_tools: [],
    mcp_servers: undefined,
    verify: [],
    required_env: [],
    required_files: [],
    review_rules: [],
    session_rules: [],
  }),
  getSessionAllowedTools: vi.fn(() => []),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue('context'),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue('review context'),
}));

const {
  mockResolveStartingPoint,
  mockEnsureMilestoneBranch,
  MilestoneBranchDivergedError,
} = vi.hoisted(() => {
  class MilestoneBranchDivergedError extends Error {
    constructor(ref: string, cause: unknown) {
      super(
        `Milestone branch ${ref} has diverged from origin — fast-forward-only refresh refused: ${cause}`,
      );
      this.name = 'MilestoneBranchDivergedError';
    }
  }
  return {
    mockResolveStartingPoint: vi.fn().mockReturnValue({
      startingPoint: 'feature/m6-readiness',
      milestoneSlug: 'm6-readiness',
    }),
    mockEnsureMilestoneBranch: vi.fn(),
    MilestoneBranchDivergedError,
  };
});

vi.mock('../session/branchModel', () => ({
  resolveStartingPoint: mockResolveStartingPoint,
  ensureMilestoneBranch: mockEnsureMilestoneBranch,
  MilestoneBranchDivergedError,
  deriveBranchSlug: vi
    .fn()
    .mockImplementation(
      (s: string) => `feature/${s.toLowerCase().replace(/\s+/g, '-')}`,
    ),
  resolveResumeBranchSlug: vi
    .fn()
    .mockImplementation(
      (s: string) => `feature/${s.toLowerCase().replace(/\s+/g, '-')}`,
    ),
  resolveAvailableBranchSlug: vi.fn((base: string) => base),
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
  CliSessionRunner: vi.fn(),
}));

vi.mock('../session/ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn(),
}));

vi.mock('../session/DockerSessionRunner', () => ({
  DockerSessionRunner: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveStartingPoint.mockReturnValue({
    startingPoint: 'feature/m6-readiness',
    milestoneSlug: 'm6-readiness',
  });
  mockEnsureMilestoneBranch.mockImplementation(() => {
    throw new MilestoneBranchDivergedError(
      'feature/m6-readiness',
      new Error('fatal: Not possible to fast-forward, aborting.'),
    );
  });

  vi.mocked(queries.getSession).mockReturnValue({
    session_id: SESSION_ID,
    task_name: 'my-milestone-task',
    task_id: 'notion:task-abc123',
    project_id: 'test-proj',
    status: 'idle',
    session_type: 'standard',
    worktree_path: '/tmp/does-not-exist-for-this-test',
    pause_reason: null,
  } as never);
  vi.mocked(queries.getSessionMilestoneId).mockReturnValue('ms-6');
});

describe('sendOrResume() refuses to cut a worktree from a diverged milestone branch', () => {
  it('routes MilestoneBranchDivergedError through handlePokeFailure instead of continuing to worktree recreation', async () => {
    const sm = new SessionManager();
    const result = await sm.sendOrResume(SESSION_ID, 'review feedback text');

    expect(result).toBe(SESSION_ID);
    expect(queries.incrementSessionPokeRetryCount).toHaveBeenCalledWith(
      SESSION_ID,
    );

    // No worktree-recreation git commands ran — the diverged-ref failure
    // must short-circuit before `git worktree prune`/`git worktree add`.
    const worktreeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(([cmd]) => String(cmd).includes('worktree'));
    expect(worktreeCalls).toEqual([]);
  });
});
