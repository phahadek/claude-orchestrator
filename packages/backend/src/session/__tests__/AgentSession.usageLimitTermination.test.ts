import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../db/queries', () =>
  mockDbQueries({
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
    setTaskPauseReason: vi.fn(),
  }),
);

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  GITHUB_REPO: 'owner/repo',
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  runtimeSettings: { corporate_mode_enabled: false },
  getProjectById: vi.fn(() => undefined),
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
  validatePRBody: vi
    .fn()
    .mockReturnValue({ valid: true, missingSections: [] }),
  buildValidationComment: vi.fn().mockReturnValue(''),
}));

vi.mock('../../github/CommitAttributionWatcher', () => ({
  checkCommitAttribution: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../sessionRecovery', () => ({
  recoverSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFile: vi.fn(),
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

vi.mock('../../orchestration/usageAdmission', () => ({
  recordObservedUsageLimit: vi.fn().mockReturnValue({
    allowed: false,
    deferredUntil: 1234567890,
    window: 'five_hour',
  }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { AgentSession } from '../AgentSession';
import { getEventsBySession, insertPauseInterval } from '../../db/queries';
import { recordObservedUsageLimit } from '../../orchestration/usageAdmission';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(): AgentSession {
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
  return new AgentSession(
    'test-session-id',
    'https://notion.so/task',
    'https://notion.so/project',
    taskBackend as never,
    '/tmp/worktree',
    'task-123',
    undefined,
    undefined,
    'standard',
    undefined,
  );
}

function privateMembers(session: AgentSession) {
  return session as unknown as {
    isUsageLimitTermination: () => boolean;
    recordUsageLimitTermination: () => void;
  };
}

const USAGE_LIMIT_RESULT_EVENT = {
  event_type: 'system',
  payload: JSON.stringify({
    type: 'result',
    is_error: true,
    api_error_status: 429,
    terminal_reason: 'api_error',
    result: "You've hit your session limit · resets 6:10pm (UTC)",
  }),
};

const NORMAL_RESULT_EVENT = {
  event_type: 'system',
  payload: JSON.stringify({
    type: 'result',
    is_error: false,
    result: 'Done — PR opened.',
  }),
};

const ERROR_EVENT = {
  event_type: 'system',
  payload: JSON.stringify({
    type: 'error',
    message: JSON.stringify({ error: { type: 'overloaded_error' } }),
  }),
};

describe('AgentSession usage-limit termination detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recognises a terminating result event carrying api_error_status: 429, despite eventKind classifying it as "result" not "error"', () => {
    vi.mocked(getEventsBySession).mockReturnValue([
      USAGE_LIMIT_RESULT_EVENT,
    ] as never);
    const session = makeSession();
    expect(privateMembers(session).isUsageLimitTermination()).toBe(true);
  });

  it('does not flag a normal successful result as a usage-limit termination', () => {
    vi.mocked(getEventsBySession).mockReturnValue([
      NORMAL_RESULT_EVENT,
    ] as never);
    const session = makeSession();
    expect(privateMembers(session).isUsageLimitTermination()).toBe(false);
  });

  it('does not flag a transient error event as a usage-limit termination', () => {
    vi.mocked(getEventsBySession).mockReturnValue([ERROR_EVENT] as never);
    const session = makeSession();
    expect(privateMembers(session).isUsageLimitTermination()).toBe(false);
  });

  it('records the distinct session-scoped usage_limit_deferred pause reason and an observed deferral', () => {
    vi.mocked(getEventsBySession).mockReturnValue([
      USAGE_LIMIT_RESULT_EVENT,
    ] as never);
    const session = makeSession();

    privateMembers(session).recordUsageLimitTermination();

    // Session-scoped (session_pause_intervals), not just a task-status tag —
    // this is what makes the reason queryable and distinct from stalled_idle
    // and a normal terminal park (which writes no pause interval at all).
    expect(insertPauseInterval).toHaveBeenCalledWith(
      'test-session-id',
      'usage_limit_deferred',
    );
    // Recorded from the observed CLI event, not only from the polled snapshot.
    expect(recordObservedUsageLimit).toHaveBeenCalledWith(
      "You've hit your session limit · resets 6:10pm (UTC)",
    );
  });
});
