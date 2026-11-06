import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

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
    setSessionModelSettingKey: vi.fn(),
    setSessionEffortSettingKey: vi.fn(),
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
  validatePRBody: vi.fn().mockReturnValue({ valid: true, missingSections: [] }),
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
  PreSpawnConfigError: class PreSpawnConfigError extends Error {},
}));

import { AgentSession } from '../AgentSession';
import { insertPauseInterval } from '../../db/queries';
import { recordEvent } from '../../audit/AuditLog';

type OnEvent = (event: Record<string, unknown>) => void;

const AUTH_TEXT =
  'Failed to authenticate: OAuth session expired and could not be refreshed';

const SYNTHETIC_AUTH_EVENT = {
  type: 'assistant',
  message: {
    model: '<synthetic>',
    content: [{ type: 'text', text: AUTH_TEXT }],
  },
};

const AUTH_RESULT_EVENT = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  terminal_reason: 'api_error',
  result: AUTH_TEXT,
};

const OVERFLOW_RESULT_EVENT = {
  type: 'result',
  is_error: true,
  result: 'Prompt is too long',
};

function makeHarness(events: Record<string, unknown>[], exitCode = 0) {
  const endSession = vi.fn();
  const runner = {
    run: vi.fn(
      async (_p: unknown, _r: unknown, _o: unknown, onEvent: OnEvent) => {
        for (const e of events) onEvent(e);
        return exitCode;
      },
    ),
    sendMessage: vi.fn(),
    endSession,
    kill: vi.fn().mockResolvedValue(undefined),
    hasSpawnError: false,
  };
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
  const session = new AgentSession(
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
    undefined,
    [],
    undefined,
    runner as never,
  );
  const handleCleanExit = vi
    .spyOn(
      session as unknown as { handleCleanExit: () => Promise<void> },
      'handleCleanExit',
    )
    .mockResolvedValue(undefined);
  return { session, endSession, handleCleanExit };
}

describe('AgentSession CLI authentication-failure park', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes stdin exactly once on the synthetic assistant event followed by the is_error result', async () => {
    const { session, endSession } = makeHarness([
      SYNTHETIC_AUTH_EVENT,
      AUTH_RESULT_EVENT,
    ]);
    await session.run();
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it('parks cleanly with an auth_failed pause interval and audit row after exit 0', async () => {
    const { session, handleCleanExit } = makeHarness([
      SYNTHETIC_AUTH_EVENT,
      AUTH_RESULT_EVENT,
    ]);
    await session.run();
    expect(insertPauseInterval).toHaveBeenCalledWith(
      'test-session-id',
      'auth_failed',
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'session_auth_failed',
        payload: {
          sessionId: 'test-session-id',
          sessionType: 'standard',
          taskId: 'task-123',
        },
      }),
    );
    expect(handleCleanExit).toHaveBeenCalledTimes(1);
  });

  it('leaves a context-overflow is_error result on its existing path', async () => {
    const { session, endSession } = makeHarness([OVERFLOW_RESULT_EVENT]);
    await session.run();
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(insertPauseInterval).not.toHaveBeenCalledWith(
      'test-session-id',
      'auth_failed',
    );
  });
});
