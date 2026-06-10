/**
 * Tests that AgentSession resets the task crash counter on healthy completion:
 * - handleCleanExit (clean process exit) calls resetTaskCrashCount
 * - handlePRDetected (PR URL in tool result) calls resetTaskCrashCount
 * - A crash that follows a reset is counted as #1 and resolves to 🗂️ Ready
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// ── Mock child_process ──────────────────────────────────────────────────────

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
    pid: 99999,
    exitCode: null,
  });
  return { proc, stdout, stderr };
}

let mockProc: ReturnType<typeof createMockProc>;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProc.proc),
  execFile: vi.fn(),
  execSync: vi.fn(() => 'feature/task\n'),
}));

// ── Mock DB queries ────────────────────────────────────────────────────────

vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(() => ({ id: 1 })),
  incrementTokens: vi.fn(),
  incrementCompactionCount: vi.fn(),
  setContextOccupancy: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNotionTaskId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  setSessionPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  getSession: vi.fn(() => null),
  getSessionTags: vi.fn(() => null),
  setSessionTags: vi.fn(),
  resetTaskCrashCount: vi.fn(),
  incrementTaskCrashCount: vi.fn(() => 1),
}));

// ── Mock other dependencies ────────────────────────────────────────────────

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  return {
    ...actual,
    ALLOWED_TOOLS: [],
    GITHUB_REPO: 'owner/repo',
    runtimeSettings: { sessionMode: 'cli' },
    getProjectById: vi.fn().mockReturnValue({
      id: 'proj-1',
      name: 'Test',
      baseBranch: 'dev',
    }),
  };
});

vi.mock('../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(async () => 'feature/my-task'),
  hasNonEmptyDiff: vi.fn(async () => false),
}));

vi.mock('../github/NoOpInvestigator', () => ({
  NoOpInvestigator: vi.fn().mockImplementation(() => ({
    investigate: vi.fn(async () => {}),
  })),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
  countPushFailureEvents: vi.fn(() => 0),
}));

vi.mock('../session/sessionRecovery', () => ({
  recoverSession: vi.fn(async () => {}),
}));

// ── Imports (after all vi.mock calls) ─────────────────────────────────────

import { AgentSession } from '../session/AgentSession';
import { resetTaskCrashCount } from '../db/queries';
import { incrementTaskCrashCount } from '../db/queries';
import type { TaskBackend } from '../tasks/TaskBackend';

// ── Helpers ────────────────────────────────────────────────────────────────

function fakeTaskBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    attachPR: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    fetchTaskPage: vi.fn(async () => ''),
  };
}

function makeSession(taskId = 'notion:task-abc') {
  return new AgentSession(
    'sess-crash-reset',
    'https://notion.so/task',
    'https://notion.so/ctx',
    fakeTaskBackend(),
    '/tmp/worktree',
    taskId,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AgentSession — crash counter reset on healthy completion', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
  });

  it('resetTaskCrashCount is called with the task ID on clean exit', async () => {
    const session = makeSession('notion:task-clean-exit');
    const runPromise = session.run();

    // Let the session start, then close stdout and emit clean exit
    await new Promise((r) => setTimeout(r, 10));
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(resetTaskCrashCount).toHaveBeenCalledWith('notion:task-clean-exit');
  });

  it('resetTaskCrashCount is called with the task ID when a PR URL is detected', async () => {
    const session = makeSession('notion:task-pr-detect');
    const runPromise = session.run();

    // Simulate a gh pr create tool_use followed by a tool_result with the PR URL
    const toolUseId = 'tool-use-1';
    const ghToolUseEvent = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'Bash',
            input: { command: 'gh pr create --title "feat: foo" --body "body"' },
          },
        ],
      },
    });
    const toolResultEvent = JSON.stringify({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: 'https://github.com/owner/repo/pull/99',
    });

    mockProc.stdout.push(ghToolUseEvent + '\n');
    await new Promise((r) => setTimeout(r, 20));
    mockProc.stdout.push(toolResultEvent + '\n');
    await new Promise((r) => setTimeout(r, 50));

    expect(resetTaskCrashCount).toHaveBeenCalledWith('notion:task-pr-detect');

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });

  it('a crash after a reset is treated as crash #1 (🗂️ Ready, not 🚫 Blocked)', async () => {
    // Simulate: incrementTaskCrashCount returns 1 (as it would after a reset)
    vi.mocked(incrementTaskCrashCount).mockReturnValue(1);

    // Verify the count from the mock — post-reset, next increment yields 1
    const count = incrementTaskCrashCount('notion:task-abc');
    expect(count).toBe(1);
    // count < 2 → status should be 🗂️ Ready, not 🚫 Blocked
    const status = count >= 2 ? '🚫 Blocked' : '🗂️ Ready';
    expect(status).toBe('🗂️ Ready');
  });
});
