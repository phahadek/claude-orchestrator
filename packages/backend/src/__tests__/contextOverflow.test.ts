import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { isContextOverflow } from '../session/contextOverflow';

// ── Pure classifier unit tests ────────────────────────────────────────────────

describe('isContextOverflow — classifier', () => {
  describe('overflow cases', () => {
    it('stop_reason=model_context_window_exceeded → overflow', () => {
      expect(
        isContextOverflow({
          type: 'result',
          stop_reason: 'model_context_window_exceeded',
        }),
      ).toBe(true);
    });

    it('is_error=true + result matching /prompt is too long/i → overflow', () => {
      expect(
        isContextOverflow({
          type: 'result',
          is_error: true,
          result: 'Prompt is too long: 250000 tokens > 200000 token limit',
        }),
      ).toBe(true);
    });

    it('case-insensitive match on "PROMPT IS TOO LONG"', () => {
      expect(
        isContextOverflow({
          type: 'result',
          is_error: true,
          result: 'PROMPT IS TOO LONG',
        }),
      ).toBe(true);
    });
  });

  describe('non-overflow cases', () => {
    it('transient 529 overloaded_error event → not overflow', () => {
      expect(
        isContextOverflow({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        }),
      ).toBe(false);
    });

    it('transient 500 api_error event → not overflow', () => {
      expect(
        isContextOverflow({
          type: 'error',
          error: { type: 'api_error', message: 'Internal error' },
        }),
      ).toBe(false);
    });

    it('successful result event (stop_reason=end_turn) → not overflow', () => {
      expect(
        isContextOverflow({
          type: 'result',
          subtype: 'success',
          stop_reason: 'end_turn',
          is_error: false,
        }),
      ).toBe(false);
    });

    it('is_error=true with unrelated error message → not overflow', () => {
      expect(
        isContextOverflow({
          type: 'result',
          is_error: true,
          result: 'Some other error occurred',
        }),
      ).toBe(false);
    });

    it('is_error=false even if result contains "prompt is too long" text → not overflow', () => {
      expect(
        isContextOverflow({
          type: 'result',
          is_error: false,
          result: 'prompt is too long',
        }),
      ).toBe(false);
    });

    it('empty event → not overflow', () => {
      expect(isContextOverflow({})).toBe(false);
    });

    it('ordinary text event → not overflow', () => {
      expect(
        isContextOverflow({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello' }],
          },
        }),
      ).toBe(false);
    });
  });
});

// ── Integration: AgentSession emits context_overflow_detected distinctly ──────

// Mocks must be declared before importing AgentSession (vi.mock is hoisted).

let spawnMockFn = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMockFn(...args),
  execFile: vi.fn(),
}));

vi.mock('../db/queries', () => ({
  upsertSessionEvent: vi.fn(() => 1),
  updateSessionStatus: vi.fn(),
  markSessionDone: vi.fn(),
  getEventsBySession: vi.fn(() => []),
  insertPermissionDenial: vi.fn(),
  upsertPullRequest: vi.fn(),
  incrementTokens: vi.fn(),
  incrementCompactionCount: vi.fn(),
  setContextOccupancy: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionMetadata: vi.fn(),
  getPRBySessionId: vi.fn(() => null),
  getPRByNumber: vi.fn(() => null),
  setHeadSha: vi.fn(),
  setPauseReason: vi.fn(),
  setSessionPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  getProjectRowById: vi.fn(() => null),
  getSession: vi.fn(() => null),
  insertLocalBranch: vi.fn(),
  insertSessionAudit: vi.fn(),
  getPRByNotionTaskId: vi.fn(() => null),
  listMilestonesByProject: vi.fn(() => []),
}));

vi.mock('../orchestration/localBranchHelpers', () => ({
  getCurrentBranch: vi.fn(async () => 'feature/test'),
  hasNonEmptyDiff: vi.fn(async () => false),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
  countPushFailureEvents: vi.fn(() => 0),
}));

vi.mock('../github/NoOpInvestigator', () => ({
  NoOpInvestigator: vi.fn().mockImplementation(() => ({
    investigate: vi.fn(async () => {}),
  })),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    type: 'local',
    updateStatus: vi.fn(async () => {}),
    fetchReadyTasks: vi.fn(async () => []),
    attachPR: vi.fn(async () => {}),
  })),
}));

import { AgentSession } from '../session/AgentSession';
import type { ServerMessage } from '../ws/types';

function makeProc() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(_c: unknown, _e: unknown, cb: () => void) {
      cb();
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    pid: 99,
  });
  return { proc, stdout };
}

describe('AgentSession — context overflow integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnMockFn = vi.fn();
  });

  it('emits context_overflow_detected and session_ended on stop_reason overflow', async () => {
    const { proc, stdout } = makeProc();
    spawnMockFn.mockReturnValue(proc);

    const session = new AgentSession(
      's-overflow',
      'https://notion.so/task',
      'https://notion.so/ctx',
      undefined,
      '/tmp',
      'task-1',
    );
    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    const runPromise = session.run();

    stdout.push(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_tokens',
        stop_reason: 'model_context_window_exceeded',
        is_error: true,
        result: '',
        duration_ms: 1000,
        usage: { input_tokens: 0, output_tokens: 0 },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    proc.emit('exit', 1);
    await runPromise;

    const overflowMsg = messages.find(
      (m) => m.type === 'context_overflow_detected',
    );
    expect(overflowMsg).toBeDefined();
    expect((overflowMsg as { type: string; sessionId: string }).sessionId).toBe(
      's-overflow',
    );

    expect(messages.find((m) => m.type === 'session_ended')).toBeDefined();
  });

  it('emits context_overflow_detected on is_error=true + "prompt is too long"', async () => {
    const { proc, stdout } = makeProc();
    spawnMockFn.mockReturnValue(proc);

    const session = new AgentSession(
      's-toolong',
      'https://notion.so/task',
      'https://notion.so/ctx',
      undefined,
      '/tmp',
      'task-2',
    );
    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    const runPromise = session.run();

    stdout.push(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Prompt is too long: 210000 tokens exceeds the 200000 limit',
        stop_reason: 'end_turn',
        duration_ms: 500,
        usage: { input_tokens: 0, output_tokens: 0 },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    proc.emit('exit', 1);
    await runPromise;

    expect(
      messages.find((m) => m.type === 'context_overflow_detected'),
    ).toBeDefined();
  });

  it('does NOT emit context_overflow_detected for a successful result', async () => {
    const { proc, stdout } = makeProc();
    spawnMockFn.mockReturnValue(proc);

    const session = new AgentSession(
      's-ok',
      'https://notion.so/task',
      'https://notion.so/ctx',
      undefined,
      '/tmp',
      'task-3',
    );
    const messages: ServerMessage[] = [];
    session.on('message', (m: ServerMessage) => messages.push(m));

    const runPromise = session.run();

    stdout.push(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        stop_reason: 'end_turn',
        is_error: false,
        duration_ms: 1000,
        usage: { input_tokens: 100, output_tokens: 50 },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));

    stdout.push(null);
    await new Promise((r) => setTimeout(r, 0));
    proc.emit('exit', 0);
    await runPromise;

    expect(
      messages.find((m) => m.type === 'context_overflow_detected'),
    ).toBeUndefined();
  });
});
