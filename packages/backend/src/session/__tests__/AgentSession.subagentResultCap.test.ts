import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

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
}));

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
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

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  AgentSession,
  capSubagentToolResults,
  MAX_SUBAGENT_RESULT_BYTES,
} from '../AgentSession';
import { upsertSessionEvent } from '../../db/queries';

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
  );
}

function sendEvent(session: AgentSession, event: Record<string, unknown>) {
  (
    session as unknown as {
      handleRawEvent: (e: Record<string, unknown>) => void;
    }
  ).handleRawEvent(event);
}

function emitTaskToolUse(session: AgentSession, toolUseId: string) {
  sendEvent(session, {
    type: 'assistant',
    message: {
      id: 'msg_task_001',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Task',
          input: { description: 'do research', prompt: 'find X' },
        },
      ],
    },
  });
}

// ── Unit tests: capSubagentToolResults (pure function) ─────────────────────────

describe('capSubagentToolResults', () => {
  it('passes through a small subagent tool_result unchanged', () => {
    const ids = new Set(['toolu_1']);
    const event = {
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'short result',
    };
    const result = capSubagentToolResults(event, ids);
    expect(result).toBe(event);
    expect(result.content).toBe('short result');
  });

  it('elides a large subagent tool_result while preserving the invocation fact', () => {
    const ids = new Set(['toolu_2']);
    const largeText = 'x'.repeat(MAX_SUBAGENT_RESULT_BYTES + 5000);
    const event = {
      type: 'tool_result',
      tool_use_id: 'toolu_2',
      content: largeText,
    };
    const result = capSubagentToolResults(event, ids);
    expect(result.tool_use_id).toBe('toolu_2');
    expect(result.content).not.toBe(largeText);
    expect((result.content as string).length).toBeLessThan(largeText.length);
    expect(result.content).toContain('truncated');
    expect(result.subagent_result_capped).toBe(true);
    // Consumed id should be removed so the set doesn't grow unbounded.
    expect(ids.has('toolu_2')).toBe(false);
  });

  it('does not cap a tool_result whose tool_use_id is not a pending subagent call', () => {
    const ids = new Set<string>();
    const largeText = 'y'.repeat(MAX_SUBAGENT_RESULT_BYTES + 5000);
    const event = {
      type: 'tool_result',
      tool_use_id: 'toolu_other',
      content: largeText,
    };
    const result = capSubagentToolResults(event, ids);
    expect(result).toBe(event);
    expect(result.content).toBe(largeText);
  });

  it('caps a tool_result block embedded in a user event message', () => {
    const ids = new Set(['toolu_3']);
    const largeText = 'z'.repeat(MAX_SUBAGENT_RESULT_BYTES + 5000);
    const event = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_3', content: largeText },
        ],
      },
    };
    const result = capSubagentToolResults(event, ids) as Record<
      string,
      unknown
    >;
    const message = result.message as Record<string, unknown>;
    const content = message.content as Array<Record<string, unknown>>;
    expect(content[0].content).not.toBe(largeText);
    expect(content[0].content).toContain('truncated');
  });
});

// ── Integration tests: handleRawEvent persists the capped payload ──────────────

describe('subagent tool_result capping via handleRawEvent', () => {
  beforeEach(() => {
    vi.mocked(upsertSessionEvent).mockClear();
  });

  it('stores a bounded payload for a large Task subagent tool_result', () => {
    const session = makeSession();
    const TOOL_USE_ID = 'toolu_task_large';
    emitTaskToolUse(session, TOOL_USE_ID);

    const largeText = 'a'.repeat(MAX_SUBAGENT_RESULT_BYTES + 10000);
    sendEvent(session, {
      type: 'tool_result',
      tool_use_id: TOOL_USE_ID,
      content: largeText,
    });

    const calls = vi.mocked(upsertSessionEvent).mock.calls;
    const toolResultCall = calls.find((c) => {
      const payload = JSON.parse((c[0] as { payload: string }).payload);
      return payload.tool_use_id === TOOL_USE_ID;
    });
    expect(toolResultCall).toBeDefined();
    const storedPayload = (toolResultCall![0] as { payload: string }).payload;
    expect(storedPayload).not.toContain(largeText);
    expect(storedPayload.length).toBeLessThan(largeText.length);
    expect(storedPayload).toContain('truncated');
  });

  it('stores a small Task subagent tool_result unchanged', () => {
    const session = makeSession();
    const TOOL_USE_ID = 'toolu_task_small';
    emitTaskToolUse(session, TOOL_USE_ID);

    sendEvent(session, {
      type: 'tool_result',
      tool_use_id: TOOL_USE_ID,
      content: 'a short subagent answer',
    });

    const calls = vi.mocked(upsertSessionEvent).mock.calls;
    const toolResultCall = calls.find((c) => {
      const payload = JSON.parse((c[0] as { payload: string }).payload);
      return payload.tool_use_id === TOOL_USE_ID;
    });
    expect(toolResultCall).toBeDefined();
    const storedPayload = JSON.parse(
      (toolResultCall![0] as { payload: string }).payload,
    );
    expect(storedPayload.content).toBe('a short subagent answer');
  });

  it('does not cap a large tool_result from a non-subagent tool (e.g. Bash)', () => {
    const session = makeSession();
    const TOOL_USE_ID = 'toolu_bash_large';
    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_bash_001',
        content: [
          {
            type: 'tool_use',
            id: TOOL_USE_ID,
            name: 'Bash',
            input: { command: 'echo hi' },
          },
        ],
      },
    });

    const largeText = 'b'.repeat(MAX_SUBAGENT_RESULT_BYTES + 10000);
    sendEvent(session, {
      type: 'tool_result',
      tool_use_id: TOOL_USE_ID,
      content: largeText,
    });

    const calls = vi.mocked(upsertSessionEvent).mock.calls;
    const toolResultCall = calls.find((c) => {
      const payload = JSON.parse((c[0] as { payload: string }).payload);
      return payload.tool_use_id === TOOL_USE_ID;
    });
    expect(toolResultCall).toBeDefined();
    const storedPayload = JSON.parse(
      (toolResultCall![0] as { payload: string }).payload,
    );
    expect(storedPayload.content).toBe(largeText);
  });
});
