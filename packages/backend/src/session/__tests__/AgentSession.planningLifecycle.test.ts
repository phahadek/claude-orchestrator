import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  setSessionPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  getSessionTags: vi.fn().mockReturnValue([]),
  setSessionTags: vi.fn(),
  resetTaskCrashCount: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  hasActiveCapabilityRequestForSession: vi.fn().mockReturnValue(false),
  listStagedIntentsBySession: vi.fn().mockReturnValue([]),
}));

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  GITHUB_REPO: 'owner/repo',
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  runtimeSettings: { corporate_mode_enabled: false },
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
    hasSpawnError: false,
  })),
}));

import { AgentSession } from '../AgentSession';
import {
  markSessionIdle,
  markSessionDone,
  getEventsBySession,
  hasActiveCapabilityRequestForSession,
  listStagedIntentsBySession,
} from '../../db/queries';
import { recoverSession } from '../sessionRecovery';

function stagedIntent(
  overrides: Partial<{ kind: string; state: string }> = {},
) {
  return {
    id: 'intent-1',
    session_id: 'test-session-id',
    task_id: 'task-123',
    group_id: null,
    kind: 'task.setStatus',
    state: 'approved',
    payload: '{}',
    created_at: 0,
    ...overrides,
  } as never;
}

function makeSession(
  sessionType: 'standard' | 'groom' | 'design' | 'ops',
  taskId = 'task-123',
) {
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
  return new AgentSession(
    'test-session-id',
    'https://notion.so/task',
    'https://notion.so/project',
    taskBackend as never,
    '/tmp/project-checkout',
    taskId,
    undefined,
    undefined,
    sessionType,
  );
}

describe('AgentSession.handleCleanExit — planning session gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('groom session with nothing staged yet parks into idle without scraping for a PR or calling recoverSession', async () => {
    const session = makeSession('groom');
    const messages: unknown[] = [];
    session.on('message', (m) => messages.push(m));

    await (
      session as unknown as { handleCleanExit: () => Promise<void> }
    ).handleCleanExit();

    expect(markSessionIdle).toHaveBeenCalledWith(
      'test-session-id',
      expect.any(Number),
      null,
    );
    expect(markSessionDone).not.toHaveBeenCalled();
    expect(getEventsBySession).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'session_ended',
        sessionId: 'test-session-id',
        status: 'idle',
      }),
    );
  });

  it('groom session with a fully-dispositioned decision-bearing intent reaches done directly instead of parking idle', async () => {
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      stagedIntent({ kind: 'task.setStatus', state: 'approved' }),
    ]);
    const session = makeSession('groom');
    const messages: unknown[] = [];
    session.on('message', (m) => messages.push(m));

    await (
      session as unknown as { handleCleanExit: () => Promise<void> }
    ).handleCleanExit();

    expect(markSessionDone).toHaveBeenCalledWith(
      'test-session-id',
      expect.any(Number),
      null,
      'planning_no_pending_dispositions',
    );
    expect(markSessionIdle).not.toHaveBeenCalled();
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'session_ended',
        sessionId: 'test-session-id',
        status: 'done',
      }),
    );
  });

  it('groom session with a still-pending (staged) intent parks idle rather than going done', async () => {
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      stagedIntent({ kind: 'task.setStatus', state: 'staged' }),
    ]);
    const session = makeSession('groom');

    await (
      session as unknown as { handleCleanExit: () => Promise<void> }
    ).handleCleanExit();

    expect(markSessionIdle).toHaveBeenCalledWith(
      'test-session-id',
      expect.any(Number),
      null,
    );
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('groom session with a blocked (needs_revision) member parks idle rather than going done', async () => {
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      stagedIntent({ kind: 'task.setStatus', state: 'needs_revision' }),
    ]);
    const session = makeSession('groom');

    await (
      session as unknown as { handleCleanExit: () => Promise<void> }
    ).handleCleanExit();

    expect(markSessionIdle).toHaveBeenCalledWith(
      'test-session-id',
      expect.any(Number),
      null,
    );
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('design session with a fully-dispositioned decision-bearing intent still parks idle (design completion goes through the async PlanningOrchestrator path, not this fast path)', async () => {
    vi.mocked(listStagedIntentsBySession).mockReturnValue([
      stagedIntent({ kind: 'task.setStatus', state: 'approved' }),
    ]);
    const session = makeSession('design');

    await (
      session as unknown as { handleCleanExit: () => Promise<void> }
    ).handleCleanExit();

    expect(markSessionIdle).toHaveBeenCalledWith(
      'test-session-id',
      expect.any(Number),
      null,
    );
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('design session parks into idle without scraping for a PR or calling recoverSession', async () => {
    const session = makeSession('design');

    await (
      session as unknown as { handleCleanExit: () => Promise<void> }
    ).handleCleanExit();

    expect(markSessionIdle).toHaveBeenCalledWith(
      'test-session-id',
      expect.any(Number),
      null,
    );
    expect(recoverSession).not.toHaveBeenCalled();
  });

  it('standard session still runs the PR-scrape/recoverSession chain', async () => {
    const session = makeSession('standard');

    await (
      session as unknown as { handleCleanExit: () => Promise<void> }
    ).handleCleanExit();

    expect(getEventsBySession).toHaveBeenCalled();
    expect(recoverSession).toHaveBeenCalled();
  });
});

describe('AgentSession.handleCleanExit — gate-verify session archival', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasActiveCapabilityRequestForSession).mockReturnValue(false);
  });

  it('a gate-verify session (task_id gate-item:%) is marked done, not idle', async () => {
    const session = makeSession('ops', 'gate-item:abc-123');
    const messages: unknown[] = [];
    session.on('message', (m) => messages.push(m));

    await (
      session as unknown as { handleCleanExit: () => Promise<void> }
    ).handleCleanExit();

    expect(markSessionDone).toHaveBeenCalledWith(
      'test-session-id',
      expect.any(Number),
      null,
      'gate_verify_clean_exit',
    );
    expect(markSessionIdle).not.toHaveBeenCalled();
    expect(getEventsBySession).not.toHaveBeenCalled();
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'session_ended',
        sessionId: 'test-session-id',
        status: 'done',
      }),
    );
  });

  it('a gate-verify session with an unresolved capability request parks idle instead of being archived done', async () => {
    vi.mocked(hasActiveCapabilityRequestForSession).mockReturnValue(true);
    const session = makeSession('ops', 'gate-item:abc-123');

    await (
      session as unknown as { handleCleanExit: () => Promise<void> }
    ).handleCleanExit();

    expect(markSessionIdle).toHaveBeenCalledWith(
      'test-session-id',
      expect.any(Number),
      null,
    );
    expect(markSessionDone).not.toHaveBeenCalled();
  });

  it('a non-gate ops session still parks into idle (parking unchanged)', async () => {
    const session = makeSession('ops', 'task-456');

    await (
      session as unknown as { handleCleanExit: () => Promise<void> }
    ).handleCleanExit();

    expect(markSessionIdle).toHaveBeenCalledWith(
      'test-session-id',
      expect.any(Number),
      null,
    );
    expect(markSessionDone).not.toHaveBeenCalled();
  });
});
