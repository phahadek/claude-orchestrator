import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn().mockReturnValue({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
    exitCode: null,
  }),
  execSync: vi.fn(),
}));

vi.mock('../../db/queries', () => ({
  upsertSessionEvent: vi.fn().mockReturnValue(1),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getEventsBySession: vi.fn().mockReturnValue([]),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  incrementTokens: vi.fn(),
  incrementCompactionCount: vi.fn(),
  setContextOccupancy: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  setSessionPauseReason: vi.fn(),
  getSessionTags: vi.fn().mockReturnValue([]),
  setSessionTags: vi.fn(),
}));

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  GITHUB_REPO: 'owner/repo',
  runtimeSettings: { corporate_mode_enabled: false },
  getProjectById: vi.fn().mockReturnValue(null),
}));

vi.mock('../../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
  countPushFailureEvents: vi.fn().mockReturnValue(0),
}));

vi.mock('../filePollutionCheck', () => ({
  runFilePollutionCheck: vi.fn().mockResolvedValue({ revertCommitSha: null }),
}));

vi.mock('../../github/PRBodyValidator', () => ({
  validatePRBody: vi.fn().mockReturnValue({ valid: true, missingSections: [] }),
  buildValidationComment: vi.fn().mockReturnValue(''),
}));

vi.mock('../../github/CommitAttributionWatcher', () => ({
  checkCommitAttribution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockReturnValue(new Promise(() => {})),
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../SessionAuditor', () => ({
  detectInFlightEscape: vi
    .fn()
    .mockReturnValue({ violations: [], specMismatch: null }),
}));

vi.mock('../../utils/eventFilters', () => ({
  isSystemOnlyUserEvent: vi.fn().mockReturnValue(false),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { execSync } from 'child_process';
import { AgentSession } from '../AgentSession';
import { setPauseReason, getPRBySessionId } from '../../db/queries';

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKTREE = '/fake/worktree';

function makeSession(worktreePath = WORKTREE): AgentSession {
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
  return new AgentSession(
    'test-auto-push',
    'https://notion.so/task',
    'https://notion.so/project',
    taskBackend as never,
    worktreePath,
    'task-123',
  );
}

async function callHandlePushDetected(session: AgentSession): Promise<void> {
  await (
    session as unknown as { handlePushDetected(): Promise<void> }
  ).handlePushDetected();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentSession.handlePushDetected — auto-push logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPRBySessionId).mockReturnValue(null);
  });

  it('pushes when worktree is ahead of origin and emits session_auto_pushed', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('rev-parse --abbrev-ref'))
        return Buffer.from('feature/my-branch\n');
      if (cmd.includes('rev-parse HEAD')) return Buffer.from('abc1234\n');
      if (cmd.includes('ls-remote'))
        return Buffer.from('def5678\tfeature/my-branch\n');
      if (cmd.includes('rev-list --left-right')) return Buffer.from('0\t1\n');
      if (cmd.includes('git push')) return Buffer.from('');
      return Buffer.from('');
    });
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 10,
      repo: 'owner/repo',
    } as any);

    const session = makeSession();
    const messages: unknown[] = [];
    session.on('message', (m: unknown) => messages.push(m));

    const pushDetectedEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushDetectedEvents.push(e));

    await callHandlePushDetected(session);

    // push was executed
    const pushCall = vi
      .mocked(execSync)
      .mock.calls.find(([cmd]) => (cmd as string).includes('git push origin'));
    expect(pushCall).toBeDefined();
    expect(pushCall![0]).toBe('git push origin feature/my-branch');

    // session_auto_pushed WS event emitted
    const autoPushMsg = messages.find(
      (m: any) => m.type === 'session_auto_pushed',
    );
    expect(autoPushMsg).toMatchObject({
      type: 'session_auto_pushed',
      sessionId: 'test-auto-push',
      branch: 'feature/my-branch',
      commits: 1,
    });

    // push_detected still fires
    expect(pushDetectedEvents).toHaveLength(1);
    expect(pushDetectedEvents[0]).toMatchObject({
      sessionId: 'test-auto-push',
    });
  });

  it('does not push when worktree HEAD equals origin HEAD', async () => {
    const SHA = 'abc1234';
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('rev-parse --abbrev-ref'))
        return Buffer.from('feature/foo\n');
      if (cmd.includes('rev-parse HEAD')) return Buffer.from(`${SHA}\n`);
      if (cmd.includes('ls-remote'))
        return Buffer.from(`${SHA}\tfeature/foo\n`);
      return Buffer.from('');
    });

    const session = makeSession();
    const messages: unknown[] = [];
    session.on('message', (m: unknown) => messages.push(m));

    const pushDetectedEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushDetectedEvents.push(e));

    await callHandlePushDetected(session);

    const pushCall = vi
      .mocked(execSync)
      .mock.calls.find(([cmd]) => (cmd as string).includes('git push'));
    expect(pushCall).toBeUndefined();
    expect(
      messages.find((m: any) => m.type === 'session_auto_pushed'),
    ).toBeUndefined();

    // push_detected still fires unchanged
    expect(pushDetectedEvents).toHaveLength(1);
  });

  it('skips push and sets diverged_branch pause_reason when branch is diverged', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('rev-parse --abbrev-ref'))
        return Buffer.from('feature/diverged\n');
      if (cmd.includes('rev-parse HEAD')) return Buffer.from('local111\n');
      if (cmd.includes('ls-remote'))
        return Buffer.from('remote222\tfeature/diverged\n');
      if (cmd.includes('rev-list --left-right')) return Buffer.from('2\t1\n');
      return Buffer.from('');
    });
    vi.mocked(getPRBySessionId).mockReturnValue({
      pr_number: 42,
      repo: 'owner/repo',
    } as any);

    const session = makeSession();
    const messages: unknown[] = [];
    session.on('message', (m: unknown) => messages.push(m));

    const pushDetectedEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushDetectedEvents.push(e));

    await callHandlePushDetected(session);

    // no push
    const pushCall = vi
      .mocked(execSync)
      .mock.calls.find(([cmd]) => (cmd as string).includes('git push'));
    expect(pushCall).toBeUndefined();

    // pause_reason set
    expect(setPauseReason).toHaveBeenCalledWith(
      42,
      'owner/repo',
      'diverged_branch',
    );

    // session_auto_pushed is broadcast with commits:0 to signal diverged state
    const autoPushMsg = messages.find(
      (m: any) => m.type === 'session_auto_pushed',
    );
    expect(autoPushMsg).toMatchObject({
      type: 'session_auto_pushed',
      sessionId: 'test-auto-push',
      branch: 'feature/diverged',
      commits: 0,
    });

    // push_detected still fires
    expect(pushDetectedEvents).toHaveLength(1);
  });

  it('catches ls-remote failure, logs it, and still emits push_detected', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('rev-parse --abbrev-ref'))
        return Buffer.from('feature/foo\n');
      if (cmd.includes('rev-parse HEAD')) return Buffer.from('abc1234\n');
      if (cmd.includes('ls-remote')) throw new Error('network error');
      return Buffer.from('');
    });

    const session = makeSession();
    const pushDetectedEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushDetectedEvents.push(e));

    await expect(callHandlePushDetected(session)).resolves.toBeUndefined();

    // push_detected still fires despite error
    expect(pushDetectedEvents).toHaveLength(1);
  });

  it('skips auto-push check when worktreePath is not set', async () => {
    const session = makeSession('');
    (session as unknown as { worktreePath: string }).worktreePath = '';

    const pushDetectedEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushDetectedEvents.push(e));

    await callHandlePushDetected(session);

    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
    expect(pushDetectedEvents).toHaveLength(1);
  });

  it('pushes when ls-remote returns empty (new branch not yet on remote)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('rev-parse --abbrev-ref'))
        return Buffer.from('feature/new\n');
      if (cmd.includes('rev-parse HEAD')) return Buffer.from('abc1234\n');
      if (cmd.includes('ls-remote')) return Buffer.from('');
      if (cmd.includes('rev-list --left-right')) return Buffer.from('0\t1\n');
      if (cmd.includes('git push')) return Buffer.from('');
      return Buffer.from('');
    });

    const session = makeSession();
    const messages: unknown[] = [];
    session.on('message', (m: unknown) => messages.push(m));

    const pushDetectedEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushDetectedEvents.push(e));

    await callHandlePushDetected(session);

    // localHead='abc1234', remoteHead='' → not equal → proceed to rev-list
    // then ahead=1, behind=0 → push
    const pushCall = vi
      .mocked(execSync)
      .mock.calls.find(([cmd]) => (cmd as string).includes('git push origin'));
    expect(pushCall).toBeDefined();

    const autoPushMsg = messages.find(
      (m: any) => m.type === 'session_auto_pushed',
    );
    expect(autoPushMsg).toBeDefined();
    expect(pushDetectedEvents).toHaveLength(1);
  });
});

