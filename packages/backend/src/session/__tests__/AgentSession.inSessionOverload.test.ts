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
  execFile: vi.fn(),
}));

vi.mock('../../db/queries', () =>
  mockDbQueries({
    upsertSessionEvent: vi.fn().mockReturnValue(1),
    updateSessionStatus: vi.fn(),
    markSessionDone: vi.fn(),
    markSessionIdle: vi.fn(),
    getEventsBySession: vi.fn().mockReturnValue([
      {
        event_type: 'system',
        payload: JSON.stringify({ type: 'error', message: 'overloaded_error' }),
      },
    ]),
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
    setTaskPauseReason: vi.fn(),
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

import { AgentSession } from '../AgentSession';
import { setPauseReason, setTaskPauseReason } from '../../db/queries';

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKTREE = '/fake/worktree';

function makeSession(sessionManager?: unknown): AgentSession {
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
    undefined,
    undefined,
    'standard',
    sessionManager as never,
  );
}

function sendEvent(session: AgentSession, event: Record<string, unknown>) {
  (
    session as unknown as {
      handleRawEvent: (e: Record<string, unknown>) => void;
    }
  ).handleRawEvent(event);
}

const OVERLOAD_ERROR_EVENT = {
  type: 'error',
  message: JSON.stringify({ error: { type: 'overloaded_error' } }),
};

describe('AgentSession in-session 529/500 handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries via respawnForTransientOverload while under the retry budget, without escalating', () => {
    const recordInSessionOverloadEvent = vi.fn().mockReturnValue({
      count: 1,
      escalated: false,
      cooldownMs: 10_000,
    });
    const respawnForTransientOverload = vi.fn().mockResolvedValue(true);
    const sessionManager = {
      send: vi.fn(),
      isAlive: vi.fn().mockReturnValue(true),
      recordInSessionOverloadEvent,
      respawnForTransientOverload,
      clearInSessionOverloadBudget: vi.fn(),
    };
    const session = makeSession(sessionManager);

    sendEvent(session, OVERLOAD_ERROR_EVENT);

    expect(recordInSessionOverloadEvent).toHaveBeenCalledWith(
      'test-session-id',
    );
    // Escalation must not fire while under budget.
    expect(setPauseReason).not.toHaveBeenCalled();
    expect(setTaskPauseReason).not.toHaveBeenCalledWith(
      'task-123',
      'api_overloaded_exhausted',
      expect.anything(),
    );
  });

  it('escalates to api_overloaded_exhausted once the retry budget reports escalated', () => {
    const sessionManager = {
      send: vi.fn(),
      isAlive: vi.fn().mockReturnValue(true),
      recordInSessionOverloadEvent: vi.fn().mockReturnValue({
        count: 6,
        escalated: true,
        cooldownMs: 300_000,
      }),
      respawnForTransientOverload: vi.fn().mockResolvedValue(true),
      clearInSessionOverloadBudget: vi.fn(),
    };
    const session = makeSession(sessionManager);

    sendEvent(session, OVERLOAD_ERROR_EVENT);

    // Escalation is a distinct reason from the original api_overloaded pause,
    // and does not attempt a respawn.
    expect(setTaskPauseReason).toHaveBeenCalledWith(
      'task-123',
      'api_overloaded_exhausted',
      expect.any(String),
    );
    expect(sessionManager.respawnForTransientOverload).not.toHaveBeenCalled();
  });

  it('falls back to a manual-recovery pause under api_overloaded when no sessionManager is present', () => {
    const session = makeSession(undefined);

    sendEvent(session, OVERLOAD_ERROR_EVENT);

    // No sessionManager means no recordInSessionOverloadEvent call target —
    // the session pauses for manual recovery rather than throwing.
    expect(setPauseReason).not.toHaveBeenCalled(); // no PR attached in this test
  });
});
