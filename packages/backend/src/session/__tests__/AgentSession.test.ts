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
import {
  markSessionIdle,
  listUndeliveredInboxItems,
  markInboxItemsDelivered,
  getEventsBySession,
} from '../../db/queries';
import { db } from '../../db/db';
import { recoverSession } from '../sessionRecovery';
import type { SessionEvent } from '../../db/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(
  sessionType = 'standard',
  sessionManager?: { sendOrResume: ReturnType<typeof vi.fn> },
): AgentSession {
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
    sessionManager as never,
  );
}

async function callDeliverInboxItems(session: AgentSession): Promise<void> {
  await (
    session as unknown as { deliverInboxItems(): Promise<void> }
  ).deliverInboxItems();
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

  describe('fallback PR-URL scan (no PR detected live)', () => {
    function makeEvent(
      overrides: Partial<SessionEvent> &
        Pick<SessionEvent, 'event_type' | 'payload'>,
    ): SessionEvent {
      return {
        id: 1,
        session_id: 'test-clean-exit',
        timestamp: Date.now(),
        message_id: null,
        ...overrides,
      };
    }

    function toolResultEvent(url: string): SessionEvent {
      return makeEvent({
        event_type: 'system',
        payload: JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', content: `pr_url: ${url}` }],
          },
        }),
      });
    }

    function assistantTextEvent(text: string): SessionEvent {
      return makeEvent({
        event_type: 'text',
        payload: JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text }] },
        }),
      });
    }

    beforeEach(() => {
      db.prepare('DELETE FROM projects').run();
    });

    it('discards a fixture URL scraped from a tool-result event for an unconfigured repo', async () => {
      vi.mocked(markSessionIdle).mockReturnValue('idle');
      vi.mocked(getEventsBySession).mockReturnValue([
        toolResultEvent('https://github.com/owner/repo/pull/42'),
      ]);

      const session = makeSession('standard');
      await callHandleCleanExit(session);

      expect(markSessionIdle).toHaveBeenCalledWith(
        'test-clean-exit',
        expect.any(Number),
        null,
      );
      expect(recoverSession).toHaveBeenCalledWith(
        'test-clean-exit',
        expect.objectContaining({ prUrl: undefined }),
      );
    });

    it('still picks up a genuine PR URL for a configured repo emitted in assistant text', async () => {
      db.prepare(
        `INSERT INTO projects (id, name, project_dir, github_repo, task_source, created_at, updated_at)
         VALUES (?, ?, '/test', ?, 'notion', 1000, 1000)`,
      ).run('proj-real', 'Project real', 'myorg/myrepo');

      vi.mocked(markSessionIdle).mockReturnValue('idle');
      vi.mocked(getEventsBySession).mockReturnValue([
        assistantTextEvent(
          'Draft PR opened: https://github.com/myorg/myrepo/pull/100',
        ),
      ]);

      const session = makeSession('standard');
      await callHandleCleanExit(session);

      const expectedUrl = 'https://github.com/myorg/myrepo/pull/100';
      expect(markSessionIdle).toHaveBeenCalledWith(
        'test-clean-exit',
        expect.any(Number),
        expectedUrl,
      );
      expect(recoverSession).toHaveBeenCalledWith(
        'test-clean-exit',
        expect.objectContaining({ prUrl: expectedUrl }),
      );
    });
  });
});

describe('AgentSession.sendMessage — _turnInFlight only set on confirmed delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function getRunnerMock(session: AgentSession) {
    return (
      session as unknown as {
        runner: { sendMessage: ReturnType<typeof vi.fn> };
      }
    ).runner;
  }

  it('returns true and marks a turn active when the runner confirms delivery', () => {
    const session = makeSession('standard');
    getRunnerMock(session).sendMessage.mockReturnValue(true);
    // Start from a settled state — a freshly constructed session starts with
    // _turnInFlight true (it's about to begin its first turn), which would
    // mask whether sendMessage itself is what set it.
    (session as unknown as { _turnInFlight: boolean })._turnInFlight = false;

    const delivered = session.sendMessage('hello');

    expect(delivered).toBe(true);
    expect(session.hasActiveTurn()).toBe(true);
  });

  it('returns false and does not leave hasActiveTurn() stuck true when the runner reports a failed write', () => {
    const session = makeSession('standard');
    getRunnerMock(session).sendMessage.mockReturnValue(false);
    (session as unknown as { _turnInFlight: boolean })._turnInFlight = false;

    const delivered = session.sendMessage('hello');

    expect(delivered).toBe(false);
    expect(session.hasActiveTurn()).toBe(false);
  });
});

describe('AgentSession.deliverInboxItems — only marks delivered on a confirmed sendOrResume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const pendingItems = [
    { id: 1, source: 'feedback', payload: 'do the thing' },
    { id: 2, source: 'feedback', payload: 'do the other thing' },
  ];

  it('does not mark items delivered when sendOrResume resolves null', async () => {
    vi.mocked(listUndeliveredInboxItems).mockReturnValue(pendingItems as never);
    const sendOrResume = vi.fn().mockResolvedValue(null);
    const session = makeSession('standard', { sendOrResume });

    await callDeliverInboxItems(session);

    expect(sendOrResume).toHaveBeenCalled();
    expect(markInboxItemsDelivered).not.toHaveBeenCalled();
  });

  it('marks exactly the delivered items when sendOrResume resolves a truthy sessionId', async () => {
    vi.mocked(listUndeliveredInboxItems).mockReturnValue(pendingItems as never);
    const sendOrResume = vi.fn().mockResolvedValue('test-clean-exit');
    const session = makeSession('standard', { sendOrResume });

    await callDeliverInboxItems(session);

    expect(sendOrResume).toHaveBeenCalled();
    expect(markInboxItemsDelivered).toHaveBeenCalledWith([1, 2]);
  });

  it('does not mark items delivered when sendOrResume throws', async () => {
    vi.mocked(listUndeliveredInboxItems).mockReturnValue(pendingItems as never);
    const sendOrResume = vi.fn().mockRejectedValue(new Error('boom'));
    const session = makeSession('standard', { sendOrResume });

    await callDeliverInboxItems(session);

    expect(sendOrResume).toHaveBeenCalled();
    expect(markInboxItemsDelivered).not.toHaveBeenCalled();
  });
});
