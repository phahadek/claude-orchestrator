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

import { parseVerifiedFlakyDisposition } from '../AgentSession';
import { AgentSession } from '../AgentSession';
import { getPRBySessionId } from '../../db/queries';

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

// ── parseVerifiedFlakyDisposition ───────────────────────────────────────────

describe('parseVerifiedFlakyDisposition()', () => {
  it('returns null when no "verified_flaky" key present', () => {
    expect(parseVerifiedFlakyDisposition('Some regular text')).toBeNull();
    expect(parseVerifiedFlakyDisposition('')).toBeNull();
  });

  it('parses a ci-gate disposition', () => {
    const text = `Diagnosed the flake.\n\n{"verified_flaky":{"gate":"ci","reason":"xdist/Postgres contention unrelated to this diff"}}\n`;
    const result = parseVerifiedFlakyDisposition(text);
    expect(result).toEqual({
      gate: 'ci',
      reason: 'xdist/Postgres contention unrelated to this diff',
    });
  });

  it('parses an f2-gate disposition', () => {
    const text = `{"verified_flaky":{"gate":"f2","reason":"isolated run + full suite twice both passed"}}`;
    const result = parseVerifiedFlakyDisposition(text);
    expect(result).toEqual({
      gate: 'f2',
      reason: 'isolated run + full suite twice both passed',
    });
  });

  it('returns null for malformed JSON', () => {
    expect(
      parseVerifiedFlakyDisposition('{"verified_flaky": [broken'),
    ).toBeNull();
  });

  it('returns null when gate is not "ci" or "f2"', () => {
    const text = `{"verified_flaky":{"gate":"unknown","reason":"whatever"}}`;
    expect(parseVerifiedFlakyDisposition(text)).toBeNull();
  });

  it('returns null when reason is missing or empty', () => {
    expect(
      parseVerifiedFlakyDisposition('{"verified_flaky":{"gate":"ci"}}'),
    ).toBeNull();
    expect(
      parseVerifiedFlakyDisposition(
        '{"verified_flaky":{"gate":"ci","reason":""}}',
      ),
    ).toBeNull();
  });
});

// ── AgentSession: verified_flaky_disposition emission ────────────────────────

describe('AgentSession — verified_flaky_disposition emission', () => {
  it('emits verified_flaky_disposition after result event when block detected', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(BASE_PR_ROW as any);
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('verified_flaky_disposition', (p) => emitted.push(p));

    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_flaky_1',
        content: [
          {
            type: 'text',
            text: 'Ran the failing test in isolation and the full suite twice more — all passing. Unrelated to this diff.\n\n{"verified_flaky":{"gate":"ci","reason":"xdist/Postgres contention"}}',
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

    expect(emitted).toHaveLength(1);
    const payload = emitted[0] as any;
    expect(payload.prNumber).toBe(42);
    expect(payload.repo).toBe('owner/repo');
    expect(payload.disposition).toEqual({
      gate: 'ci',
      reason: 'xdist/Postgres contention',
    });
    expect(payload.headSha).toBeTruthy();
  });

  it('does not emit verified_flaky_disposition when no block present', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(BASE_PR_ROW as any);
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('verified_flaky_disposition', (p) => emitted.push(p));

    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_no_flaky',
        content: [{ type: 'text', text: 'Fixed the bug in the diff.' }],
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

  it('does not emit verified_flaky_disposition when result is an error', async () => {
    vi.mocked(getPRBySessionId).mockReturnValue(BASE_PR_ROW as any);
    const session = makeSession();
    const emitted: unknown[] = [];
    session.on('verified_flaky_disposition', (p) => emitted.push(p));

    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_flaky_err',
        content: [
          {
            type: 'text',
            text: '{"verified_flaky":{"gate":"f2","reason":"contention"}}',
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
