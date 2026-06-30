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
  setSessionPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  getSessionTags: vi.fn().mockReturnValue([]),
  setSessionTags: vi.fn(),
  resetTaskCrashCount: vi.fn(),
  getSession: vi.fn().mockReturnValue(null),
  ackPendingComments: vi.fn(),
  listUndeliveredInboxItems: vi.fn().mockReturnValue([]),
  markInboxItemsDelivered: vi.fn(),
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

vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === 'git rev-parse HEAD') return 'abc1234567890\n';
    if (cmd === 'git branch --show-current') return 'feature/my-task\n';
    throw new Error(`unexpected execSync: ${cmd}`);
  }),
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

vi.mock('../../db/pauseReason', () => ({
  pauseReasonFromCanonical: vi.fn(),
  serializePauseReason: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { parseDispositionBlock } from '../AgentSession';
import { AgentSession } from '../AgentSession';
import { getPRBySessionId, ackPendingComments } from '../../db/queries';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession() {
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
    undefined,
  );
}

function sendEvent(session: AgentSession, event: Record<string, unknown>) {
  (
    session as unknown as {
      handleRawEvent: (e: Record<string, unknown>) => void;
    }
  ).handleRawEvent(event);
}

const BASE_PR_ROW = {
  pr_number: 42,
  repo: 'owner/repo',
  session_id: 'test-session-id',
  review_session_id: null,
  base_branch: 'dev',
  head_branch: 'feature/my-task',
  head_sha: 'abc123',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── parseDispositionBlock ─────────────────────────────────────────────────────

describe('parseDispositionBlock()', () => {
  it('returns null when no "dispositions" key present', () => {
    expect(parseDispositionBlock('Some text without dispositions')).toBeNull();
    expect(parseDispositionBlock('')).toBeNull();
  });

  it('parses a single addressed disposition', () => {
    const text = `Here is my response.\n\n{"dispositions":[{"comment_id":123,"disposition":"addressed"}]}\n`;
    const result = parseDispositionBlock(text);
    expect(result).toEqual([
      { comment_id: 123, disposition: 'addressed', reason: undefined },
    ]);
  });

  it('parses wont_fix with reason', () => {
    const text = `{"dispositions":[{"comment_id":456,"disposition":"wont_fix","reason":"Not applicable here"}]}`;
    const result = parseDispositionBlock(text);
    expect(result).toEqual([
      {
        comment_id: 456,
        disposition: 'wont_fix',
        reason: 'Not applicable here',
      },
    ]);
  });

  it('parses out_of_scope with reason', () => {
    const text = `{"dispositions":[{"comment_id":789,"disposition":"out_of_scope","reason":"Different PR scope"}]}`;
    const result = parseDispositionBlock(text);
    expect(result).toEqual([
      {
        comment_id: 789,
        disposition: 'out_of_scope',
        reason: 'Different PR scope',
      },
    ]);
  });

  it('parses multiple dispositions', () => {
    const text = `{"dispositions":[{"comment_id":1,"disposition":"addressed"},{"comment_id":2,"disposition":"wont_fix","reason":"By design"}]}`;
    const result = parseDispositionBlock(text);
    expect(result).toHaveLength(2);
    expect(result![0].comment_id).toBe(1);
    expect(result![1].comment_id).toBe(2);
  });

  it('returns null for malformed JSON', () => {
    expect(parseDispositionBlock('{"dispositions": [broken')).toBeNull();
  });

  it('returns null when dispositions is not an array', () => {
    expect(
      parseDispositionBlock('{"dispositions": "not-an-array"}'),
    ).toBeNull();
  });

  it('skips items with invalid disposition value', () => {
    const text = `{"dispositions":[{"comment_id":1,"disposition":"invalid"},{"comment_id":2,"disposition":"addressed"}]}`;
    const result = parseDispositionBlock(text);
    expect(result).toHaveLength(1);
    expect(result![0].comment_id).toBe(2);
  });

  it('returns null when all items are invalid', () => {
    const text = `{"dispositions":[{"comment_id":"not-a-number","disposition":"addressed"}]}`;
    const result = parseDispositionBlock(text);
    expect(result).toBeNull();
  });

  it('handles dispositions embedded in surrounding text', () => {
    const text = `I've addressed these comments.\n\n{"dispositions":[{"comment_id":100,"disposition":"addressed","reason":"Fixed"}]}\n\nPlease review.`;
    const result = parseDispositionBlock(text);
    expect(result).toHaveLength(1);
    expect(result![0].comment_id).toBe(100);
  });
});

// ── AgentSession: disposition emission ───────────────────────────────────────

describe('AgentSession — dispositions_parsed emission', () => {
  it('emits dispositions_parsed after result event when disposition block detected', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(BASE_PR_ROW as any);
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('dispositions_parsed', (p) => emitted.push(p));

    // Send assistant event with disposition block
    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_disp_1',
        content: [
          {
            type: 'text',
            text: 'Done.\n\n{"dispositions":[{"comment_id":123,"disposition":"addressed"}]}',
          },
        ],
      },
    });

    // Send result event (turn completion)
    sendEvent(session, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(emitted).toHaveLength(1);
    const payload = emitted[0] as any;
    expect(payload.prNumber).toBe(42);
    expect(payload.repo).toBe('owner/repo');
    expect(payload.dispositions).toHaveLength(1);
    expect(payload.dispositions[0].comment_id).toBe(123);
    expect(payload.dispositions[0].disposition).toBe('addressed');
    expect(payload.headSha).toBeTruthy();
  });

  it('does not emit dispositions_parsed when no disposition block present', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(BASE_PR_ROW as any);
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('dispositions_parsed', (p) => emitted.push(p));

    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_no_disp',
        content: [{ type: 'text', text: 'I pushed a fix.' }],
      },
    });

    sendEvent(session, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(emitted).toHaveLength(0);
  });

  it('does not emit dispositions_parsed when result is an error', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(BASE_PR_ROW as any);
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('dispositions_parsed', (p) => emitted.push(p));

    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_disp_err',
        content: [
          {
            type: 'text',
            text: '{"dispositions":[{"comment_id":1,"disposition":"addressed"}]}',
          },
        ],
      },
    });

    sendEvent(session, {
      type: 'result',
      subtype: 'error',
      is_error: true,
      stop_reason: 'error',
      usage: {},
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(emitted).toHaveLength(0);
  });
});

// ── At-least-once ack unchanged ───────────────────────────────────────────────

describe('AgentSession — at-least-once ack unchanged by dispositions', () => {
  it('calls ackPendingComments on turn completion even when dispositions are present', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(BASE_PR_ROW as any);
    const session = makeSession();

    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_disp_ack',
        content: [
          {
            type: 'text',
            text: '{"dispositions":[{"comment_id":42,"disposition":"wont_fix","reason":"design decision"}]}',
          },
        ],
      },
    });

    sendEvent(session, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(ackPendingComments)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });

  it('calls ackPendingComments even when no dispositions are emitted', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(BASE_PR_ROW as any);
    const session = makeSession();

    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_no_disp_ack',
        content: [{ type: 'text', text: 'Just a regular turn.' }],
      },
    });

    sendEvent(session, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(ackPendingComments)).toHaveBeenCalledWith(
      42,
      'owner/repo',
    );
  });

  it('does NOT call ackPendingComments when result is an error', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(BASE_PR_ROW as any);
    const session = makeSession();

    sendEvent(session, {
      type: 'result',
      subtype: 'error',
      is_error: true,
      stop_reason: 'error',
      usage: {},
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(ackPendingComments)).not.toHaveBeenCalled();
  });
});
