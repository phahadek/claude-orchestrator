import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (before any imports that pull in module-level side-effects) ─────────

vi.mock('../db/queries', () => ({
  upsertPullRequest: vi.fn(),
  getPRByNumber: vi.fn(() => null),
  getProjectRowById: vi.fn(() => null),
  getSession: vi.fn(() => null),
  insertLocalBranch: vi.fn(),
  insertSessionAudit: vi.fn(),
  getPRByNotionTaskId: vi.fn(() => null),
  getEventsBySession: vi.fn(() => []),
}));

vi.mock('../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(async () => 'feature/my-task'),
  hasNonEmptyDiff: vi.fn(async () => false),
}));

vi.mock('../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../github/NoOpInvestigator', () => ({
  NoOpInvestigator: vi.fn().mockImplementation(() => ({
    investigate: vi.fn(async () => {}),
  })),
}));

vi.mock('../session/SessionAuditor', () => ({
  SessionAuditor: vi.fn().mockImplementation(() => ({
    audit: vi.fn(async () => ({
      sessionId: 'sess-1',
      prOpened: true,
      prTargetsBranch: 'dev',
      taskStatusAfter: '👀 In Review',
      violations: [],
      specMismatch: null,
      auditedAt: new Date().toISOString(),
    })),
  })),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

// ── Imports (after vi.mock calls) ─────────────────────────────────────────────

import { recoverSession } from '../session/sessionRecovery';
import type { RecoverSessionOpts } from '../session/sessionRecovery';
import {
  upsertPullRequest,
  getPRByNumber,
  insertSessionAudit,
} from '../db/queries';
import { recordEvent } from '../audit/AuditLog';
import { emitTaskUpdated } from '../routes/tasks';
import type { TaskBackend } from '../tasks/TaskBackend';
import type { ServerMessage } from '../ws/types';

function makeTaskBackend(): TaskBackend {
  return {
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    attachPR: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    fetchTaskPage: vi.fn(async () => ''),
    fetchNonMilestoneTasks: vi.fn(async () => []),
  } as unknown as TaskBackend;
}

function baseOpts(overrides?: Partial<RecoverSessionOpts>): RecoverSessionOpts {
  return {
    scope: 'clean_exit',
    prUrl: undefined,
    prDetectedLive: false,
    sessionType: 'standard',
    taskId: 'task-abc',
    projectId: 'proj-1',
    worktreePath: '/worktree',
    taskUrl: 'https://notion.so/task',
    projectContextUrl: 'https://notion.so/ctx',
    githubClient: undefined,
    taskBackend: makeTaskBackend(),
    sessionManager: undefined,
    broadcast: vi.fn(),
    emitPrOpened: vi.fn(),
    ...overrides,
  };
}

describe('recoverSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('broadcasts session_ended on clean exit with no PR', async () => {
    const broadcast = vi.fn();
    await recoverSession('sess-1', baseOpts({ broadcast }));
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session_ended',
        sessionId: 'sess-1',
        status: 'done',
      }),
    );
  });

  it('calls attachPR when prUrl present and not detected live', async () => {
    const taskBackend = makeTaskBackend();
    await recoverSession(
      'sess-2',
      baseOpts({
        prUrl: 'https://github.com/owner/repo/pull/42',
        prDetectedLive: false,
        taskBackend,
      }),
    );
    expect(taskBackend.attachPR).toHaveBeenCalledWith(
      'task-abc',
      'https://github.com/owner/repo/pull/42',
    );
  });

  it('skips attachPR when PR was already detected live', async () => {
    const taskBackend = makeTaskBackend();
    await recoverSession(
      'sess-3',
      baseOpts({
        prUrl: 'https://github.com/owner/repo/pull/42',
        prDetectedLive: true,
        taskBackend,
      }),
    );
    expect(taskBackend.attachPR).not.toHaveBeenCalled();
  });

  it('calls upsertPullRequest and updateStatus when prUrl is open', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(null); // no existing PR row → state=undefined
    const taskBackend = makeTaskBackend();
    const broadcast = vi.fn();
    await recoverSession(
      'sess-4',
      baseOpts({
        prUrl: 'https://github.com/owner/repo/pull/7',
        taskBackend,
        broadcast,
      }),
    );
    expect(upsertPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        pr_number: 7,
        repo: 'owner/repo',
        session_id: 'sess-4',
      }),
    );
    expect(taskBackend.updateStatus).toHaveBeenCalledWith(
      'task-abc',
      '👀 In Review',
    );
  });

  it('skips upsertPullRequest when PR is already merged', async () => {
    vi.mocked(getPRByNumber).mockReturnValue({ state: 'merged' } as ReturnType<
      typeof getPRByNumber
    >);
    const taskBackend = makeTaskBackend();
    await recoverSession(
      'sess-5',
      baseOpts({
        prUrl: 'https://github.com/owner/repo/pull/8',
        taskBackend,
      }),
    );
    expect(upsertPullRequest).not.toHaveBeenCalled();
    expect(taskBackend.updateStatus).not.toHaveBeenCalled();
  });

  it('emits pr_opened when prUrl is open and not detected live', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(null);
    const emitPrOpened = vi.fn();
    await recoverSession(
      'sess-6',
      baseOpts({
        prUrl: 'https://github.com/owner/repo/pull/9',
        prDetectedLive: false,
        emitPrOpened,
      }),
    );
    expect(emitPrOpened).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 9, repo: 'owner/repo' }),
    );
  });

  it('does not emit pr_opened for periodic scope', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(null);
    const emitPrOpened = vi.fn();
    await recoverSession(
      'sess-7',
      baseOpts({
        scope: 'periodic',
        prUrl: 'https://github.com/owner/repo/pull/9',
        prDetectedLive: false,
        emitPrOpened,
      }),
    );
    expect(emitPrOpened).not.toHaveBeenCalled();
  });

  it('records session_backfilled audit event with scope', async () => {
    await recoverSession('sess-8', baseOpts({ scope: 'clean_exit' }));
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_backfilled',
        payload: expect.objectContaining({ scope: 'clean_exit' }),
      }),
    );
  });

  it('records session_backfilled with boot scope', async () => {
    await recoverSession('sess-9', baseOpts({ scope: 'boot' }));
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_backfilled',
        payload: expect.objectContaining({ scope: 'boot' }),
      }),
    );
  });

  it('runs the SessionAuditor and broadcasts session_audit for non-review sessions', async () => {
    const broadcast = vi.fn();
    await recoverSession(
      'sess-10',
      baseOpts({ broadcast, sessionType: 'standard' }),
    );
    expect(insertSessionAudit).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_audit' }),
    );
  });

  it('skips the SessionAuditor for review sessions', async () => {
    await recoverSession('sess-11', baseOpts({ sessionType: 'review' }));
    expect(insertSessionAudit).not.toHaveBeenCalled();
  });

  it('emitTaskUpdated is called after updateStatus', async () => {
    vi.mocked(getPRByNumber).mockReturnValue(null);
    const taskBackend = makeTaskBackend();
    vi.mocked(taskBackend.updateStatus).mockResolvedValue(undefined);
    await recoverSession(
      'sess-12',
      baseOpts({
        prUrl: 'https://github.com/owner/repo/pull/10',
        taskBackend,
      }),
    );
    // Wait for the floating promise from updateStatus.then(...)
    await new Promise((r) => setTimeout(r, 10));
    expect(emitTaskUpdated).toHaveBeenCalledWith('task-abc');
  });
});
