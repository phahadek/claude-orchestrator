import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// Mocks must be hoisted before AgentSession is imported.

function createMockProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_chunk: unknown, _enc: unknown, cb: () => void) {
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 12345,
    exitCode: null,
  });
  return { proc, stdout, stderr };
}

let mockProc: ReturnType<typeof createMockProc>;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc.proc),
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  updateSessionStatus: vi.fn(),
  markSessionIdle: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  incrementTokens: vi.fn(),
  incrementCompactionCount: vi.fn(),
  setContextOccupancy: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  setPauseReason: vi.fn(),
  setSessionPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  getSessionTags: vi.fn(() => null),
  setSessionTags: vi.fn(),
  resetTaskCrashCount: vi.fn(),
  setHeadSha: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNotionTaskId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  getSession: vi.fn(() => null),
  getProjectRowById: vi.fn(() => null),
  listMilestonesByProject: vi.fn(() => []),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
  countPushFailureEvents: vi.fn(() => 0),
}));

vi.mock('../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(async () => 'feature/my-task'),
  hasNonEmptyDiff: vi.fn(async () => false),
}));

vi.mock('../session/sessionRecovery', () => ({
  recoverSession: vi.fn(async () => {}),
}));

import { AgentSession, MAX_REBASE_NUDGES } from '../session/AgentSession';
import { execSync } from 'child_process';
import { getPRBySessionId, setPauseReason } from '../db/queries';
import type { ISessionManager } from '../session/SessionAuditor';
import type { TaskBackend } from '../tasks/TaskBackend';

/** Make execSync return diverged-branch state for every handlePushDetected call. */
function mockDivergedBranch() {
  vi.mocked(execSync).mockImplementation((cmd) => {
    const c = String(cmd);
    if (c.includes('rev-parse --abbrev-ref HEAD'))
      return Buffer.from('feature/my-task');
    if (c.includes('rev-parse HEAD')) return Buffer.from('abc123local');
    if (c.includes('ls-remote origin'))
      return Buffer.from('def456remote\trefs/heads/feature/my-task');
    if (c.includes('rev-list')) return Buffer.from('2\t3'); // behind=2, ahead=3
    return Buffer.from('');
  });
}

function fakeTaskBackend(): TaskBackend {
  return {
    fetchTasks: vi.fn(async () => []),
    updateTaskStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
    getTask: vi.fn(async () => null),
  } as unknown as TaskBackend;
}

function makeSessionManager(): ISessionManager & {
  sendOrResume: ReturnType<typeof vi.fn>;
} {
  return {
    send: vi.fn(),
    isAlive: vi.fn(() => true),
    sendOrResume: vi.fn().mockResolvedValue('diverged-session-id'),
  };
}

/** Simulate one Bash git push tool_use + tool_result pair with a unique message id. */
async function simulatePush(stdout: Readable, n: number) {
  const toolUseId = `tool-push-${n}`;
  stdout.push(
    JSON.stringify({
      type: 'assistant',
      message: {
        id: `msg-push-${n}`,
        model: 'claude-sonnet',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'Bash',
            input: { command: 'git push origin feature/my-task' },
          },
        ],
      },
    }) + '\n',
  );
  await new Promise((r) => setTimeout(r, 10));
  stdout.push(
    JSON.stringify({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [{ type: 'text', text: 'Everything up-to-date' }],
    }) + '\n',
  );
  await new Promise((r) => setTimeout(r, 20));
}

describe('AgentSession — diverged-branch rebase routing', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
  });

  it('sets pause_reason and sends a rebase nudge via sendOrResume on diverged branch', async () => {
    mockDivergedBranch();
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'org/repo',
      base_branch: 'dev',
    } as any);

    const sessionManager = makeSessionManager();
    const session = new AgentSession(
      'diverged-session-1',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeTaskBackend(),
      '/worktree',
      'task-id',
      undefined,
      undefined,
      'standard',
      sessionManager,
    );

    const runPromise = session.run();

    await simulatePush(mockProc.stdout, 1);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'org/repo',
      'diverged_branch',
    );
    expect(sessionManager.sendOrResume).toHaveBeenCalledTimes(1);
    expect(sessionManager.sendOrResume).toHaveBeenCalledWith(
      'diverged-session-1',
      expect.stringContaining('rebase'),
    );
  });

  it('still sets pause_reason (AutoMerger skips the PR) even when a nudge is sent', async () => {
    mockDivergedBranch();
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 99,
      repo: 'org/repo',
      base_branch: 'dev',
    } as any);

    const sessionManager = makeSessionManager();
    const session = new AgentSession(
      'diverged-session-2',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeTaskBackend(),
      '/worktree',
      'task-id',
      undefined,
      undefined,
      'standard',
      sessionManager,
    );

    const runPromise = session.run();

    await simulatePush(mockProc.stdout, 1);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    // pause_reason must be set so AutoMerger skips this PR (pr.pause_reason !== null)
    expect(setPauseReason).toHaveBeenCalledWith(
      99,
      'org/repo',
      'diverged_branch',
    );
  });

  it(`stops nudging after ${MAX_REBASE_NUDGES} rebase attempts (no infinite nudging)`, async () => {
    mockDivergedBranch();
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 7,
      repo: 'org/repo',
      base_branch: 'dev',
    } as any);

    const sessionManager = makeSessionManager();
    const session = new AgentSession(
      'diverged-session-3',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeTaskBackend(),
      '/worktree',
      'task-id',
      undefined,
      undefined,
      'standard',
      sessionManager,
    );

    const runPromise = session.run();

    // Simulate MAX_REBASE_NUDGES + 1 pushes — the last one must NOT trigger a nudge.
    for (let i = 1; i <= MAX_REBASE_NUDGES + 1; i++) {
      await simulatePush(mockProc.stdout, i);
    }

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    // Nudges capped at MAX_REBASE_NUDGES
    expect(sessionManager.sendOrResume).toHaveBeenCalledTimes(
      MAX_REBASE_NUDGES,
    );
    // All detections set a pause reason (PR stays paused)
    expect(setPauseReason).toHaveBeenCalledTimes(MAX_REBASE_NUDGES + 1);
    // First MAX detections use 'diverged_branch'; final detection escalates to 'diverged_branch_unresolved'
    expect(setPauseReason).toHaveBeenLastCalledWith(
      7,
      'org/repo',
      'diverged_branch_unresolved',
    );
  });
});
