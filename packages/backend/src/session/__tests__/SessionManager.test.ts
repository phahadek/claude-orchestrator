import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Module mocks ──────────────────────────────────────────────────────────────

let capturedSessions: ReturnType<typeof makeMockSession>[] = [];

type MockSession = EventEmitter & {
  prUrl?: string;
  hasEnded: boolean;
  sessionType: string;
  taskId?: string;
  run: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  endSession: ReturnType<typeof vi.fn>;
  gracefulPause: ReturnType<typeof vi.fn>;
  setPendingOverflowText: ReturnType<typeof vi.fn>;
  lockFileForNextInjection: ReturnType<typeof vi.fn>;
};

function makeMockSession(): MockSession {
  const ee = new EventEmitter() as MockSession;
  ee.prUrl = undefined;
  ee.hasEnded = false;
  ee.sessionType = 'standard';
  ee.run = vi.fn().mockReturnValue(new Promise(() => {}));
  ee.sendMessage = vi.fn();
  ee.kill = vi.fn().mockResolvedValue(undefined);
  ee.endSession = vi.fn();
  ee.gracefulPause = vi.fn().mockResolvedValue(undefined);
  ee.setPendingOverflowText = vi.fn();
  ee.lockFileForNextInjection = vi.fn();
  return ee;
}

vi.mock('../AgentSession', () => ({
  AgentSession: vi.fn().mockImplementation(() => {
    const s = makeMockSession();
    capturedSessions.push(s);
    return s;
  }),
  parseNotionPageIdDashed: vi.fn().mockReturnValue(''),
}));

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../DockerSessionRunner', () => ({
  DockerSessionRunner: vi.fn().mockImplementation(() => ({})),
  reapOrphanContainers: vi.fn(),
}));

vi.mock('../ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockResolvedValue(''),
}));
vi.mock('../orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue(''),
}));
vi.mock('../branchModel', () => ({
  resolveStartingPoint: vi
    .fn()
    .mockReturnValue({ startingPoint: 'dev', milestoneSlug: null }),
  ensureMilestoneBranch: vi.fn(),
  deriveBranchSlug: vi.fn().mockReturnValue('feature/my-task'),
}));
vi.mock('../orchestrator-config', () => ({
  loadOrchestratorConfig: vi
    .fn()
    .mockReturnValue({ mcp_servers: undefined, allowed_tools: [] }),
}));
vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../audit/AuditLog', () => ({ recordEvent: vi.fn() }));
vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../../routes/tasks', () => ({ emitTaskUpdated: vi.fn() }));
vi.mock('../../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('running'),
}));
vi.mock('../../tasks/taskId', () => ({
  formatTaskId: vi.fn().mockReturnValue('task-123'),
}));
vi.mock('../../notion/NotionClient', () => ({ parseSection: vi.fn() }));
vi.mock('../../github/reviewUtils', () => ({
  formatReviewFeedback: vi.fn().mockReturnValue('review-feedback'),
  formatApprovedVerdictMessage: vi.fn().mockReturnValue('approved'),
}));
vi.mock('../../security/scrubSecrets', () => ({
  scrubSecrets: vi.fn().mockImplementation((s: string) => s),
}));
vi.mock('../../config/corporateMode', () => ({
  getCorporateMode: vi
    .fn()
    .mockReturnValue({ gates: { dockerMandatory: false } }),
}));

vi.mock('../../db/queries', () => ({
  insertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateSessionWorktreePath: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  markSessionSuperseded: vi.fn(),
  insertEvent: vi.fn(),
  getSession: vi.fn(),
  getSessionsByStatus: vi.fn().mockReturnValue([]),
  getOtherRunningSessionsForTask: vi.fn().mockReturnValue([]),
  getRunningSessionsWithMergedOrClosedPR: vi.fn().mockReturnValue([]),
  getPRByNotionTaskId: vi.fn().mockReturnValue(null),
  getEventsBySession: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn().mockReturnValue(null),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  getStuckResultSessionRows: vi.fn().mockReturnValue([]),
  hasActiveSessionForTask: vi.fn().mockReturnValue(false),
  incrementTaskCrashCount: vi.fn().mockReturnValue(1),
  setSessionPauseReason: vi.fn(),
  setSessionLastErrorDetail: vi.fn(),
  setTaskPauseReason: vi.fn(),
}));

