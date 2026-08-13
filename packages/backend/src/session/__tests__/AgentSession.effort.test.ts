import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRunnerOptions } from '../SessionRunner';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

// vi.hoisted ensures these variables exist before the hoisted vi.mock factories run.
const mockRuntimeSettings = vi.hoisted(() => ({
  large_task_model: '',
  code_session_model: '',
  review_session_model: '',
  planning_session_model: '',
  ops_session_model: '',
  gate_verify_session_model: '',
  investigate_session_model: '',
  groom_session_model: '',
  design_session_model: '',
  docs_session_model: '',
  large_task_effort: '',
  code_session_effort: '',
  review_session_effort: '',
  planning_session_effort: '',
  ops_session_effort: '',
  gate_verify_session_effort: '',
  investigate_session_effort: '',
  groom_session_effort: '',
  design_session_effort: '',
  docs_session_effort: '',
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
const mockSetSessionModelSettingKey = vi.hoisted(() => vi.fn());
const mockSetSessionEffortSettingKey = vi.hoisted(() => vi.fn());

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
    setSessionModelSettingKey: mockSetSessionModelSettingKey,
    setSessionEffortSettingKey: mockSetSessionEffortSettingKey,
    setSessionMetadata: vi.fn(),
    getPRBySessionId: vi.fn().mockReturnValue(null),
    setHeadSha: vi.fn(),
    setPauseReason: vi.fn(),
    setSessionPauseReason: vi.fn(),
    insertPauseInterval: vi.fn(),
    getSessionTags: vi.fn().mockReturnValue([]),
    setSessionTags: vi.fn(),
    resetTaskCrashCount: vi.fn(),
  }),
);

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
  execFile: vi.fn((...args: unknown[]) => {
    (args[args.length - 1] as (err: unknown, out: unknown) => void)(null, {
      stdout: '',
      stderr: '',
    });
  }),
  exec: vi.fn((...args: unknown[]) => {
    (args[args.length - 1] as (err: unknown, out: unknown) => void)(null, {
      stdout: '',
      stderr: '',
    });
  }),
}));

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  GROOM_ALLOWED_TOOLS: [],
  DESIGN_ALLOWED_TOOLS: [],
  OPS_ALLOWED_TOOLS: [],
  DOCS_ALLOWED_TOOLS: [],
  docsWebFetchTools: vi.fn().mockReturnValue([]),
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
  sessionType:
    | 'standard'
    | 'review'
    | 'groom'
    | 'design'
    | 'ops'
    | 'docs' = 'standard',
  taskId = 'task-123',
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
    taskId,
    undefined,
    undefined,
    sessionType,
  );
}

