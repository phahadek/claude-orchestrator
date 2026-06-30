/**
 * Fixture test for the sendOrResume() surviving-worktree reuse path (AC #3 of
 * the worktree-teardown task): an uncommitted WIP file in the session's
 * preserved worktree must survive the resume — the worktree IS the session
 * state, and the reuse path must not run any git worktree commands against it.
 *
 * Uses the REAL filesystem (a temp dir fixture) — unlike the sibling
 * SessionManager.sendOrResume.test.ts, which mocks fs and therefore can only
 * assert call shapes, not file survival.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

vi.mock('../config', () => ({
  config: { maxConcurrentCodeSessions: 10 },
  runtimeSettings: { session_mode: 'cli' },
  ALLOWED_TOOLS: [],
  GITHUB_REPO: 'phahadek/test-repo',
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
  incrementTaskCrashCount: vi.fn().mockReturnValue(1),
  setTaskPauseReason: vi.fn(),
  setSessionLastErrorDetail: vi.fn(),
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
    // Never resolves so wireSession's run() fires session_status (resolving
    // firstEvent) but never completes.
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

import { execSync } from 'child_process';
import { SessionManager } from '../session/SessionManager';
import * as queries from '../db/queries';

const SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';
const WIP_CONTENT = 'uncommitted work-in-progress — must survive resume\n';

let wtDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  // Real-FS fixture: a fake preserved worktree with a .git pointer file and an
  // uncommitted WIP file.
  wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-worktree-reuse-'));
  fs.writeFileSync(
    path.join(wtDir, '.git'),
    'gitdir: /tmp/test/.git/worktrees/fixture\n',
  );
  fs.writeFileSync(path.join(wtDir, 'WIP-uncommitted.txt'), WIP_CONTENT);

  vi.mocked(queries.getSession).mockReturnValue({
    session_id: SESSION_ID,
    task_name: 'my-feature-task',
    task_id: 'notion:task-abc123',
    project_id: 'test-proj',
    status: 'idle',
    session_type: 'standard',
    worktree_path: wtDir,
    pause_reason: null,
  } as never);
});

afterEach(() => {
  fs.rmSync(wtDir, { recursive: true, force: true });
});

describe('sendOrResume() surviving-worktree reuse (real-fs fixture)', () => {
  it('reuses the preserved worktree: WIP survives, no git worktree commands, spawn cwd = preserved path', async () => {
    const respawnSpy = vi.spyOn(
      SessionManager.prototype as unknown as {
        respawnSession: (...args: unknown[]) => unknown;
      },
      'respawnSession',
    );
    const sendSpy = vi.spyOn(SessionManager.prototype, 'send');

    const sm = new SessionManager();
    const result = await sm.sendOrResume(SESSION_ID, 'review feedback text');

    expect(result).toBe(SESSION_ID);

    // No git worktree command of any kind ran against the preserved worktree.
    const gitWorktreeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(([cmd]) => String(cmd).includes('worktree'));
    expect(gitWorktreeCalls).toEqual([]);

    // The respawn used the preserved worktree path as the session cwd.
    expect(respawnSpy).toHaveBeenCalledTimes(1);
    expect(respawnSpy.mock.calls[0][1]).toBe(wtDir);

    // The pending message was delivered after the first event.
    expect(sendSpy).toHaveBeenCalledWith(SESSION_ID, 'review feedback text');

    // The uncommitted WIP file survived the resume, byte-identical.
    const survived = fs.readFileSync(
      path.join(wtDir, 'WIP-uncommitted.txt'),
      'utf8',
    );
    expect(survived).toBe(WIP_CONTENT);

    respawnSpy.mockRestore();
    sendSpy.mockRestore();
  });

  it('falls back to recreation when the preserved dir lacks a .git pointer', async () => {
    fs.rmSync(path.join(wtDir, '.git'));

    const sm = new SessionManager();
    await sm.sendOrResume(SESSION_ID, 'feedback');

    // Recreation path ran (worktree add attempted) — reuse correctly refused.
    const addCalls = vi
      .mocked(execSync)
      .mock.calls.filter(([cmd]) => String(cmd).includes('worktree add'));
    expect(addCalls.length).toBeGreaterThan(0);
  });
});