vi.mock('../../config', () => ({
  config: { maxConcurrentCodeSessions: 5 },
  getProjectById: vi.fn(),
  normalizePath: vi.fn().mockImplementation((p: string) => p),
  runtimeSettings: { session_mode: 'cli', corporate_mode_enabled: false },
}));

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('dev\n'),
  exec: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    // Default: existsSync returns true for all paths EXCEPT those ending in '.git'
    // so the worktree-reuse fast path is not triggered in tests that don't want it.
    existsSync: vi
      .fn()
      .mockImplementation((p: string) => !String(p).endsWith('.git')),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    readFileSync: vi.fn().mockReturnValue(''),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
    unlinkSync: vi.fn(),
    rmSync: vi.fn(),
  },
  existsSync: vi
    .fn()
    .mockImplementation((p: string) => !String(p).endsWith('.git')),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { SessionManager } from '../SessionManager';
import {
  updateSessionStatus,
  updateSessionWorktreePath,
  insertEvent,
  getSession,
  getSessionsByStatus,
  getStuckResultSessionRows,
  insertSession,
} from '../../db/queries';
import { getProjectById } from '../../config';
import { AgentSession } from '../AgentSession';
import { execSync } from 'child_process';
import { recordEvent } from '../../audit/AuditLog';
import * as fsModule from 'fs';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SESSION_ID = 'original-session-abc123';
const PROJECT_ID = 'project-1';
const PROJECT_DIR = '/project';

function makeDeadRow(sessionId = SESSION_ID) {
  return {
    session_id: sessionId,
    task_id: 'task-1',
    task_name: 'my-task',
    task_url: 'https://notion.so/task',
    project_context_url: 'https://notion.so/project',
    project_id: PROJECT_ID,
    // Use 'idle' — these tests exercise the resume path for sessions whose
    // subprocess exited (idle) and are being resumed with new feedback.
    // 'done'/'error'/'killed' sessions are refused by the terminal status guard.
    status: 'idle',
    session_type: 'standard',
    pr_url: 'https://github.com/org/repo/pull/1',
    worktree_path: `${PROJECT_DIR}/.claude/worktrees/${sessionId}`,
    started_at: 1000,
    ended_at: 2000,
  } as any;
}

/** An idle session with no PR — for testing guard bypass edge cases. */
function makeIdleNoPrRow(sessionId = SESSION_ID) {
  return {
    ...makeDeadRow(sessionId),
    pr_url: null,
  } as any;
}

function makeProject() {
  return {
    id: PROJECT_ID,
    projectDir: PROJECT_DIR,
    baseBranch: 'dev',
    gitMode: undefined,
  } as any;
}

// ── sendOrResume — dead session path ─────────────────────────────────────────