beforeEach(() => {
  runCalls.length = 0;
  mockSendMessage.mockReset();
  mockSetSessionModelSettingKey.mockReset();
  mockSetSessionEffortSettingKey.mockReset();
  mockRuntimeSettings.large_task_model = '';
  mockRuntimeSettings.code_session_model = '';
  mockRuntimeSettings.review_session_model = '';
  mockRuntimeSettings.planning_session_model = '';
  mockRuntimeSettings.ops_session_model = '';
  mockRuntimeSettings.gate_verify_session_model = '';
  mockRuntimeSettings.investigate_session_model = '';
  mockRuntimeSettings.groom_session_model = '';
  mockRuntimeSettings.design_session_model = '';
  mockRuntimeSettings.docs_session_model = '';
  mockRuntimeSettings.large_task_effort = '';
  mockRuntimeSettings.code_session_effort = '';
  mockRuntimeSettings.review_session_effort = '';
  mockRuntimeSettings.planning_session_effort = '';
  mockRuntimeSettings.ops_session_effort = '';
  mockRuntimeSettings.gate_verify_session_effort = '';
  mockRuntimeSettings.investigate_session_effort = '';
  mockRuntimeSettings.groom_session_effort = '';
  mockRuntimeSettings.design_session_effort = '';
  mockRuntimeSettings.docs_session_effort = '';
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

  it.each(['groom', 'design', 'docs'] as const)(
    '%s session falls back to planning_session_model/effort when its own setting is unset',
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

  it('groom session uses groom_session_model/effort when set, ignoring planning_session_model/effort', async () => {
    mockRuntimeSettings.planning_session_model = 'claude-sonnet-4-6';
    mockRuntimeSettings.planning_session_effort = 'high';
    mockRuntimeSettings.groom_session_model = 'claude-haiku-4-5';
    mockRuntimeSettings.groom_session_effort = 'low';

    const session = makeSession('groom');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.model).toBe('claude-haiku-4-5');
    expect(runCalls[0].options.effort).toBe('low');
  });

  it('groom session records model_setting_key = groom_session_model even when identical to planning_session_model', async () => {
    mockRuntimeSettings.planning_session_model = 'claude-sonnet-5';
    mockRuntimeSettings.groom_session_model = 'claude-sonnet-5';
    mockRuntimeSettings.planning_session_effort = 'high';
    mockRuntimeSettings.groom_session_effort = 'medium';

    const session = makeSession('groom');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(mockSetSessionModelSettingKey).toHaveBeenCalledWith(
      'test-session-effort',
      'groom_session_model',
    );
    expect(mockSetSessionEffortSettingKey).toHaveBeenCalledWith(
      'test-session-effort',
      'groom_session_effort',
    );
  });

  it('design session uses design_session_model/effort when set, ignoring planning_session_model/effort', async () => {
    mockRuntimeSettings.planning_session_model = 'claude-sonnet-4-6';
    mockRuntimeSettings.planning_session_effort = 'high';
    mockRuntimeSettings.design_session_model = 'claude-opus-4-8';
    mockRuntimeSettings.design_session_effort = 'xhigh';

    const session = makeSession('design');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.model).toBe('claude-opus-4-8');
    expect(runCalls[0].options.effort).toBe('xhigh');
  });

  it('docs session uses docs_session_model/effort when set, ignoring planning_session_model/effort', async () => {
    mockRuntimeSettings.planning_session_model = 'claude-sonnet-4-6';
    mockRuntimeSettings.planning_session_effort = 'high';
    mockRuntimeSettings.docs_session_model = 'claude-sonnet-5';
    mockRuntimeSettings.docs_session_effort = 'medium';

    const session = makeSession('docs');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.model).toBe('claude-sonnet-5');
    expect(runCalls[0].options.effort).toBe('medium');
  });

  it('a gate-verify session resolves independently of groom/design/docs/ops settings', async () => {
    mockRuntimeSettings.ops_session_model = 'claude-sonnet-5';
    mockRuntimeSettings.ops_session_effort = 'high';
    mockRuntimeSettings.groom_session_model = 'claude-haiku-4-5';
    mockRuntimeSettings.design_session_model = 'claude-haiku-4-5';
    mockRuntimeSettings.docs_session_model = 'claude-haiku-4-5';
    mockRuntimeSettings.gate_verify_session_model = 'claude-opus-4-8';
    mockRuntimeSettings.gate_verify_session_effort = 'xhigh';

    const session = makeSession('ops', 'gate-item:abc123');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.model).toBe('claude-opus-4-8');
    expect(runCalls[0].options.effort).toBe('xhigh');
  });

  it('gate-verify session records gate_verify_session_model rather than ops_session_model', async () => {
    mockRuntimeSettings.ops_session_model = 'claude-sonnet-5';
    mockRuntimeSettings.ops_session_effort = 'high';
    mockRuntimeSettings.gate_verify_session_model = 'claude-sonnet-5';
    mockRuntimeSettings.gate_verify_session_effort = 'high';

    const session = makeSession('ops', 'gate-item:abc123');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(mockSetSessionModelSettingKey).toHaveBeenCalledWith(
      'test-session-effort',
      'gate_verify_session_model',
    );
    expect(mockSetSessionEffortSettingKey).toHaveBeenCalledWith(
      'test-session-effort',
      'gate_verify_session_effort',
    );
  });

  it('an investigate session resolves independently of groom/design/docs/ops settings', async () => {
    mockRuntimeSettings.ops_session_model = 'claude-sonnet-5';
    mockRuntimeSettings.ops_session_effort = 'high';
    mockRuntimeSettings.groom_session_model = 'claude-haiku-4-5';
    mockRuntimeSettings.design_session_model = 'claude-haiku-4-5';
    mockRuntimeSettings.docs_session_model = 'claude-haiku-4-5';
    mockRuntimeSettings.investigate_session_model = 'claude-opus-4-8';
    mockRuntimeSettings.investigate_session_effort = 'xhigh';

    const session = makeSession('ops', 'report-batch:abc123');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.model).toBe('claude-opus-4-8');
    expect(runCalls[0].options.effort).toBe('xhigh');
  });

  it('investigate session records investigate_session_model rather than ops_session_model', async () => {
    mockRuntimeSettings.ops_session_model = 'claude-sonnet-5';
    mockRuntimeSettings.ops_session_effort = 'high';
    mockRuntimeSettings.investigate_session_model = 'claude-sonnet-5';
    mockRuntimeSettings.investigate_session_effort = 'high';

    const session = makeSession('ops', 'report-batch:abc123');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(mockSetSessionModelSettingKey).toHaveBeenCalledWith(
      'test-session-effort',
      'investigate_session_model',
    );
    expect(mockSetSessionEffortSettingKey).toHaveBeenCalledWith(
      'test-session-effort',
      'investigate_session_effort',
    );
  });

  it('an investigate session falls back to ops_session_model/effort when its own setting is unset', async () => {
    mockRuntimeSettings.ops_session_model = 'claude-sonnet-5';
    mockRuntimeSettings.ops_session_effort = 'high';
    mockRuntimeSettings.investigate_session_model = '';
    mockRuntimeSettings.investigate_session_effort = '';

    const session = makeSession('ops', 'report-batch:abc123');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.model).toBe('claude-sonnet-5');
    expect(runCalls[0].options.effort).toBe('high');
    expect(mockSetSessionModelSettingKey).toHaveBeenCalledWith(
      'test-session-effort',
      'ops_session_model',
    );
    expect(mockSetSessionEffortSettingKey).toHaveBeenCalledWith(
      'test-session-effort',
      'ops_session_effort',
    );
  });

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

  it('a non-gate-verify ops session uses ops_session_model/effort regardless of gate-verify settings', async () => {
    mockRuntimeSettings.ops_session_model = 'claude-sonnet-5';
    mockRuntimeSettings.ops_session_effort = 'high';
    mockRuntimeSettings.gate_verify_session_model = 'claude-haiku-4-5';
    mockRuntimeSettings.gate_verify_session_effort = 'low';

    const session = makeSession('ops', 'task-456');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.model).toBe('claude-sonnet-5');
    expect(runCalls[0].options.effort).toBe('high');
  });

  it('a gate-verify session uses gate_verify_session_model/effort when set', async () => {
    mockRuntimeSettings.ops_session_model = 'claude-sonnet-5';
    mockRuntimeSettings.ops_session_effort = 'high';
    mockRuntimeSettings.gate_verify_session_model = 'claude-haiku-4-5';
    mockRuntimeSettings.gate_verify_session_effort = 'low';

    const session = makeSession('ops', 'gate-item:abc123');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.model).toBe('claude-haiku-4-5');
    expect(runCalls[0].options.effort).toBe('low');
  });

  it('a gate-verify session falls back to ops_session_model/effort when gate-verify settings are unset', async () => {
    mockRuntimeSettings.ops_session_model = 'claude-sonnet-5';
    mockRuntimeSettings.ops_session_effort = 'high';
    mockRuntimeSettings.gate_verify_session_model = '';
    mockRuntimeSettings.gate_verify_session_effort = '';

    const session = makeSession('ops', 'gate-item:abc123');
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.model).toBe('claude-sonnet-5');
    expect(runCalls[0].options.effort).toBe('high');
  });

  it('an explicit launch model/effort override still takes precedence for a gate-verify session', async () => {
    mockRuntimeSettings.gate_verify_session_model = 'claude-haiku-4-5';
    mockRuntimeSettings.gate_verify_session_effort = 'low';

    const session = new AgentSession(
      'test-session-effort',
      'https://notion.so/task',
      'https://notion.so/project',
      {
        attachPR: vi.fn().mockResolvedValue(undefined),
        getTask: vi.fn().mockResolvedValue(null),
      } as never,
      '/tmp/worktree',
      'gate-item:abc123',
      undefined, // resumeSessionId
      undefined, // customPrompt
      'ops', // sessionType
      undefined, // sessionManager
      undefined, // githubClient
      undefined, // extraAllowedTools
      undefined, // systemPromptContent
      undefined, // runner
      undefined, // projectId
      undefined, // mcpConfigPath
      undefined, // systemPromptFilePath
      'claude-opus-4-8', // launchModel
      'max', // launchEffort
    );
    await session.run();

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].options.model).toBe('claude-opus-4-8');
    expect(runCalls[0].options.effort).toBe('max');
  });

  it.each(['groom', 'design', 'docs'] as const)(
    'launchModel/launchEffort override wins over the %s session settings',
    async (sessionType) => {
      mockRuntimeSettings.groom_session_model = 'claude-haiku-4-5';
      mockRuntimeSettings.design_session_model = 'claude-haiku-4-5';
      mockRuntimeSettings.docs_session_model = 'claude-haiku-4-5';
      mockRuntimeSettings.planning_session_model = 'claude-sonnet-4-6';

      const session = new AgentSession(
        'test-session-effort',
        'https://notion.so/task',
        'https://notion.so/project',
        {
          attachPR: vi.fn().mockResolvedValue(undefined),
          getTask: vi.fn().mockResolvedValue(null),
        } as never,
        '/tmp/worktree',
        'task-123',
        undefined, // resumeSessionId
        undefined, // customPrompt
        sessionType, // sessionType
        undefined, // sessionManager
        undefined, // githubClient
        undefined, // extraAllowedTools
        undefined, // systemPromptContent
        undefined, // runner
        undefined, // projectId
        undefined, // mcpConfigPath
        undefined, // systemPromptFilePath
        'claude-opus-4-8', // launchModel
        'max', // launchEffort
      );
      await session.run();

      expect(runCalls).toHaveLength(1);
      expect(runCalls[0].options.model).toBe('claude-opus-4-8');
      expect(runCalls[0].options.effort).toBe('max');
    },
  );
});
