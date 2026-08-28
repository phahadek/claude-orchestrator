/**
 * Behavioral tests for the branch-collision uniquification path: a fresh
 * launch whose deterministic deriveBranchSlug name is already present
 * locally (an orphaned branch from a dead prior session, or any other
 * collision) must not fail — it must uniquify onto `<base>-2` (or the next
 * free slot) and persist the branch it actually created.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from './helpers/mockDbQueries';

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
      mkdirSync: vi.fn(),
    },
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    statSync: vi.fn().mockReturnValue({ isFile: () => false }),
    mkdirSync: vi.fn(),
  };
});

vi.mock('../config', () => ({
  config: {},
  runtimeSettings: { session_mode: 'cli', max_concurrent_code_sessions: 10 },
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

const setSessionFeatureBranch = vi.hoisted(() => vi.fn());

vi.mock('../db/queries', () =>
  mockDbQueries({
    getGrantedCapabilities: vi.fn(() => []),
    insertSession: vi.fn(),
    updateSessionStatus: vi.fn(),
    updateSessionWorktreePath: vi.fn(),
    setSessionFeatureBranch,
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
  }),
);

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
    required_env: [],
    required_files: [],
    review_rules: [],
    session_rules: [],
    capability_pre_grants: {},
  }),
  getSessionAllowedTools: vi.fn(() => []),
  resolvePreGrantCapabilities: vi.fn(() => []),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue('context'),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue(''),
}));

const resolveAvailableBranchSlug = vi.hoisted(() =>
  vi.fn((base: string) => base),
);

vi.mock('../session/branchModel', () => ({
  resolveStartingPoint: vi
    .fn()
    .mockReturnValue({ startingPoint: 'dev', milestoneSlug: null }),
  ensureMilestoneBranch: vi.fn(),
  deriveBranchSlug: vi.fn().mockReturnValue('feature/my-task-abc12345'),
  resolveResumeBranchSlug: vi.fn().mockReturnValue('feature/my-task-abc12345'),
  resolveAvailableBranchSlug,
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
  normalizeBoardId: vi.fn((id: string) => id),
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
import { SessionManager } from '../session/SessionManager';

const TASK_URL = 'https://www.notion.so/My-Task-abc123def456789012345678901234';
const CTX_URL = 'https://www.notion.so/Context-abc123';
const START_OPTS = {
  sessionType: 'standard' as const,
  projectId: 'test-proj',
  taskName: 'my-task',
  taskKind: 'milestone' as const,
  taskId: 'notion:task-abc123',
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveAvailableBranchSlug.mockImplementation((base: string) => base);
});

describe('SessionManager fresh launch — branch uniquification', () => {
  it('uses the unchanged deriveBranchSlug name when there is no collision', async () => {
    const worktreeAddCalls: string[] = [];
    vi.mocked(execCb).mockImplementation(
      (
        cmd: string,
        _opts: unknown,
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        if (String(cmd).includes('worktree add -b')) {
          worktreeAddCalls.push(String(cmd));
        }
        process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        return {} as never;
      },
    );

    const sm = new SessionManager(undefined as never);
    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((r) => setTimeout(r, 20));

    expect(worktreeAddCalls).toHaveLength(1);
    expect(worktreeAddCalls[0]).toContain('feature/my-task-abc12345');
    expect(setSessionFeatureBranch).toHaveBeenCalledWith(
      expect.any(String),
      'feature/my-task-abc12345',
    );
  });

  it('creates <base>-2 and succeeds when the derived name already exists locally', async () => {
    resolveAvailableBranchSlug.mockImplementation(
      (base: string) => `${base}-2`,
    );
    const worktreeAddCalls: string[] = [];
    vi.mocked(execCb).mockImplementation(
      (
        cmd: string,
        _opts: unknown,
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        if (String(cmd).includes('worktree add -b')) {
          worktreeAddCalls.push(String(cmd));
        }
        process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        return {} as never;
      },
    );

    const sm = new SessionManager(undefined as never);
    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((r) => setTimeout(r, 20));

    expect(worktreeAddCalls).toHaveLength(1);
    expect(worktreeAddCalls[0]).toContain('feature/my-task-abc12345-2');
    expect(setSessionFeatureBranch).toHaveBeenCalledWith(
      expect.any(String),
      'feature/my-task-abc12345-2',
    );
  });

  it('creates <base>-3 when both <base> and <base>-2 already exist', async () => {
    resolveAvailableBranchSlug.mockImplementation(
      (base: string) => `${base}-3`,
    );
    const worktreeAddCalls: string[] = [];
    vi.mocked(execCb).mockImplementation(
      (
        cmd: string,
        _opts: unknown,
        cb: (err: null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const callback = typeof _opts === 'function' ? _opts : cb;
        if (String(cmd).includes('worktree add -b')) {
          worktreeAddCalls.push(String(cmd));
        }
        process.nextTick(() => callback(null, { stdout: '', stderr: '' }));
        return {} as never;
      },
    );

    const sm = new SessionManager(undefined as never);
    sm.start(TASK_URL, CTX_URL, START_OPTS);
    await new Promise((r) => setTimeout(r, 20));

    expect(worktreeAddCalls).toHaveLength(1);
    expect(worktreeAddCalls[0]).toContain('feature/my-task-abc12345-3');
    expect(setSessionFeatureBranch).toHaveBeenCalledWith(
      expect.any(String),
      'feature/my-task-abc12345-3',
    );
  });
});
