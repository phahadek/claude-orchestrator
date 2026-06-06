import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRunnerOptions } from '../SessionRunner';

// vi.hoisted ensures these variables exist before the hoisted vi.mock factories run.
const mockRuntimeSettings = vi.hoisted(() => ({
  large_task_model: '',
  code_session_model: '',
  review_session_model: '',
  corporate_mode_enabled: false,
}));

// Per-call run option captures — index 0 = first spawn, index 1 = escalated spawn.
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
          const callIndex = runCalls.length;
          runCalls.push({ options, onEvent });

          if (callIndex === 0) {
            // First run: emit overflow and exit non-zero.
            onEvent({
              type: 'result',
              stop_reason: 'model_context_window_exceeded',
              is_error: true,
              result: '',
              duration_ms: 100,
              usage: { input_tokens: 0, output_tokens: 0 },
            });
            return Promise.resolve(1);
          }

          // Escalated run: emit one event (triggers nudge delivery), exit cleanly.
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
import { CliSessionRunner } from '../CliSessionRunner';
import * as queries from '../../db/queries';
import type { ServerMessage } from '../../ws/types';

const LARGE_MODEL = 'claude-opus-4-7[1m]';
const SMALL_MODEL = 'claude-sonnet-4-6';

function makeSession(sessionType: 'standard' | 'review' = 'standard') {
  return new AgentSession(
    'test-session-overflow',
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
  vi.clearAllMocks();
  vi.mocked(queries.getSessionTags).mockReturnValue([]);
});