describe('sendOrResume — dead session path', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  // Helper: start sendOrResume and emit first message to unblock firstEvent.
  async function doResume(text = 'hello'): Promise<string> {
    const p = sm.sendOrResume(SESSION_ID, text);
    // Emit a boot message from the session to unblock the firstEvent promise.
    const sess = capturedSessions[0];
    sess.emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    return p;
  }

  it('returns the original session ID — no new UUID', async () => {
    const result = await doResume();
    expect(result).toBe(SESSION_ID);
  });

  it('constructs AgentSession with the original session ID', async () => {
    await doResume();
    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();
    const firstArg = vi.mocked(AgentSession).mock.calls[0][0];
    expect(firstArg).toBe(SESSION_ID);
  });

  it('updates DB row to running (does not insert a new row)', async () => {
    await doResume();
    expect(vi.mocked(updateSessionStatus)).toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
    // insertSession must NOT have been called with the original session ID
    const insertCalls = vi.mocked(insertSession).mock.calls;
    const insertedOriginal = insertCalls.some(
      ([s]) =>
        typeof s === 'object' &&
        s !== null &&
        (s as any).session_id === SESSION_ID,
    );
    expect(insertedOriginal).toBe(false);
  });

  it('updates worktree_path in DB for the resumed session', async () => {
    await doResume();
    expect(vi.mocked(updateSessionWorktreePath)).toHaveBeenCalledWith(
      SESSION_ID,
      expect.stringContaining(SESSION_ID),
    );
  });

  it('forwards pr_opened from resumed session to SessionManager', async () => {
    const prOpenedHandler = vi.fn();
    sm.on('pr_opened', prOpenedHandler);

    await doResume();

    const fakeJob = { prNumber: 42, repo: 'org/repo', sessionId: SESSION_ID };
    capturedSessions[0].emit('pr_opened', fakeJob);
    expect(prOpenedHandler).toHaveBeenCalledWith(fakeJob);
  });

  it('forwards push_detected from resumed session to SessionManager', async () => {
    const pushHandler = vi.fn();
    sm.on('push_detected', pushHandler);

    await doResume();

    const payload = { sha: 'abc123', sessionId: SESSION_ID };
    capturedSessions[0].emit('push_detected', payload);
    expect(pushHandler).toHaveBeenCalledWith(payload);
  });

  it('records the user_message event under the original session ID', async () => {
    await doResume('needs-changes feedback');
    expect(vi.mocked(insertEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: SESSION_ID,
        event_type: 'user_message',
        payload: 'needs-changes feedback',
      }),
    );
  });

  it('concurrency guard: two concurrent calls result in one spawn', async () => {
    // Launch both calls simultaneously — before either resolves.
    const p1 = sm.sendOrResume(SESSION_ID, 'first');
    const p2 = sm.sendOrResume(SESSION_ID, 'second');

    // Emit first message to unblock the firstEvent promise.
    // capturedSessions has only one entry because the second call reused the inflight
    // promise or saw the live session.
    const sess = capturedSessions[0];
    sess.emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both resolve to the original session ID.
    expect(r1).toBe(SESSION_ID);
    expect(r2).toBe(SESSION_ID);

    // AgentSession must be constructed exactly once — no double-spawn.
    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();

    // git worktree add must be called at most once.
    const worktreeAdds = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) =>
          typeof cmd === 'string' && (cmd as string).includes('worktree add'),
      );
    expect(worktreeAdds.length).toBeLessThanOrEqual(1);
  });
});

// ── sendOrResume — live session fast path ────────────────────────────────────

describe('sendOrResume — live session fast path', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('delivers via send() directly when session is live — no new spawn', async () => {
    // First: do a resume to get the session registered as live.
    const p = sm.sendOrResume(SESSION_ID, 'first');
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    await p;

    // Reset call counts.
    vi.mocked(AgentSession).mockClear();
    vi.mocked(insertEvent).mockClear();

    // Now call again — session is already in the map.
    sm.sendOrResume(SESSION_ID, 'live message');

    // No new session was created.
    expect(vi.mocked(AgentSession)).not.toHaveBeenCalled();
    // Message delivered directly via sendMessage.
    expect(capturedSessions[0].sendMessage).toHaveBeenCalledWith(
      'live message',
    );
  });

  it('updates status to running and emits session_status when live session is idle', async () => {
    // Establish the session as live (DB row has status 'idle' from beforeEach).
    const p = sm.sendOrResume(SESSION_ID, 'first');
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    await p;

    vi.mocked(updateSessionStatus).mockClear();
    const emittedMessages: unknown[] = [];
    sm.on('message', (msg) => emittedMessages.push(msg));

    await sm.sendOrResume(SESSION_ID, 'live message');

    expect(vi.mocked(updateSessionStatus)).toHaveBeenCalledWith(
      SESSION_ID,
      'running',
    );
    expect(emittedMessages).toContainEqual({
      type: 'session_status',
      sessionId: SESSION_ID,
      status: 'running',
    });
  });

  it('does not emit redundant status update when live session is already running', async () => {
    // Establish the session as live.
    const p = sm.sendOrResume(SESSION_ID, 'first');
    capturedSessions[0].emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });
    await p;

    vi.mocked(updateSessionStatus).mockClear();
    // Override: DB row already has status 'running'.
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'running',
    } as any);

    const emittedMessages: unknown[] = [];
    sm.on('message', (msg) => emittedMessages.push(msg));

    await sm.sendOrResume(SESSION_ID, 'live message');

    expect(vi.mocked(updateSessionStatus)).not.toHaveBeenCalled();
    expect(
      emittedMessages.filter((m: any) => m.type === 'session_status'),
    ).toHaveLength(0);
  });
});

// ── respawnSession shared helper ──────────────────────────────────────────────

