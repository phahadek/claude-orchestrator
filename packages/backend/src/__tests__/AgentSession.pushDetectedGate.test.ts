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

import { AgentSession } from '../session/AgentSession';
import { execSync } from 'child_process';
import { getPRBySessionId } from '../db/queries';
import type { TaskBackend } from '../tasks/TaskBackend';

function fakeTaskBackend(): TaskBackend {
  return {
    fetchTasks: vi.fn(async () => []),
    updateTaskStatus: vi.fn(async () => {}),
    attachPR: vi.fn(async () => {}),
    getTask: vi.fn(async () => null),
  } as unknown as TaskBackend;
}

/** Mock execSync to return a fixed HEAD SHA for rev-parse HEAD,
 *  and empty for all other git calls so auto-push is skipped. */
function mockHeadSha(sha: string) {
  vi.mocked(execSync).mockImplementation((cmd) => {
    const c = String(cmd);
    if (c.includes('rev-parse HEAD') && !c.includes('--abbrev-ref'))
      return Buffer.from(sha);
    if (c.includes('rev-parse --abbrev-ref HEAD'))
      return Buffer.from('feature/my-task');
    if (c.includes('ls-remote origin'))
      return Buffer.from(`${sha}\trefs/heads/feature/my-task`);
    // ahead=0, behind=0 — suppress auto-push
    if (c.includes('rev-list')) return Buffer.from('0\t0');
    return Buffer.from('');
  });
}

/** Emit a turn-end result event to stdout. */
async function emitResultEvent(stdout: Readable, n: number) {
  stdout.push(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      stop_reason: 'end_turn',
      session_id: `sess-${n}`,
    }) + '\n',
  );
  await new Promise((r) => setTimeout(r, 20));
}

describe('AgentSession — push_detected SHA gate', () => {
  beforeEach(() => {
    mockProc = createMockProc();
    vi.clearAllMocks();
  });

  it('emits push_detected exactly once for two consecutive turns with the same HEAD SHA', async () => {
    const SHA = 'aabbcc1122334455aabbcc1122334455aabbcc11';
    mockHeadSha(SHA);

    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 10,
      repo: 'org/repo',
      review_session_id: 'review-sess-1',
    } as any);

    const session = new AgentSession(
      'gate-session-1',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeTaskBackend(),
      '/worktree',
      'task-id',
    );

    const pushEvents: unknown[] = [];
    session.on('push_detected', (p: unknown) => pushEvents.push(p));

    const runPromise = session.run();

    // Turn 1 — SHA is new (lastSignalledHeadSha is null), should emit
    await emitResultEvent(mockProc.stdout, 1);
    // Turn 2 — same SHA, should NOT emit again
    await emitResultEvent(mockProc.stdout, 2);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(pushEvents).toHaveLength(1);
  });

  it('emits push_detected on each turn that advances HEAD', async () => {
    // currentSha is updated between turns to simulate HEAD advancing.
    // All execSync calls within a single turn see the same SHA so the
    // auto-push logic (which also calls rev-parse HEAD) stays consistent.
    let currentSha = 'sha-before-000000000000000000000000000000000000';
    vi.mocked(execSync).mockImplementation((cmd) => {
      const c = String(cmd);
      if (c.includes('rev-parse HEAD') && !c.includes('--abbrev-ref'))
        return Buffer.from(currentSha);
      if (c.includes('rev-parse --abbrev-ref HEAD'))
        return Buffer.from('feature/my-task');
      // ls-remote matches local HEAD so auto-push is always skipped
      if (c.includes('ls-remote origin'))
        return Buffer.from(`${currentSha}\trefs/heads/feature/my-task`);
      if (c.includes('rev-list')) return Buffer.from('0\t0');
      return Buffer.from('');
    });

    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 20,
      repo: 'org/repo',
      review_session_id: 'review-sess-2',
    } as any);

    const session = new AgentSession(
      'gate-session-2',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeTaskBackend(),
      '/worktree',
      'task-id',
    );

    const pushEvents: unknown[] = [];
    session.on('push_detected', (p: unknown) => pushEvents.push(p));

    const runPromise = session.run();

    // Turn 1 — new SHA, should emit
    await emitResultEvent(mockProc.stdout, 1);
    // Advance HEAD between turns (simulates agent making a commit)
    currentSha = 'sha-after-111111111111111111111111111111111111';
    // Turn 2 — HEAD advanced (different SHA), should emit again
    await emitResultEvent(mockProc.stdout, 2);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;

    expect(pushEvents).toHaveLength(2);
  });

  it('emits push_detected on first PR creation (lastSignalledHeadSha is null)', async () => {
    const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    mockHeadSha(SHA);

    // Before PR creation: no review_session_id
    vi.mocked(getPRBySessionId).mockReturnValueOnce(null);
    // After PR creation: review_session_id is set (first time)
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 30,
      repo: 'org/repo',
      review_session_id: 'review-sess-3',
    } as any);

    const session = new AgentSession(
      'gate-session-3',
      'https://notion.so/task',
      'https://notion.so/ctx',
      fakeTaskBackend(),
      '/worktree',
      'task-id',
    );

    const pushEvents: unknown[] = [];
    session.on('push_detected', (p: unknown) => pushEvents.push(p));

    const runPromise = session.run();

    // Turn before PR exists — no push_detected (review_session_id is null)
    await emitResultEvent(mockProc.stdout, 1);
    expect(pushEvents).toHaveLength(0);

    // First turn after PR creation with review_session_id set —
    // lastSignalledHeadSha is null so gate passes and push_detected fires
    await emitResultEvent(mockProc.stdout, 2);
    expect(pushEvents).toHaveLength(1);

    mockProc.stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    mockProc.proc.emit('exit', 0);
    await runPromise;
  });
});
