import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn().mockReturnValue({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
    exitCode: null,
  }),
  execSync: vi.fn(),
}));

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
    insertPauseInterval: vi.fn(),
    setSessionPauseReason: vi.fn(),
    getSessionTags: vi.fn().mockReturnValue([]),
    setSessionTags: vi.fn(),
    markSessionInitiatedPRClose: vi.fn(),
    ackPendingComments: vi.fn(),
    listUndeliveredInboxItems: vi.fn().mockReturnValue([]),
    markInboxItemsDelivered: vi.fn(),
  }),
);

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  GITHUB_REPO: 'owner/repo',
  runtimeSettings: { corporate_mode_enabled: false },
  getProjectById: vi.fn().mockReturnValue(null),
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
  countEventsBySessionAndType: vi.fn().mockReturnValue(0),
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

vi.mock('../SessionAuditor', () => ({
  detectInFlightEscape: vi
    .fn()
    .mockReturnValue({ violations: [], specMismatch: null }),
}));

vi.mock('../../utils/eventFilters', () => ({
  isSystemOnlyUserEvent: vi.fn().mockReturnValue(false),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { execSync } from 'child_process';
import { AgentSession, isPreReviewBlocked } from '../AgentSession';
import { getPRBySessionId } from '../../db/queries';

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKTREE = '/fake/worktree';
const HEAD_SHA = 'abc1234';

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
    WORKTREE,
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

function emitToolUse(
  session: AgentSession,
  cmd: string,
  id: string,
  msgId: string,
) {
  sendEvent(session, {
    type: 'assistant',
    message: {
      id: msgId,
      content: [
        { type: 'tool_use', id, name: 'Bash', input: { command: cmd } },
      ],
    },
  });
}

function emitEmbeddedUserToolResult(
  session: AgentSession,
  id: string,
  content: unknown,
) {
  sendEvent(session, {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content,
        },
      ],
    },
  });
}

function emitResult(session: AgentSession) {
  sendEvent(session, { type: 'result', stop_reason: 'end_turn' });
}

const BLOCKED_PR = {
  pr_number: 99,
  repo: 'owner/repo',
  session_id: 'test-session-id',
  review_session_id: null,
  pre_review_stage: 'blocked_analyze',
  review_result: null,
  base_branch: 'dev',
};

function mockCleanWorktreeAt(sha: string) {
  vi.mocked(execSync).mockImplementation((cmd: string) => {
    if (cmd.includes('rev-parse --abbrev-ref'))
      return Buffer.from('feature/foo\n');
    if (cmd.includes('rev-parse HEAD')) return Buffer.from(`${sha}\n`);
    if (cmd.includes('ls-remote')) return Buffer.from(`${sha}\tfeature/foo\n`);
    return Buffer.from('');
  });
}

// ── Unit tests: isPreReviewBlocked ────────────────────────────────────────────

describe('isPreReviewBlocked', () => {
  it('returns true when pre_review_stage is a blocked_* stage and no review session', () => {
    expect(
      isPreReviewBlocked({
        review_session_id: null,
        pre_review_stage: 'blocked_analyze',
      }),
    ).toBe(true);
  });

  it('returns true when a failure verdict is recorded in review_result', () => {
    expect(
      isPreReviewBlocked({
        review_session_id: null,
        pre_review_stage: null,
        review_result: JSON.stringify({ verdict: 'analyze_failed' }),
      }),
    ).toBe(true);
  });

  it('returns false once a review session is established', () => {
    expect(
      isPreReviewBlocked({
        review_session_id: 'sess-1',
        pre_review_stage: 'blocked_analyze',
      }),
    ).toBe(false);
  });

  it('returns false when nothing indicates a blocked state', () => {
    expect(
      isPreReviewBlocked({
        review_session_id: null,
        pre_review_stage: null,
        review_result: null,
      }),
    ).toBe(false);
  });
});

// ── Integration: embedded user-event tool_result push detection ──────────────

describe('git push detection via embedded user-event tool_result (pre-review, no review session)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPRBySessionId).mockReturnValue(BLOCKED_PR as any);
    mockCleanWorktreeAt(HEAD_SHA);
  });

  it('fires handlePushDetected for a plain git push', () => {
    const session = makeSession();
    const pushDetectedEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushDetectedEvents.push(e));

    emitToolUse(session, 'git push origin feature/foo', 'toolu_1', 'msg_1');
    emitEmbeddedUserToolResult(session, 'toolu_1', 'Everything up-to-date');

    expect(pushDetectedEvents).toHaveLength(1);
    expect(pushDetectedEvents[0]).toMatchObject({
      sessionId: 'test-session-id',
    });
  });

  it('fires handlePushDetected for a piped/redirected push', () => {
    const session = makeSession();
    const pushDetectedEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushDetectedEvents.push(e));

    emitToolUse(
      session,
      'git push origin feature/foo 2>&1 | tail -20',
      'toolu_2',
      'msg_2',
    );
    emitEmbeddedUserToolResult(session, 'toolu_2', 'Everything up-to-date');

    expect(pushDetectedEvents).toHaveLength(1);
  });
});

// ── Integration: turn-complete gate relaxed for pre-review blocked PRs ───────

describe('turn-complete push signal for pre-review blocked PRs (no review_session_id)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCleanWorktreeAt(HEAD_SHA);
  });

  it('signals push_detected on turn complete when PR is blocked_* with no review session', () => {
    vi.mocked(getPRBySessionId).mockReturnValue(BLOCKED_PR as any);
    const session = makeSession();
    const pushDetectedEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushDetectedEvents.push(e));

    emitResult(session);

    expect(pushDetectedEvents).toHaveLength(1);
  });

  it('does not signal when PR has no review session and is not in a blocked state', () => {
    vi.mocked(getPRBySessionId).mockReturnValue({
      ...BLOCKED_PR,
      pre_review_stage: null,
      review_result: null,
    } as any);
    const session = makeSession();
    const pushDetectedEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushDetectedEvents.push(e));

    emitResult(session);

    expect(pushDetectedEvents).toHaveLength(0);
  });
});

// ── Dedup: both paths can fire for the same push, only one push_detected ─────

describe('no duplicate push_detected when both the immediate and turn-complete paths fire', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPRBySessionId).mockReturnValue(BLOCKED_PR as any);
    mockCleanWorktreeAt(HEAD_SHA);
  });

  it('dedupes via lastSignalledHeadSha when the immediate push detection already signalled this HEAD', () => {
    const session = makeSession();
    const pushDetectedEvents: unknown[] = [];
    session.on('push_detected', (e: unknown) => pushDetectedEvents.push(e));

    // Immediate path fires first (embedded tool_result), recording lastSignalledHeadSha.
    emitToolUse(session, 'git push origin feature/foo', 'toolu_3', 'msg_3');
    emitEmbeddedUserToolResult(session, 'toolu_3', 'Everything up-to-date');

    // Turn-complete path fires afterward for the same unchanged HEAD.
    emitResult(session);

    expect(pushDetectedEvents).toHaveLength(1);
  });
});