describe('respawnSession shared helper — wires all three events', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('wires message, pr_opened, and push_detected forwarding on resumed session', async () => {
    const msgHandler = vi.fn();
    const prHandler = vi.fn();
    const pushHandler = vi.fn();
    sm.on('pr_opened', prHandler);
    sm.on('push_detected', pushHandler);

    const p = sm.sendOrResume(SESSION_ID, 'boot');
    const sess = capturedSessions[0];
    const bootMsg = {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'boot',
    };
    sess.emit('message', bootMsg);
    await p;

    // Add message handler after resume (it was registered by wireSession).
    sm.on('message', msgHandler);

    const afterMsg = {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'after',
    };
    sess.emit('message', afterMsg);
    sess.emit('pr_opened', { prNumber: 1, repo: 'org/repo' });
    sess.emit('push_detected', { sha: 'def456' });

    expect(msgHandler).toHaveBeenCalledWith(afterMsg);
    expect(prHandler).toHaveBeenCalledWith({ prNumber: 1, repo: 'org/repo' });
    expect(pushHandler).toHaveBeenCalledWith({ sha: 'def456' });
  });
});

// ── resumeOrphanSessions — boot recovery regression ──────────────────────────

describe('resumeOrphanSessions — boot recovery regression', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getStuckResultSessionRows).mockReturnValue([]);
  });

  it('reuses the original session ID and wires pr_opened', async () => {
    const orphanRow = { ...makeDeadRow(), status: 'running' };
    vi.mocked(getSessionsByStatus).mockReturnValue([orphanRow]);

    const prHandler = vi.fn();
    sm.on('pr_opened', prHandler);

    await sm.resumeOrphanSessions();

    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();
    // First constructor arg is the session ID.
    expect(vi.mocked(AgentSession).mock.calls[0][0]).toBe(SESSION_ID);

    // pr_opened must be forwarded.
    const sess = capturedSessions[0];
    const fakeJob = { prNumber: 5, repo: 'org/repo' };
    sess.emit('pr_opened', fakeJob);
    expect(prHandler).toHaveBeenCalledWith(fakeJob);
  });

  it('wires push_detected on orphan-recovered session', async () => {
    const orphanRow = { ...makeDeadRow(), status: 'running' };
    vi.mocked(getSessionsByStatus).mockReturnValue([orphanRow]);

    const pushHandler = vi.fn();
    sm.on('push_detected', pushHandler);

    await sm.resumeOrphanSessions();

    const sess = capturedSessions[0];
    sess.emit('push_detected', { sha: 'xyz' });
    expect(pushHandler).toHaveBeenCalledWith({ sha: 'xyz' });
  });
});

// ── needs_changes verdict routing — synthetic integration test ────────────────

describe('needs_changes verdict routing — synthetic integration', () => {
  it('records formatReviewFeedback under the original coder session ID', async () => {
    capturedSessions = [];
    vi.clearAllMocks();

    const sm = new SessionManager();
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    vi.mocked(getProjectById).mockReturnValue(makeProject());

    const feedbackText = 'please fix the missing test';

    // Simulate ReviewOrchestrator routing a needs_changes verdict:
    //   await this.sessionManager.sendOrResume(prRow.session_id, formatReviewFeedback(result, 0))
    const routingPromise = sm.sendOrResume(SESSION_ID, feedbackText);

    // CLI emits first event — unblocks firstEvent inside _doSendOrResume.
    const sess = capturedSessions[0];
    sess.emit('message', {
      type: 'session_event',
      sessionId: SESSION_ID,
      eventType: 'system',
      content: 'boot',
    });

    await routingPromise;

    // The user_message event must be recorded under the ORIGINAL coder session ID.
    expect(vi.mocked(insertEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: SESSION_ID,
        event_type: 'user_message',
        payload: feedbackText,
      }),
    );
  });
});

// ── cleanupWorktree chokepoint guard ─────────────────────────────────────────

describe('cleanupWorktree chokepoint guard', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('idle session with open PR — no git worktree remove invoked', () => {
    vi.mocked(getSession).mockReturnValue(
      makeDeadRow(), // status='idle', pr_url set
    );
    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
      'https://github.com/org/repo/pull/1',
      PROJECT_DIR,
    );
    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(0);
  });

  it('idle session with NO PR — teardown proceeds (no guard)', () => {
    vi.mocked(getSession).mockReturnValue(makeIdleNoPrRow());
    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
      undefined,
      PROJECT_DIR,
    );
    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(1);
  });

  it('done session with PR — teardown proceeds (guard only fires for idle)', () => {
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'done',
    });
    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
      'https://github.com/org/repo/pull/1',
      PROJECT_DIR,
    );
    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(1);
  });
});

