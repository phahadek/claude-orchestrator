/**
 * Tests for the exit-handler delivery-race backstop (AgentSession.run()).
 *
 * A non-zero process exit immediately preceded by a successful turn (or with
 * an inbox item still undelivered) means the crash likely landed in the
 * post-turn/teardown window rather than reflecting a genuine failure — the
 * session should --resume rather than terminally error. A non-zero exit with
 * no preceding success and no pending delivery still fails terminally.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { makeEventRow } from '../../test/helpers/eventFixtures';

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
import { spawn } from 'child_process';
import {
  getEventsBySession,
  listUndeliveredInboxItems,
  updateSessionStatus,
} from '../db/queries';
import type { ServerMessage } from '../ws/types';
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

describe('AgentSession — exit-handler delivery-race backstop', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
    vi.mocked(getEventsBySession).mockReturnValue([]);
    vi.mocked(listUndeliveredInboxItems).mockReturnValue([]);
  });

  it('resumes (does not terminally error) on a non-zero exit immediately after a successful result event', async () => {
    vi.mocked(getEventsBySession).mockReturnValue([
      makeEventRow('result').live,
    ] as ReturnType<typeof getEventsBySession>);

    const session = makeSession('sess-race-1');
    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();

    // Simulate the process crashing right after emitting its result event.
    // Close stdout first so the runner's readline-drain guard doesn't add a
    // spurious 5s wait before the exit code is processed.
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 1);
    await new Promise((r) => setTimeout(r, 30));

    // The retry-not-terminal decision is synchronous: broadcasts 'retrying'
    // and never reaches the terminal error path.
    expect(
      messages.some(
        (m) =>
          m.type === 'session_status' &&
          (m as { status?: string }).status === 'retrying',
      ),
    ).toBe(true);
    expect(messages.some((m) => m.type === 'session_ended')).toBe(false);
    expect(updateSessionStatus).not.toHaveBeenCalledWith(
      'sess-race-1',
      'error',
      expect.anything(),
    );

    // Short-circuit the pending backoff wait so the test doesn't need to sit
    // through the real 5s delay — flips the same shutdown flag gracefulPause()
    // sets, which the retry loop already checks before respawning.
    (
      session as unknown as { isPausingForShutdown: boolean }
    ).isPausingForShutdown = true;
    await runPromise;

    // Only the original spawn happened — the shutdown flag pre-empted the resume.
    expect(spawn).toHaveBeenCalledTimes(1);
  }, 8_000);

  it('resumes when an undelivered inbox item is pending, even without a preceding successful result', async () => {
    vi.mocked(getEventsBySession).mockReturnValue([]);
    vi.mocked(listUndeliveredInboxItems).mockReturnValue([
      {
        id: 1,
        session_id: 'sess-race-2',
        source: 'system:nudge',
        payload: 'please open a PR',
        enqueued_at: Date.now(),
        delivered_at: null,
      },
    ] as ReturnType<typeof listUndeliveredInboxItems>);

    const session = makeSession('sess-race-2');
    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 1);
    await new Promise((r) => setTimeout(r, 30));

    expect(
      messages.some(
        (m) =>
          m.type === 'session_status' &&
          (m as { status?: string }).status === 'retrying',
      ),
    ).toBe(true);
    expect(updateSessionStatus).not.toHaveBeenCalledWith(
      'sess-race-2',
      'error',
      expect.anything(),
    );

    (
      session as unknown as { isPausingForShutdown: boolean }
    ).isPausingForShutdown = true;
    await runPromise;

    expect(spawn).toHaveBeenCalledTimes(1);
  }, 8_000);

  it('still fails terminally on a non-zero exit with no preceding success and no pending delivery', async () => {
    vi.mocked(getEventsBySession).mockReturnValue([]);
    vi.mocked(listUndeliveredInboxItems).mockReturnValue([]);

    const session = makeSession('sess-race-3');
    const messages: ServerMessage[] = [];
    session.on('message', (msg: ServerMessage) => messages.push(msg));

    const runPromise = session.run();
    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 1);
    await runPromise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(updateSessionStatus).toHaveBeenCalledWith(
      'sess-race-3',
      'error',
      expect.any(Number),
    );
    expect(messages.some((m) => m.type === 'session_ended')).toBe(true);
  });
});
