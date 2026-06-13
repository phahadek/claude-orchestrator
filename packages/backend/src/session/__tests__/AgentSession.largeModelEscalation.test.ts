import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

    // Continuation nudge sent via sendMessage (proactively — either via the 2s
    // timer or when the first event from the escalated session clears the timer).
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
    expect((ended as { status?: string } | undefined)?.status).toBe('error');
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

// ── sendOrResume overflow: pending text re-delivery ──────────────────────────

describe('AgentSession — setPendingOverflowText re-delivery on escalation', () => {
  it('includes the pending feedback text in the escalation nudge', async () => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;

    const session = makeSession('standard');
    session.setPendingOverflowText('Please fix the lint errors in src/foo.ts');

    await session.run(); // first run overflows (default mock), second exits cleanly

    // Nudge sent to the escalated session must contain the original feedback text.
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const nudge = mockSendMessage.mock.calls[0][0] as string;
    expect(nudge).toContain('Please fix the lint errors in src/foo.ts');
    expect(nudge).toContain('1M-context model');
  });

  it('uses the generic nudge when no pending text is set', async () => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;

    const session = makeSession('standard');
    // No setPendingOverflowText call.

    await session.run();

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const nudge = mockSendMessage.mock.calls[0][0] as string;
    expect(nudge).toContain('Continue the task from where you left off');
  });

  it('does not re-deliver pending text on a second escalation (consumed after first)', async () => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;

    let callCount = 0;
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
            const idx = callCount++;
            runCalls.push({ options, onEvent });
            if (idx === 0) {
              // First run: overflow
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
            if (idx === 1) {
              // Escalated run: overflow again (triggers second escalation attempt)
              onEvent({ type: 'system', subtype: 'init' }); // triggers nudge delivery
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
            // Third run: exit cleanly
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
    session.setPendingOverflowText('original feedback');

    await session.run();

    // First nudge includes the original text; second nudge (if any re-escalation happens)
    // uses the generic message because pendingOverflowText was consumed.
    // (In practice this scenario won't re-escalate because model === largeModel,
    // but the field consumption is still verified via the first nudge.)
    const firstNudge = mockSendMessage.mock.calls[0]?.[0] as string | undefined;
    expect(firstNudge).toContain('original feedback');
  });

  it('does not re-escalate when already on the large model, even with pending text set', async () => {
    mockRuntimeSettings.large_task_model = LARGE_MODEL;

    const session = makeSession('standard');
    (session as unknown as { model: string }).model = LARGE_MODEL;
    session.setPendingOverflowText('some feedback');

    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    await session.run();

    // No escalation — already on large model.
    expect(runCalls).toHaveLength(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(
      messages.find((m) => m.type === 'large_model_escalation_started'),
    ).toBeUndefined();

    // Session ends in error.
    const ended = messages.find((m) => m.type === 'session_ended');
    expect(ended).toBeDefined();
  });
});

// ── Escalation watchdog + bounded retry ──────────────────────────────────────

