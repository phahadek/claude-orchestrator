/**
 * Fixture test asserting a resumed two_tier session resolves its
 * milestoneId (captured onto sessions.metadata at spawn time via
 * setSessionMilestoneId — see SessionManager.start()) rather than the
 * hardcoded `null` the resume path used to pass to resolveStartingPoint,
 * which silently degraded every resume to flat-mode base-branch
 * resolution. Uses the real filesystem for the worktree fixture, same
 * pattern as SessionManager.worktreeReuse.fixture.test.ts — the .git
 * pointer is omitted so the recreation path (which calls
 * resolveStartingPoint/ensureMilestoneBranch) runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue(''),
    exec: mockExecCallback,
  };
});

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

const MILESTONE_ID = 'ms-6';

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

const { mockResolveStartingPoint } = vi.hoisted(() => ({
  mockResolveStartingPoint: vi.fn().mockReturnValue({
    startingPoint: 'feature/m6-readiness',
    milestoneSlug: 'm6-readiness',
  }),
}));

vi.mock('../session/branchModel', () => ({
  resolveStartingPoint: mockResolveStartingPoint,
  ensureMilestoneBranch: vi.fn(),
  slugify: vi
    .fn()
    .mockImplementation((s: string) => s.toLowerCase().replace(/\s+/g, '-')),
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
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn().mockReturnValue(true),
    endSession: vi.fn(),
    run: vi.fn((_initialPrompt, _resumeSessionId, _options, onEvent) => {
      queueMicrotask(() =>
        onEvent({ type: 'system', subtype: 'hook_started' }),
      );
      return new Promise(() => {});
    }),
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

import { SessionManager } from '../session/SessionManager';
import * as queries from '../db/queries';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';

let wtDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveStartingPoint.mockReturnValue({
    startingPoint: 'feature/m6-readiness',
    milestoneSlug: 'm6-readiness',
  });
  // Fixture dir with no .git pointer, so the reuse path refuses and the
  // recreation path (which calls resolveStartingPoint) runs.
  wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-resume-milestone-'));

  vi.mocked(queries.getSession).mockReturnValue({
    session_id: SESSION_ID,
    task_name: 'my-milestone-task',
    task_id: 'notion:task-abc123',
    project_id: 'test-proj',
    status: 'idle',
    session_type: 'standard',
    worktree_path: wtDir,
    pause_reason: null,
  } as never);
  vi.mocked(queries.getSessionMilestoneId).mockReturnValue(MILESTONE_ID);
});

afterEach(() => {
  fs.rmSync(wtDir, { recursive: true, force: true });
});

describe('sendOrResume() resolves the persisted milestoneId for a resumed two_tier session', () => {
  it('reads back the milestoneId captured at spawn time and passes it to resolveStartingPoint, same as a fresh launch', async () => {
    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'review feedback text');

    expect(queries.getSessionMilestoneId).toHaveBeenCalledWith(SESSION_ID);
    expect(mockResolveStartingPoint).toHaveBeenCalledWith(
      expect.objectContaining({ milestoneBranching: 'two_tier' }),
      MILESTONE_ID,
    );
  });
});
