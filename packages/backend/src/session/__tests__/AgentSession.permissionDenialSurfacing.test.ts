/**
 * The read-envelope tightening (getSessionAddDirs, replacing the blanket
 * `--add-dir /` lift for planning sessions) relies on AgentSession's
 * existing permission_denials extraction/broadcast as its diagnostic
 * signal: a Bash/Read/Grep call denied for reaching outside a session's
 * baseline+grants must surface through the same channel the Bash/MCP
 * grant-escalation loop already depends on (insertPermissionDenial +
 * a broadcast 'permission_denials' message), so an operator can see the
 * denial and grant a `read:path:` capability on re-dispatch if warranted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

// ── Module mocks ──────────────────────────────────────────────────────────────

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
    setSessionModelSettingKey: vi.fn(),
    setSessionEffortSettingKey: vi.fn(),
    setSessionMetadata: vi.fn(),
    getPRBySessionId: vi.fn().mockReturnValue(null),
    setHeadSha: vi.fn(),
    setPauseReason: vi.fn(),
    insertPauseInterval: vi.fn(),
    setSessionPauseReason: vi.fn(),
    getSessionTags: vi.fn().mockReturnValue([]),
    setSessionTags: vi.fn(),
    resetTaskCrashCount: vi.fn(),
  }),
);

vi.mock('../../config', () => ({
  ALLOWED_TOOLS: [],
  BASH_MAX_OUTPUT_LENGTH: 30000,
  BASH_DEFAULT_TIMEOUT_MS: 300000,
  GITHUB_REPO: 'owner/repo',
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

vi.mock('../CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockReturnValue(new Promise(() => {})),
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { AgentSession } from '../AgentSession';
import { insertPermissionDenial } from '../../db/queries';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(sessionType = 'ops'): AgentSession {
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
  return new AgentSession(
    'test-session-id',
    'https://notion.so/task',
    'https://notion.so/project',
    taskBackend as never,
    '/tmp/project-checkout',
    'task-123',
    undefined,
    undefined,
    sessionType,
  );
}

function sendEvent(session: AgentSession, event: Record<string, unknown>) {
  (
    session as unknown as {
      handleRawEvent: (e: Record<string, unknown>) => void;
    }
  ).handleRawEvent(event);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AgentSession — denied out-of-envelope filesystem read surfaces via permission_denials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists and broadcasts a Read denial outside the ops session baseline+grants', () => {
    const session = makeSession('ops');
    const messages: unknown[] = [];
    session.on('message', (m) => messages.push(m));

    sendEvent(session, {
      type: 'result',
      stop_reason: 'tool_use',
      is_error: false,
      permission_denials: [
        {
          tool_name: 'Read',
          tool_use_id: 'toolu_01',
          tool_input: { file_path: '/other-project/.env' },
        },
      ],
    });

    expect(insertPermissionDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'test-session-id',
        tool_name: 'Read',
        tool_use_id: 'toolu_01',
        tool_input: JSON.stringify({ file_path: '/other-project/.env' }),
      }),
    );

    const denialMsg = messages.find(
      (m: any) => m.type === 'permission_denials',
    ) as any;
    expect(denialMsg).toBeDefined();
    expect(denialMsg.sessionId).toBe('test-session-id');
    expect(denialMsg.denials).toEqual([
      {
        tool_name: 'Read',
        tool_use_id: 'toolu_01',
        tool_input: { file_path: '/other-project/.env' },
      },
    ]);
  });

  it('does nothing when the result event carries no permission_denials', () => {
    const session = makeSession('ops');
    const messages: unknown[] = [];
    session.on('message', (m) => messages.push(m));

    sendEvent(session, {
      type: 'result',
      stop_reason: 'end_turn',
      is_error: false,
    });

    expect(insertPermissionDenial).not.toHaveBeenCalled();
    expect(
      messages.find((m: any) => m.type === 'permission_denials'),
    ).toBeUndefined();
  });
});