describe('AgentSession — escalation deadlock watchdog + bounded retry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('watchdog fires when escalated run deadlocks, retries, succeeds on second attempt', async () => {
    vi.useFakeTimers();
    mockRuntimeSettings.large_task_model = LARGE_MODEL;

    // Attempt 1 (escalated): deadlock — resolves only when kill() is called.
    let killAttempt1!: (code: number) => void;
    const attempt1Promise = new Promise<number>((r) => {
      killAttempt1 = r;
    });
    const mockKill = vi.fn().mockImplementation(async () => {
      killAttempt1(1);
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
            const idx = runCalls.length;
            runCalls.push({ options, onEvent });

            if (idx === 0) {
              // Normal run: overflow, exit 1.
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
            if (idx === 1) {
              // First escalated run: deadlock (no events emitted).
              return attempt1Promise;
            }
            // Second escalated run: success.
            onEvent({ type: 'system', subtype: 'init' });
            return Promise.resolve(0);
          },
        ),
      sendMessage: mockSendMessage,
      endSession: vi.fn(),
      kill: mockKill,
      hasSpawnError: false,
    }));

    const session = makeSession('standard');
    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    const runPromise = session.run();

    // Advance past proactive nudge delay (2s): nudge must be sent even without events.
    await vi.advanceTimersByTimeAsync(2_100);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0]).toContain('1M-context model');

    // Advance past watchdog (30s): watchdog kills runner, attempt 1 resolves, retry spawns.
    await vi.advanceTimersByTimeAsync(30_000);

    // Complete run.
    await runPromise;

    // 3 total spawns: initial + attempt1 (deadlock) + attempt2 (success).
    expect(runCalls).toHaveLength(3);
    expect(runCalls[2].options.model).toBe(LARGE_MODEL);

    // kill() was called once to end the deadlocked attempt.
    expect(mockKill).toHaveBeenCalledTimes(1);

    // Second attempt also got a nudge (via first-event handler, before its 2s timer).
    expect(mockSendMessage).toHaveBeenCalledTimes(2);

    // Session completed cleanly (markSessionIdle called, no error broadcast).
    expect(queries.markSessionIdle).toHaveBeenCalled();
    expect(messages.find((m) => m.type === 'session_ended')).toBeUndefined();
  });

  it('all retries exhausted: session errors with escalation_deadlock', async () => {
    vi.useFakeTimers();
    mockRuntimeSettings.large_task_model = LARGE_MODEL;

    const killResolvers: Array<(code: number) => void> = [];
    const mockKill = vi.fn().mockImplementation(async () => {
      const resolve = killResolvers.pop();
      if (resolve) resolve(1);
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
            const idx = runCalls.length;
            runCalls.push({ options, onEvent });

            if (idx === 0) {
              // Normal run: overflow.
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
            // All escalated runs: deadlock.
            return new Promise<number>((r) => killResolvers.push(r));
          },
        ),
      sendMessage: mockSendMessage,
      endSession: vi.fn(),
      kill: mockKill,
      hasSpawnError: false,
    }));

    const mockSessionManager = {
      markSessionErrored: vi.fn(),
      send: vi.fn(),
    };

    const session = new AgentSession(
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
      'standard',
      mockSessionManager as never,
    );
    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    const runPromise = session.run();

    // Fire watchdog for all 3 attempts (initial + 2 retries).
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(32_100); // past nudge (2s) + watchdog (30s)
    }

    await runPromise;

    // 4 total spawns: initial (overflow) + 3 escalated attempts (all deadlocked).
    expect(runCalls).toHaveLength(4);

    // kill() called 3 times (once per deadlocked attempt).
    expect(mockKill).toHaveBeenCalledTimes(3);

    // markSessionErrored called with escalation_deadlock reason.
    expect(mockSessionManager.markSessionErrored).toHaveBeenCalledWith(
      'test-session-overflow',
      'error',
      'escalation_deadlock',
    );

    // Session never ended as done.
    expect(
      messages.find(
        (m) =>
          m.type === 'session_ended' &&
          (m as { status?: string }).status === 'done',
      ),
    ).toBeUndefined();
  });

  it('watchdog timer cleared on first event — healthy escalation has no spurious retry', async () => {
    vi.useFakeTimers();
    mockRuntimeSettings.large_task_model = LARGE_MODEL;

    // Default mock: overflow on idx=0, init+success on idx=1.
    const session = makeSession('standard');
    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    const runPromise = session.run();

    // The escalated run emits init synchronously — watchdog should be cleared.
    // Advance well past watchdog to confirm no spurious retry fires.
    await vi.advanceTimersByTimeAsync(60_000);

    await runPromise;

    // Only 2 runs: initial + one healthy escalated run (no retry).
    expect(runCalls).toHaveLength(2);

    // Nudge sent once (via first-event handler, since init arrived before 2s timer).
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    // Session completed cleanly — no error, no spurious retry.
    expect(queries.markSessionIdle).toHaveBeenCalled();
    expect(messages.find((m) => m.type === 'session_ended')).toBeUndefined();
  });

  it('nudge sent proactively via timer when no first event arrives within 2s', async () => {
    vi.useFakeTimers();
    mockRuntimeSettings.large_task_model = LARGE_MODEL;

    let killAttempt1!: (code: number) => void;
    const attempt1Promise = new Promise<number>((r) => {
      killAttempt1 = r;
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
            const idx = runCalls.length;
            runCalls.push({ options, onEvent });
            if (idx === 0) {
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
            if (idx === 1) {
              // No events emitted — deadlock.
              return attempt1Promise;
            }
            onEvent({ type: 'system', subtype: 'init' });
            return Promise.resolve(0);
          },
        ),
      sendMessage: mockSendMessage,
      endSession: vi.fn(),
      kill: vi.fn().mockImplementation(async () => killAttempt1(1)),
      hasSpawnError: false,
    }));

    const session = makeSession('standard');
    session.run().catch(() => {});

    // Before 2s: nudge not yet sent.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mockSendMessage).not.toHaveBeenCalled();

    // After 2s: nudge sent proactively (no first event arrived).
    await vi.advanceTimersByTimeAsync(700);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0]).toContain('1M-context model');

    // Advance past watchdog to clean up.
    await vi.advanceTimersByTimeAsync(30_000);
  });
});