describe('AgentSession — large-model escalation on context overflow', () => {
  it('escalates to large model: resumes with big model, autocompact on, nudge sent, tag added', async () => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;

    const session = makeSession('standard');
    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    await session.run();

    // Runner was called twice: initial + escalated.
    expect(runCalls).toHaveLength(2);

    // Second call uses the large model.
    expect(runCalls[1].options.model).toBe(LARGE_MODEL);

    // Second call has autocompaction re-enabled (disableAutoCompact = false).
    expect(runCalls[1].options.disableAutoCompact).toBe(false);

    // Continuation nudge sent via sendMessage on the first event of the escalated session.
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0]).toContain('1M-context model');

    // large-model tag written to DB.
    expect(queries.setSessionTags).toHaveBeenCalledWith(
      'test-session-overflow',
      expect.arrayContaining(['large-model']),
    );

    // large_model_escalation_started broadcast.
    expect(
      messages.find((m) => m.type === 'large_model_escalation_started'),
    ).toBeDefined();

    // session_updated with the large-model tag.
    const tagUpdate = messages.find(
      (m) =>
        m.type === 'session_updated' &&
        'tags' in m &&
        (m as { tags?: string[] }).tags?.includes('large-model'),
    );
    expect(tagUpdate).toBeDefined();
  });

  it('escalates for review sessions (same code path)', async () => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;

    const session = makeSession('review');
    await session.run();

    expect(runCalls).toHaveLength(2);
    expect(runCalls[1].options.model).toBe(LARGE_MODEL);
    expect(runCalls[1].options.disableAutoCompact).toBe(false);
  });

  it('does not re-escalate when session is already on the large model', async () => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;

    // Simulate session already on the large model by pre-setting model.
    const session = makeSession('standard');
    (session as unknown as { model: string }).model = LARGE_MODEL;

    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    await session.run();

    // Runner called only once (no escalation re-spawn).
    expect(runCalls).toHaveLength(1);

    // Session ends in error (no escalation).
    const ended = messages.find((m) => m.type === 'session_ended');
    expect(ended).toBeDefined();
    expect(
      messages.find((m) => m.type === 'large_model_escalation_started'),
    ).toBeUndefined();

    // No nudge sent.
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('does not escalate when large_task_model is empty', async () => {
    mockRuntimeSettings.large_task_model = '';

    const session = makeSession('standard');
    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    await session.run();

    // Runner called only once (no escalation).
    expect(runCalls).toHaveLength(1);

    // Session ends in error.
    const ended = messages.find((m) => m.type === 'session_ended');
    expect(ended).toBeDefined();
    expect(
      messages.find((m) => m.type === 'large_model_escalation_started'),
    ).toBeUndefined();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(queries.setSessionTags).not.toHaveBeenCalled();
  });

  it('first spawn uses disableAutoCompact=true when large_task_model is set', async () => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;
    const session = makeSession('standard');
    await session.run();
    // First spawn: autocompact disabled (T2 behavior).
    expect(runCalls[0].options.disableAutoCompact).toBe(true);
    // Escalated spawn: autocompact re-enabled.
    expect(runCalls[1].options.disableAutoCompact).toBe(false);
  });

  it('uses session-specific model setting for first spawn, large model for escalated spawn', async () => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;
    mockRuntimeSettings.code_session_model = SMALL_MODEL;
    const session = makeSession('standard');
    await session.run();
    expect(runCalls[0].options.model).toBe(SMALL_MODEL);
    expect(runCalls[1].options.model).toBe(LARGE_MODEL);
  });

  it('escalates on clean exit (exitCode 0) when overflow detected and large model configured', async () => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;

    vi.mocked(CliSessionRunner).mockImplementationOnce(() => ({
      run: vi
        .fn()
        .mockImplementation(
          (
            _prompt: unknown,
            _resume: unknown,
            options: SessionRunnerOptions,
            onEvent: (e: Record<string, unknown>) => void,
          ) => {
            const callIndex = runCalls.length;
            runCalls.push({ options, onEvent });

            if (callIndex === 0) {
              // Emit overflow event, then exit cleanly (exit code 0).
              onEvent({
                type: 'result',
                stop_reason: 'model_context_window_exceeded',
                is_error: false,
                result: '',
                duration_ms: 100,
                usage: { input_tokens: 0, output_tokens: 0 },
              });
              return Promise.resolve(0);
            }

            // Escalated run: exit cleanly.
            onEvent({ type: 'system', subtype: 'init' });
            return Promise.resolve(0);
          },
        ),
      sendMessage: mockSendMessage,
      endSession: vi.fn(),
      kill: vi.fn().mockResolvedValue(undefined),
      hasSpawnError: false,
    }));

    const session = makeSession('standard');
    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    await session.run();

    // Escalated: two runner spawns, second uses large model.
    expect(runCalls).toHaveLength(2);
    expect(runCalls[1].options.model).toBe(LARGE_MODEL);
    expect(runCalls[1].options.disableAutoCompact).toBe(false);

    // Nudge sent.
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0]).toContain('1M-context model');

    // large-model tag written.
    expect(queries.setSessionTags).toHaveBeenCalledWith(
      'test-session-overflow',
      expect.arrayContaining(['large-model']),
    );

    // large_model_escalation_started broadcast.
    expect(
      messages.find((m) => m.type === 'large_model_escalation_started'),
    ).toBeDefined();
  });

  it('errors with context_overflow on clean exit when overflow detected but large model not configured', async () => {
    mockRuntimeSettings.large_task_model = '';

    vi.mocked(CliSessionRunner).mockImplementationOnce(() => ({
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
            // Emit overflow event, then exit cleanly (exit code 0).
            onEvent({
              type: 'result',
              stop_reason: 'model_context_window_exceeded',
              is_error: false,
              result: '',
              duration_ms: 100,
              usage: { input_tokens: 0, output_tokens: 0 },
            });
            return Promise.resolve(0);
          },
        ),
      sendMessage: mockSendMessage,
      endSession: vi.fn(),
      kill: vi.fn().mockResolvedValue(undefined),
      hasSpawnError: false,
    }));

    const session = makeSession('standard');
    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    await session.run();

    // Only one spawn — no escalation.
    expect(runCalls).toHaveLength(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(
      messages.find((m) => m.type === 'large_model_escalation_started'),
    ).toBeUndefined();

    // Session ends in error with context_overflow reason.
    const ended = messages.find((m) => m.type === 'session_ended');
    expect(ended).toBeDefined();
    expect(
      (ended as { status?: string } | undefined)?.status,
    ).toBe('error');
  });

  it('escalates when subprocess hangs after emitting "Prompt is too long" (endSession unblocks run)', async () => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;

    // Pre-create the hanging promise so resolveFirstRun is assigned before onEvent fires.
    let resolveFirstRun!: (exitCode: number) => void;
    const firstRunPromise = new Promise<number>((resolve) => {
      resolveFirstRun = resolve;
    });
    const mockEndSession = vi.fn().mockImplementation(() => {
      resolveFirstRun(1);
    });

    vi.mocked(CliSessionRunner).mockImplementationOnce(() => ({
      run: vi
        .fn()
        .mockImplementation(
          (
            _prompt: unknown,
            _resume: unknown,
            options: SessionRunnerOptions,
            onEvent: (e: Record<string, unknown>) => void,
          ) => {
            const callIndex = runCalls.length;
            runCalls.push({ options, onEvent });

            if (callIndex === 0) {
              // Emit "Prompt is too long" error result then hang (don't resolve).
              onEvent({
                type: 'result',
                is_error: true,
                result:
                  'Prompt is too long: 210000 tokens exceeds 200000 limit',
                stop_reason: null,
                duration_ms: 100,
                usage: { input_tokens: 0, output_tokens: 0 },
              });
              return firstRunPromise;
            }

            // Escalated run: emit one event, exit cleanly.
            onEvent({ type: 'system', subtype: 'init' });
            return Promise.resolve(0);
          },
        ),
      sendMessage: mockSendMessage,
      endSession: mockEndSession,
      kill: vi.fn().mockResolvedValue(undefined),
      hasSpawnError: false,
    }));

    const session = makeSession('standard');
    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    await session.run();

    // endSession was called to unblock the hanging subprocess.
    expect(mockEndSession).toHaveBeenCalled();

    // Escalation fired: two runner spawns, second uses large model.
    expect(runCalls).toHaveLength(2);
    expect(runCalls[1].options.model).toBe(LARGE_MODEL);
    expect(
      messages.find((m) => m.type === 'large_model_escalation_started'),
    ).toBeDefined();
  });
});
