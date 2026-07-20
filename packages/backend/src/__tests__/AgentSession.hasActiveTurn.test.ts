/**
 * Tests for AgentSession.hasActiveTurn(): the turn-in-flight accessor that lets
 * SessionManager.enqueueFeedback distinguish a live-but-idle in-map session
 * (safe to wake immediately) from a live mid-turn session (must wait for the
 * next turn boundary so a delivery never interleaves into an in-flight turn).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

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
    pid: 54321,
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

vi.mock('../db/queries', () => ({
  getGrantedCapabilities: vi.fn(() => []),
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
  listUndeliveredInboxItems: vi.fn(() => []),
  markInboxItemsDelivered: vi.fn(),
  ackPendingComments: vi.fn(),
}));

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

import { AgentSession } from '../session/AgentSession';
import type { TaskBackend } from '../tasks/TaskBackend';

function fakeTaskBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    attachPR: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    fetchTaskPage: vi.fn(async () => ''),
  };
}

function makeSession(sessionId: string) {
  return new AgentSession(
    sessionId,
    'https://notion.so/task',
    'https://notion.so/ctx',
    fakeTaskBackend(),
    '/tmp/worktree',
    'notion:task-abc',
  );
}

describe('AgentSession.hasActiveTurn()', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
  });

  it('starts true, flips false on the result event, and flips true again on sendMessage', async () => {
    const session = makeSession('sess-turn-1');
    expect(session.hasActiveTurn()).toBe(true);

    const runPromise = session.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(session.hasActiveTurn()).toBe(true);

    mockProc.stdout.push(
      JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1 }) +
        '\n',
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(session.hasActiveTurn()).toBe(false);

    session.sendMessage('follow-up feedback');
    expect(session.hasActiveTurn()).toBe(true);

    (
      session as unknown as { isPausingForShutdown: boolean }
    ).isPausingForShutdown = true;
    mockProc.stdout.push(null);
    mockProc.proc.emit('exit', 0);
    await runPromise;
  }, 8_000);
});