// ── worktree_remove_failed audit event ───────────────────────────────────────

describe('cleanupWorktree — worktree_remove_failed audit on removal error', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    // Session is done — guard won't fire
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'done' });
  });

  it('emits worktree_remove_failed audit event when git worktree remove throws', () => {
    const removeErr = Object.assign(new Error('remove failed'), {
      stderr: Buffer.from('fatal: not a worktree'),
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('worktree remove')) throw removeErr;
      return 'feature/my-task\n';
    });

    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'worktree_remove_failed',
        actor_type: 'system',
        actor_id: SESSION_ID,
        payload: expect.objectContaining({
          stderr: expect.stringContaining('fatal: not a worktree'),
          fallbackOk: expect.any(Boolean),
        }),
      }),
    );
  });
});

// ── cleanupWorktree — post-remove prune (Fix A) ───────────────────────────────

describe('cleanupWorktree — git worktree prune always runs', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'done' });
  });

  it('calls git worktree prune after a successful worktree remove', () => {
    vi.mocked(execSync).mockReturnValue('');

    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
      undefined,
      PROJECT_DIR,
    );

    const pruneCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree prune'),
      );
    expect(pruneCalls).toHaveLength(1);
  });

  it('calls git worktree prune after a failed worktree remove', () => {
    const removeErr = Object.assign(new Error('remove failed'), {
      stderr: Buffer.from('fatal: not a working tree'),
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('worktree remove')) throw removeErr;
      return '';
    });

    (sm as any).cleanupWorktree(
      SESSION_ID,
      `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`,
      undefined,
      PROJECT_DIR,
    );

    const pruneCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree prune'),
      );
    expect(pruneCalls).toHaveLength(1);
  });
});

// ── cleanupWorktree — fs.rmSync fallback (Fix B) ─────────────────────────────

