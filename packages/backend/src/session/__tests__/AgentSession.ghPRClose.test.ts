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
  markSessionInitiatedPRClose: vi.fn(),
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

import { isPRCloseCommand } from '../AgentSession';
import { AgentSession } from '../AgentSession';
import {
  getPRBySessionId,
  markSessionInitiatedPRClose,
} from '../../db/queries';

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

const OWN_PR = {
  pr_number: 42,
  repo: 'owner/repo',
  session_id: 'test-session-id',
};

// ── Unit tests: isPRCloseCommand ─────────────────────────────────────────────

describe('isPRCloseCommand', () => {
  it('returns true for gh pr close', () => {
    expect(isPRCloseCommand('Bash', 'gh pr close 42')).toBe(true);
  });

  it('returns true for gh pr reopen', () => {
    expect(isPRCloseCommand('Bash', 'gh pr reopen 42')).toBe(true);
  });

  it('returns false for gh pr create', () => {
    expect(isPRCloseCommand('Bash', 'gh pr create')).toBe(false);
  });

  it('returns false for gh pr view/list', () => {
    expect(isPRCloseCommand('Bash', 'gh pr view 42')).toBe(false);
    expect(isPRCloseCommand('Bash', 'gh pr list')).toBe(false);
  });

  it('returns false for non-Bash tool names', () => {
    expect(
      isPRCloseCommand('mcp__github__create_pull_request', 'gh pr close'),
    ).toBe(false);
  });
});

// ── Integration tests: live detection via handleRawEvent ─────────────────────

describe('gh pr close/reopen live detection via handleRawEvent (top-level tool_result)', () => {
  const TOOL_USE_ID = 'toolu_bash_close_001';
  const CMD = 'gh pr close 42';

  beforeEach(() => {
    vi.mocked(getPRBySessionId).mockReturnValue(OWN_PR as never);
    vi.mocked(markSessionInitiatedPRClose).mockClear();
  });

  function emitToolUse(session: AgentSession, cmd: string, id: string) {
    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_001',
        content: [
          { type: 'tool_use', id, name: 'Bash', input: { command: cmd } },
        ],
      },
    });
  }

  function emitToolResult(session: AgentSession, id: string, content: unknown) {
    sendEvent(session, { type: 'tool_result', tool_use_id: id, content });
  }

  it('sets the session-initiated mark on the own PR when gh pr close runs', () => {
    const session = makeSession();
    emitToolUse(session, CMD, TOOL_USE_ID);
    emitToolResult(session, TOOL_USE_ID, 'Closed pull request #42');

    expect(markSessionInitiatedPRClose).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('sets the mark for gh pr reopen too', () => {
    const session = makeSession();
    emitToolUse(session, 'gh pr reopen 42', TOOL_USE_ID);
    emitToolResult(session, TOOL_USE_ID, 'Reopened pull request #42');

    expect(markSessionInitiatedPRClose).toHaveBeenCalledWith(42, 'owner/repo');
  });

  it('does not set the mark for unrelated Bash commands', () => {
    const session = makeSession();
    emitToolUse(session, 'gh pr view 42', TOOL_USE_ID);
    emitToolResult(session, TOOL_USE_ID, 'some output');

    expect(markSessionInitiatedPRClose).not.toHaveBeenCalled();
  });

  it('is a no-op when the session has no PR row yet', () => {
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    const session = makeSession();
    emitToolUse(session, CMD, TOOL_USE_ID);
    emitToolResult(session, TOOL_USE_ID, 'Closed pull request #42');

    expect(markSessionInitiatedPRClose).not.toHaveBeenCalled();
  });
});

// ── Integration tests: embedded tool_result inside a 'user' event ────────────
// Regression coverage for the prDetectedLive gate loosening — gh pr close is
// detected here almost always AFTER a PR already exists (prDetectedLive=true),
// so this path must not be suppressed by the PR-creation-only gate.

describe('gh pr close/reopen live detection via handleRawEvent (embedded user event)', () => {
  const TOOL_USE_ID = 'toolu_bash_close_embedded_001';
  const CMD = 'gh pr close 42';

  beforeEach(() => {
    vi.mocked(getPRBySessionId).mockReturnValue(OWN_PR as never);
    vi.mocked(markSessionInitiatedPRClose).mockClear();
  });

  it('sets the mark even when prDetectedLive is already true', () => {
    const session = makeSession();
    // Force prDetectedLive = true, simulating a PR already created this session.
    (session as unknown as { prDetectedLive: boolean }).prDetectedLive = true;

    sendEvent(session, {
      type: 'assistant',
      message: {
        id: 'msg_002',
        content: [
          {
            type: 'tool_use',
            id: TOOL_USE_ID,
            name: 'Bash',
            input: { command: CMD },
          },
        ],
      },
    });
    sendEvent(session, {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: TOOL_USE_ID,
            content: 'Closed pull request #42',
          },
        ],
      },
    });

    expect(markSessionInitiatedPRClose).toHaveBeenCalledWith(42, 'owner/repo');
  });
});