// ── Integration test ──────────────────────────────────────────────────────────

describe('integration: needs_changes → session commits → orchestrator auto-pushes → re-review fires', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPRBySessionId).mockReturnValue(null);
  });

  it('auto-pushes committed changes and triggers the re-review pipeline', async () => {
    // Session received "needs_changes" feedback and committed a fix locally,
    // but did not push. The worktree is 1 commit ahead of origin.
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('rev-parse --abbrev-ref'))
        return Buffer.from('feature/fix\n');
      if (cmd.includes('rev-parse HEAD')) return Buffer.from('newsha1\n');
      if (cmd.includes('ls-remote'))
        return Buffer.from('oldsha1\tfeature/fix\n');
      if (cmd.includes('rev-list --left-right')) return Buffer.from('0\t1\n');
      if (cmd.includes('git push')) return Buffer.from('');
      return Buffer.from('');
    });

    const prRow = {
      pr_number: 99,
      repo: 'owner/repo',
      state: 'open',
      review_session_id: 'review-session-abc',
      session_id: 'test-auto-push',
    };
    vi.mocked(getPRBySessionId).mockReturnValue(prRow as any);

    // Simulate server.ts thin wrapper: push_detected → PRMergeWatcher.handlePushDetected
    const mockMergeWatcherHandlePush = vi.fn().mockResolvedValue(undefined);
    const session = makeSession();
    session.on('push_detected', ({ sessionId }: { sessionId: string }) => {
      const pr = getPRBySessionId(sessionId);
      if (pr && (pr as any).state === 'open') {
        void mockMergeWatcherHandlePush(pr);
      }
    });

    await callHandlePushDetected(session);

    // Auto-push ran first — git push was called before push_detected fired
    const pushCall = vi
      .mocked(execSync)
      .mock.calls.find(([cmd]) => (cmd as string).includes('git push origin'));
    expect(pushCall).toBeDefined();
    expect(pushCall![0]).toBe('git push origin feature/fix');

    // The re-review pipeline was triggered with the correct PR row
    expect(mockMergeWatcherHandlePush).toHaveBeenCalledTimes(1);
    expect(mockMergeWatcherHandlePush).toHaveBeenCalledWith(prRow);
  });
});