describe('cleanupWorktree — fs.rmSync fallback on worktree remove failure', () => {
  let sm: SessionManager;
  const worktreePath = `${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'done' });
  });

  it('attempts fs.rmSync when git worktree remove fails and dir exists', () => {
    const removeErr = Object.assign(new Error('remove failed'), {
      stderr: Buffer.from('Invalid argument'),
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('worktree remove')) throw removeErr;
      return '';
    });
    // existsSync returns true for the worktree path (default mock behavior)
    vi.mocked((fsModule as any).default.existsSync).mockReturnValue(true);

    (sm as any).cleanupWorktree(
      SESSION_ID,
      worktreePath,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked((fsModule as any).default.rmSync)).toHaveBeenCalledWith(
      worktreePath,
      { recursive: true, force: true, maxRetries: 3, retryDelay: 500 },
    );
  });

  it('sets fallbackOk: true in audit event when fs.rmSync succeeds', () => {
    const removeErr = Object.assign(new Error('remove failed'), {
      stderr: Buffer.from('Invalid argument'),
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('worktree remove')) throw removeErr;
      return '';
    });
    vi.mocked((fsModule as any).default.existsSync).mockReturnValue(true);
    vi.mocked((fsModule as any).default.rmSync).mockReturnValue(undefined);

    (sm as any).cleanupWorktree(
      SESSION_ID,
      worktreePath,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'worktree_remove_failed',
        payload: expect.objectContaining({ fallbackOk: true }),
      }),
    );
  });

  it('sets fallbackOk: false in audit event when fs.rmSync also fails', () => {
    const removeErr = Object.assign(new Error('remove failed'), {
      stderr: Buffer.from('Invalid argument'),
    });
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('worktree remove')) throw removeErr;
      return '';
    });
    vi.mocked((fsModule as any).default.existsSync).mockReturnValue(true);
    vi.mocked((fsModule as any).default.rmSync).mockImplementation(() => {
      throw new Error('EBUSY');
    });

    (sm as any).cleanupWorktree(
      SESSION_ID,
      worktreePath,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'worktree_remove_failed',
        payload: expect.objectContaining({ fallbackOk: false }),
      }),
    );
  });

  it('does NOT attempt fs.rmSync when git worktree remove succeeds', () => {
    vi.mocked(execSync).mockReturnValue('');

    (sm as any).cleanupWorktree(
      SESSION_ID,
      worktreePath,
      undefined,
      PROJECT_DIR,
    );

    expect(vi.mocked((fsModule as any).default.rmSync)).not.toHaveBeenCalled();
  });
});

// ── terminal cleanup: endSession + markSessionErrored for idle sessions ───────

describe('terminal cleanup for idle sessions (not live)', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
  });

  it('endSession on non-live idle session triggers worktree teardown', () => {
    // Simulate: PR merged → markSessionDone → session now 'done'
    vi.mocked(getSession).mockReturnValue({ ...makeDeadRow(), status: 'done' });

    sm.endSession(SESSION_ID);

    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(1);
  });

  it('endSession on live session does NOT trigger worktree teardown directly', async () => {
    // Set up mocks BEFORE calling sendOrResume
    vi.mocked(getSession).mockReturnValue(makeDeadRow()); // idle — can resume
    // Register a live session
    const p = sm.sendOrResume(SESSION_ID, 'boot');
    capturedSessions[0].emit('message', {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'boot',
    });
    await p;

    vi.mocked(execSync).mockClear();
    sm.endSession(SESSION_ID);

    // endSession on a live session calls session.endSession() — no direct cleanup
    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(0);
  });

  it('markSessionErrored on non-live session (PR closed) triggers worktree teardown', () => {
    // Session is now 'error' (DB already updated). No task_id so getTaskBackend is skipped.
    vi.mocked(getSession).mockReturnValue({
      ...makeDeadRow(),
      status: 'error',
      task_id: null,
    });

    sm.markSessionErrored(SESSION_ID, 'error', 'pr_closed');

    const removeCalls = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree remove'),
      );
    expect(removeCalls).toHaveLength(1);
  });
});

// ── sendOrResume: surviving worktree reuse ────────────────────────────────────

describe('sendOrResume — surviving worktree reuse (idle resume fast path)', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    // Session is idle with PR and a worktree_path
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    // Make existsSync return true for the .git file → fast path triggered
    vi.mocked(fsModule.existsSync).mockImplementation(() => true);
    vi.mocked((fsModule as any).default.existsSync).mockImplementation(
      () => true,
    );
  });

  async function doResume(text = 'hello'): Promise<string> {
    const p = sm.sendOrResume(SESSION_ID, text);
    const sess = capturedSessions[0];
    sess.emit('message', {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'boot',
    });
    return p;
  }

  it('no git worktree add when recorded worktree has .git file', async () => {
    await doResume();
    const worktreeAdds = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree add'),
      );
    expect(worktreeAdds).toHaveLength(0);
  });

  it('spawns CLI with the recorded worktree path as cwd', async () => {
    await doResume();
    expect(vi.mocked(AgentSession)).toHaveBeenCalledOnce();
    // The AgentSession constructor receives worktreePath as its 5th arg
    const [, , , , worktreePath] = vi.mocked(AgentSession).mock.calls[0];
    expect(worktreePath).toBe(`${PROJECT_DIR}/.claude/worktrees/${SESSION_ID}`);
  });

  it('still creates AgentSession with original session ID', async () => {
    await doResume();
    expect(vi.mocked(AgentSession).mock.calls[0][0]).toBe(SESSION_ID);
  });
});

describe('sendOrResume — missing worktree falls through to recreation', () => {
  let sm: SessionManager;

  beforeEach(() => {
    capturedSessions = [];
    vi.clearAllMocks();
    sm = new SessionManager();
    vi.mocked(getProjectById).mockReturnValue(makeProject());
    vi.mocked(getSession).mockReturnValue(makeDeadRow());
    // .git file does NOT exist → fast path skipped → git worktree add path
    vi.mocked(fsModule.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
    vi.mocked((fsModule as any).default.existsSync).mockImplementation(
      (p: string) => !String(p).endsWith('.git'),
    );
  });

  it('calls git worktree add when recorded worktree is missing', async () => {
    const p = sm.sendOrResume(SESSION_ID, 'hello');
    capturedSessions[0].emit('message', {
      type: 'session_event' as const,
      sessionId: SESSION_ID,
      eventType: 'system' as const,
      content: 'boot',
    });
    await p;

    const worktreeAdds = vi
      .mocked(execSync)
      .mock.calls.filter(
        ([cmd]) => typeof cmd === 'string' && cmd.includes('worktree add'),
      );
    expect(worktreeAdds.length).toBeGreaterThanOrEqual(1);
  });
});
