/**
 * Tests for SessionManager.enqueueFeedback(): the shared routing point used by
 * OrphanedTaskSweeper (nudges) and ReviewOrchestrator (needs_changes/incomplete
 * verdicts, local-branch CI-gate failures) so both bypass session.send() entirely.
 *
 * - Live, mid-turn session (hasActiveTurn() === true): item is enqueued only —
 *   delivery happens at the next turn boundary via
 *   AgentSession.deliverInboxItems(), so sendOrResume must NOT be called here
 *   (that would interleave into an in-flight turn / risk a mid-teardown write).
 * - Live, idle session (in-map but hasActiveTurn() === false): a turn boundary
 *   will never arrive on its own, so the item is delivered immediately via
 *   sendOrResume (a direct send() for a live session) and marked delivered.
 * - Idle/exited session (not in-map): item is enqueued, then delivered
 *   immediately via a clean respawn (sendOrResume) and marked delivered.
 * - Terminal session (done/error/killed): a resume is attempted (bypassing
 *   the normal terminal refusal, via sendOrResume({allowTerminal: true})) so
 *   a pushback/verification-error to an ended session is not silently
 *   record-only. Only when that resume attempt itself yields nothing is the
 *   item marked delivered-without-resend — and even then a needs-attention
 *   signal (pause reason + session_action_failed) is surfaced instead of a
 *   silent drop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue(''),
    exec: vi.fn(),
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue(''),
      mkdirSync: vi.fn(),
      statSync: vi.fn().mockReturnValue({ isFile: () => false }),
    },
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    mkdirSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ isFile: () => false }),
  };
});

vi.mock('../config', () => ({
  config: {},
  runtimeSettings: { session_mode: 'cli', max_concurrent_code_sessions: 10 },
  getProjectById: vi.fn().mockReturnValue(null),
  normalizePath: (p: string) => p,
}));

const inboxItemsBySession = new Map<
  string,
  Array<{ id: number; source: string; payload: string }>
>();
let nextInboxId = 1;

function seedInbox(
  sessionId: string,
  items: Array<{ id: number; source: string; payload: string }>,
) {
  inboxItemsBySession.set(sessionId, items);
}

vi.mock('../db/queries', () => ({
  TERMINAL_SESSION_STATUSES: new Set(['done', 'error', 'killed']),
  getGrantedCapabilities: vi.fn(() => []),
  insertSession: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateSessionWorktreePath: vi.fn(),
  markSessionDone: vi.fn(),
  markSessionSuperseded: vi.fn(),
  insertEvent: vi.fn(),
  getSession: vi.fn(),
  getSessionsByStatus: vi.fn().mockReturnValue([]),
  getPRByNotionTaskId: vi.fn().mockReturnValue(null),
  getEventsBySession: vi.fn().mockReturnValue([]),
  getPRByNumber: vi.fn().mockReturnValue(null),
  getPRBySessionId: vi.fn().mockReturnValue(null),
  getStuckResultSessionRows: vi.fn().mockReturnValue([]),
  getRunningSessionsWithMergedOrClosedPR: vi.fn().mockReturnValue([]),
  hasActiveSessionForTask: vi.fn().mockReturnValue(false),
  getOtherRunningSessionsForTask: vi.fn().mockReturnValue([]),
  setSessionPauseReason: vi.fn(),
  setSessionLastErrorDetail: vi.fn(),
  incrementTaskCrashCount: vi.fn().mockReturnValue(1),
  setTaskPauseReason: vi.fn(),
  getTerminalSessionsForTask: vi.fn().mockReturnValue([]),
  listSessionsWithUndeliveredInboxItems: vi.fn(() => [
    ...inboxItemsBySession.keys(),
  ]),
  listUndeliveredInboxItems: vi.fn((sessionId: string) =>
    (inboxItemsBySession.get(sessionId) ?? []).map((i) => ({
      ...i,
      session_id: sessionId,
      enqueued_at: 0,
      delivered_at: null,
    })),
  ),
  markInboxItemsDelivered: vi.fn((ids: number[]) => {
    for (const [sessionId, items] of inboxItemsBySession.entries()) {
      inboxItemsBySession.set(
        sessionId,
        items.filter((i) => !ids.includes(i.id)),
      );
    }
  }),
  enqueueFeedbackItem: vi.fn(
    (sessionId: string, source: string, payload: string) => {
      const items = inboxItemsBySession.get(sessionId) ?? [];
      items.push({ id: nextInboxId++, source, payload });
      inboxItemsBySession.set(sessionId, items);
    },
  ),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue('task content'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../session/orchestrator-config', () => ({
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    mainBranch: 'main',
    bootstrapScript: null,
    prGate: null,
    bashRules: null,
    allowedTools: [],
    mcp_servers: undefined,
  }),
}));

vi.mock('../session/ContextBuilder', () => ({
  buildSessionContext: vi.fn().mockReturnValue('context'),
}));

vi.mock('../session/orchestrator-claudemd', () => ({
  buildReviewClaudeMd: vi.fn().mockReturnValue('review context'),
}));

vi.mock('../session/branchModel', () => ({
  resolveStartingPoint: vi.fn().mockReturnValue({
    startingPoint: 'dev',
    milestoneSlug: null,
  }),
  ensureMilestoneBranch: vi.fn(),
  slugify: vi
    .fn()
    .mockImplementation((s: string) => s.toLowerCase().replace(/\s+/g, '-')),
  deriveBranchSlug: vi
    .fn()
    .mockImplementation(
      (s: string) => `feature/${s.toLowerCase().replace(/\s+/g, '-')}`,
    ),
}));

vi.mock('../routes/tasks', () => ({
  emitTaskUpdated: vi.fn(),
}));

vi.mock('../notion/NotionClient', () => ({
  parseSection: vi.fn().mockReturnValue(''),
}));

vi.mock('../tasks/TaskStatusEngine', () => ({
  deriveDisplayStatusFromDb: vi.fn().mockReturnValue('starting'),
}));

vi.mock('../session/CliSessionRunner', () => ({
  CliSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
    run: vi.fn().mockReturnValue(new Promise(() => {})),
  })),
}));

vi.mock('../session/ApiSessionRunner', () => ({
  ApiSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
}));

vi.mock('../session/DockerSessionRunner', () => ({
  DockerSessionRunner: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn(),
    endSession: vi.fn(),
  })),
  reapOrphanContainers: vi.fn(),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config/corporateMode', () => ({
  getCorporateMode: vi
    .fn()
    .mockReturnValue({ gates: { dockerMandatory: false } }),
}));

import { SessionManager } from '../session/SessionManager';
import * as queries from '../db/queries';

beforeEach(() => {
  vi.clearAllMocks();
  inboxItemsBySession.clear();
  nextInboxId = 1;
});

describe('SessionManager.enqueueFeedback()', () => {
  it('live, mid-turn session: enqueues only — no sendOrResume (turn boundary delivers it)', async () => {
    const sm = new SessionManager();
    // Simulate a live in-memory session mid-turn, without going through the full spawn path.
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
      'sess-live',
      { hasActiveTurn: () => true },
    );
    const sendSpy = vi.spyOn(sm, 'sendOrResume');

    await sm.enqueueFeedback('sess-live', 'system:nudge', 'please open a PR');

    expect(queries.enqueueFeedbackItem).toHaveBeenCalledWith(
      'sess-live',
      'system:nudge',
      'please open a PR',
    );
    expect(sendSpy).not.toHaveBeenCalled();
    expect(queries.listUndeliveredInboxItems('sess-live')).toHaveLength(1);
  });

  it('live, idle session: enqueues and delivers exactly once, marking items delivered', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-live-idle',
      status: 'running',
    } as never);

    const sm = new SessionManager();
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
      'sess-live-idle',
      { hasActiveTurn: () => false },
    );
    const sendSpy = vi
      .spyOn(sm, 'sendOrResume')
      .mockResolvedValue('sess-live-idle');

    await sm.enqueueFeedback(
      'sess-live-idle',
      'ai-reviewer',
      'needs_changes feedback',
    );

    expect(queries.enqueueFeedbackItem).toHaveBeenCalledWith(
      'sess-live-idle',
      'ai-reviewer',
      'needs_changes feedback',
    );
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      'sess-live-idle',
      expect.stringContaining('needs_changes feedback'),
    );
    expect(queries.markInboxItemsDelivered).toHaveBeenCalledTimes(1);
    expect(queries.listUndeliveredInboxItems('sess-live-idle')).toHaveLength(0);
  });

  it('idle session: enqueues and immediately delivers via a clean respawn', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-idle',
      status: 'idle',
    } as never);

    const sm = new SessionManager();
    vi.spyOn(sm, 'sendOrResume').mockResolvedValue('sess-idle');

    await sm.enqueueFeedback('sess-idle', 'ci-failure', 'verify failed');

    expect(queries.enqueueFeedbackItem).toHaveBeenCalledWith(
      'sess-idle',
      'ci-failure',
      'verify failed',
    );
    expect(sm.sendOrResume).toHaveBeenCalledWith(
      'sess-idle',
      expect.stringContaining('verify failed'),
    );
    expect(queries.markInboxItemsDelivered).toHaveBeenCalled();
    expect(queries.listUndeliveredInboxItems('sess-idle')).toHaveLength(0);
  });

  it('idle session: leaves item undelivered for retry when sendOrResume throws', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-idle-2',
      status: 'idle',
    } as never);

    const sm = new SessionManager();
    vi.spyOn(sm, 'sendOrResume').mockRejectedValue(new Error('respawn failed'));

    await sm.enqueueFeedback('sess-idle-2', 'system:nudge', 'nudge text');

    expect(queries.markInboxItemsDelivered).not.toHaveBeenCalled();
    expect(queries.listUndeliveredInboxItems('sess-idle-2')).toHaveLength(1);
  });

  it('terminal, resumable session: attempts a resume (bypassing the terminal refusal) and delivers on success', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-done',
      status: 'done',
    } as never);

    const sm = new SessionManager();
    const sendSpy = vi.spyOn(sm, 'sendOrResume').mockResolvedValue('sess-done');

    await sm.enqueueFeedback('sess-done', 'ci-failure', 'stale failure');

    expect(queries.enqueueFeedbackItem).toHaveBeenCalledWith(
      'sess-done',
      'ci-failure',
      'stale failure',
    );
    expect(sendSpy).toHaveBeenCalledWith(
      'sess-done',
      expect.stringContaining('stale failure'),
      { allowTerminal: true },
    );
    expect(queries.markInboxItemsDelivered).toHaveBeenCalled();
    expect(queries.listUndeliveredInboxItems('sess-done')).toHaveLength(0);
    expect(queries.setSessionPauseReason).not.toHaveBeenCalled();
  });

  it('terminal, unresumable session: surfaces needs-attention instead of silently dropping the feedback', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-dead',
      status: 'error',
    } as never);

    const sm = new SessionManager();
    const emitSpy = vi.spyOn(sm, 'emit');
    vi.spyOn(sm, 'sendOrResume').mockResolvedValue(null);

    await sm.enqueueFeedback(
      'sess-dead',
      'operator-disposition',
      'pushback reason',
    );

    expect(queries.setSessionPauseReason).toHaveBeenCalledWith(
      'sess-dead',
      'feedback_undelivered_terminal',
    );
    expect(emitSpy).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        type: 'session_action_failed',
        sessionId: 'sess-dead',
        reason: 'terminal_session_unresumable',
      }),
    );
    // Marked delivered even though unresumable — recorded, and surfaced, never silently retried forever.
    expect(queries.markInboxItemsDelivered).toHaveBeenCalled();
    expect(queries.listUndeliveredInboxItems('sess-dead')).toHaveLength(0);
  });

  it('terminal session: a resume attempt that throws also surfaces needs-attention rather than crashing', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-killed',
      status: 'killed',
    } as never);

    const sm = new SessionManager();
    vi.spyOn(sm, 'sendOrResume').mockRejectedValue(new Error('worktree gone'));

    await sm.enqueueFeedback('sess-killed', 'ci-failure', 'stale failure');

    expect(queries.setSessionPauseReason).toHaveBeenCalledWith(
      'sess-killed',
      'feedback_undelivered_terminal',
    );
    expect(queries.markInboxItemsDelivered).toHaveBeenCalled();
  });

  it('unknown session: enqueues only, no crash', async () => {
    vi.mocked(queries.getSession).mockReturnValue(undefined as never);
    const sm = new SessionManager();
    const sendSpy = vi.spyOn(sm, 'sendOrResume');

    await sm.enqueueFeedback('sess-missing', 'system:nudge', 'text');

    expect(queries.enqueueFeedbackItem).toHaveBeenCalledWith(
      'sess-missing',
      'system:nudge',
      'text',
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('idle session: combines multiple pending inbox items into a single sendOrResume call', async () => {
    seedInbox('sess-multi', [
      { id: 1, source: 'ai-reviewer', payload: 'first item' },
    ]);
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-multi',
      status: 'idle',
    } as never);

    const sm = new SessionManager();
    vi.spyOn(sm, 'sendOrResume').mockResolvedValue('sess-multi');

    await sm.enqueueFeedback('sess-multi', 'system:nudge', 'second item');

    const [, combined] = vi.mocked(sm.sendOrResume).mock.calls[0];
    expect(combined).toContain('first item');
    expect(combined).toContain('second item');
  });
});
