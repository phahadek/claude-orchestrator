import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRunnerOptions } from '../SessionRunner';

// vi.hoisted ensures these variables exist before the hoisted vi.mock factories run.
const mockRuntimeSettings = vi.hoisted(() => ({
  large_task_model: '',
  code_session_model: '',
  review_session_model: '',
  planning_session_model: '',
  large_task_effort: '',
  code_session_effort: '',
  review_session_effort: '',
  planning_session_effort: '',
  corporate_mode_enabled: false,
}));

const runCalls = vi.hoisted(
  () =>
    [] as Array<{
      options: SessionRunnerOptions;
      onEvent: (e: Record<string, unknown>) => void;
    }>,
);

const mockSendMessage = vi.hoisted(() => vi.fn());

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
  execSync: vi.fn(() => ''),
}));

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  GROOM_ALLOWED_TOOLS: [],
  DESIGN_ALLOWED_TOOLS: [],
  GITHUB_REPO: 'owner/repo',
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  runtimeSettings: mockRuntimeSettings,
  getProjectById: vi.fn().mockReturnValue(null),
}));

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    run: vi
      .fn()
      .mockImplementation(
        (
          _prompt: unknown,
          _resume: unknown,
          options: SessionRunnerOptions,
          onEvent: (e: Record<string, unknown>) => void,
        ) => {
          runCalls.push({ options, onEvent });
          onEvent({ type: 'system', subtype: 'init' });
          return Promise.resolve(0);
        },
      ),
    sendMessage: mockSendMessage,
    endSession: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    hasSpawnError: false,
  })),
}));

import { AgentSession } from '../AgentSession';

function makeSession(
  sessionType: 'standard' | 'review' | 'groom' | 'design' = 'standard',
) {
  return new AgentSession(
    'test-session-effort',
    'https://notion.so/task',
    'https://notion.so/project',
    {
      attachPR: vi.fn().mockResolvedValue(undefined),
      getTask: vi.fn().mockResolvedValue(null),
    } as never,
    '/tmp/worktree',
    'task-123',
    undefined,
    undefined,
    sessionType,
  );
}

beforeEach(() => {
  runCalls.length = 0;
  mockSendMessage.mockReset();
  mockRuntimeSettings.large_task_model = '';
  mockRuntimeSettings.code_session_model = '';
  mockRuntimeSettings.review_session_model = '';
  mockRuntimeSettings.planning_session_model = '';
  mockRuntimeSettings.large_task_effort = '';
  mockRuntimeSettings.code_session_effort = '';
  mockRuntimeSettings.review_session_effort = '';
  mockRuntimeSettings.planning_session_effort = '';
  vi.clearAllMocks();
});

describe('AgentSession — per-class effort resolution', () => {
  it('code session uses code_session_effort', async () => {
    mockRuntimeSettings.code_session_effort = 'high';
    mockRuntimeSettings.review_session_effort = 'low';

    const session = makeSession('standard');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.effort).toBe('high');
  });

  it('review session uses review_session_effort', async () => {
    mockRuntimeSettings.code_session_effort = 'high';
    mockRuntimeSettings.review_session_effort = 'low';

    const session = makeSession('review');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.effort).toBe('low');
  });

  it('omits effort (undefined) when the resolved setting is empty', async () => {
    mockRuntimeSettings.code_session_effort = '';

    const session = makeSession('standard');
    await session.run();

    expect(runCalls[0].options.effort).toBeUndefined();
  });

  it('large-task/escalation spawn uses large_task_effort instead of the per-class effort', async () => {
    mockRuntimeSettings.code_session_effort = 'medium';
    mockRuntimeSettings.large_task_effort = 'max';

    const session = makeSession('standard');
    session.setProactiveEscalation('claude-opus-4-7[1m]', 'continue');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.model).toBe('claude-opus-4-7[1m]');
    expect(runCalls[0].options.effort).toBe('max');
  });

  it.each(['groom', 'design'] as const)(
    '%s session uses planning_session_model/effort',
    async (sessionType) => {
      mockRuntimeSettings.planning_session_model = 'claude-haiku-4-5';
      mockRuntimeSettings.planning_session_effort = 'low';
      mockRuntimeSettings.code_session_model = 'claude-opus-4-8';
      mockRuntimeSettings.review_session_model = 'claude-sonnet-4-6';

      const session = makeSession(sessionType);
      await session.run();

      expect(runCalls).toHaveLength(1);
      expect(runCalls[0].options.model).toBe('claude-haiku-4-5');
      expect(runCalls[0].options.effort).toBe('low');
    },
  );

  it('large-task/escalation spawn on a planning session uses large_task_effort instead of planning_session_effort', async () => {
    mockRuntimeSettings.planning_session_effort = 'low';
    mockRuntimeSettings.large_task_effort = 'max';

    const session = makeSession('design');
    session.setProactiveEscalation('claude-opus-4-7[1m]', 'continue');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.model).toBe('claude-opus-4-7[1m]');
    expect(runCalls[0].options.effort).toBe('max');
  });
});
