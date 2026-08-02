/**
 * A clean process exit must broadcast the session's real post-write status,
 * not a hardcoded 'idle' — markSessionIdle's terminal guard silently skips
 * the write when the row is already done/error/killed, so the caller must
 * ask it what actually landed and broadcast that instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ────────────────────────────────────────────────────────────

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
  execFile: vi.fn((...args: unknown[]) => {
    (args[args.length - 1] as (err: unknown, out: unknown) => void)(null, {
      stdout: '',
      stderr: '',
    });
  }),
  exec: vi.fn((...args: unknown[]) => {
    (args[args.length - 1] as (err: unknown, out: unknown) => void)(null, {
      stdout: '',
      stderr: '',
    });
  }),
}));

import { mockDbQueries } from '../../__tests__/helpers/mockDbQueries';

vi.mock('../../db/queries', () =>
  mockDbQueries({
    upsertSessionEvent: vi.fn().mockReturnValue(1),
    updateSessionStatus: vi.fn(),
    markSessionDone: vi.fn(),
    markSessionIdle: vi.fn().mockReturnValue('idle'),
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
    resetTaskCrashCount: vi.fn(),
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

vi.mock('../../orchestration/planningDecisionKinds', () => ({
  groomSessionConcludedWithDecision: vi.fn().mockReturnValue(false),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { AgentSession } from '../AgentSession';
import { markSessionIdle } from '../../db/queries';
import { recoverSession } from '../sessionRecovery';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(sessionType = 'standard'): AgentSession {
  const taskBackend = {
    attachPR: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
  };
  return new AgentSession(
    'test-clean-exit',
    'https://notion.so/task',
    'https://notion.so/project',
    taskBackend as never,
    '/fake/worktree',
    'task-123',
    undefined,
    undefined,
    sessionType,
  );
}

async function callHandleCleanExit(session: AgentSession): Promise<void> {
  await (
    session as unknown as { handleCleanExit(): Promise<void> }
  ).handleCleanExit();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AgentSession.handleCleanExit — broadcasts the real post-write status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('planning session (non-PR clean-exit path)', () => {
    for (const terminalStatus of ['done', 'error', 'killed'] as const) {
      it(`broadcasts '${terminalStatus}' when markSessionIdle reports the row is already ${terminalStatus}`, async () => {
        vi.mocked(markSessionIdle).mockReturnValue(terminalStatus);

        const session = makeSession('groom');
        const messages: unknown[] = [];
        session.on('message', (m: unknown) => messages.push(m));

        await callHandleCleanExit(session);

        const ended = messages.find(
          (m: any) => m.type === 'session_ended',
        ) as any;
        expect(ended).toBeDefined();
        expect(ended.status).toBe(terminalStatus);
      });
    }

    it("still broadcasts 'idle' unchanged when the row is non-terminal", async () => {
      vi.mocked(markSessionIdle).mockReturnValue('idle');

      const session = makeSession('groom');
      const messages: unknown[] = [];
      session.on('message', (m: unknown) => messages.push(m));

      await callHandleCleanExit(session);

      const ended = messages.find(
        (m: any) => m.type === 'session_ended',
      ) as any;
      expect(ended).toBeDefined();
      expect(ended.status).toBe('idle');
    });
  });

  describe('code session (PR-carrying clean-exit path)', () => {
    it('passes the effective terminal status through to recoverSession instead of assuming idle landed', async () => {
      vi.mocked(markSessionIdle).mockReturnValue('error');

      const session = makeSession('standard');
      await callHandleCleanExit(session);

      expect(recoverSession).toHaveBeenCalledWith(
        'test-clean-exit',
        expect.objectContaining({
          scope: 'clean_exit',
          effectiveStatus: 'error',
        }),
      );
    });

    it('passes idle through unchanged for a non-terminal row', async () => {
      vi.mocked(markSessionIdle).mockReturnValue('idle');

      const session = makeSession('standard');
      await callHandleCleanExit(session);

      expect(recoverSession).toHaveBeenCalledWith(
        'test-clean-exit',
        expect.objectContaining({
          scope: 'clean_exit',
          effectiveStatus: 'idle',
        }),
      );
    });
  });
});
