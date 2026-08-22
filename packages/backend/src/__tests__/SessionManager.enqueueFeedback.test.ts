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

vi.mock('../orchestration/memoryAdmission', () => ({
  // respawnSession's memory-admission gate — real os.freemem() is
  // unreliable/low in CI/sandboxed hosts, so tests always see headroom
  // unless a test explicitly overrides this mock.
  hasMemoryHeadroom: vi.fn().mockReturnValue({
    allowed: true,
    freeMemMB: 8192,
    minHostFreeMemoryMB: 4096,
    perSessionReserveMB: 3072,
    projectedFreeMB: 5120,
  }),
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
  addGrantedCapability: vi.fn(() => []),
  removeGrantedCapability: vi.fn(() => []),
  expireStagedIntentsForSession: vi.fn(() => 0),
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
  insertCompletingSignal: vi.fn(),
  listCompletingSignalsForSession: vi.fn().mockReturnValue([
    {
      id: 1,
      session_id: 'unused',
      task_id: null,
      session_type: 'standard',
      signal_class: 'resume_exhausted',
      signal_value: 'resume_failed',
      recorded_at: 1,
    },
  ]),
  setSessionTerminalCompletionReason: vi.fn(),
  incrementSessionPokeRetryCount: vi.fn().mockReturnValue(1),
  resetSessionPokeRetryCount: vi.fn(),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn().mockReturnValue({
    fetchTaskPage: vi.fn().mockResolvedValue('task content'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../session/orchestrator-config', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: vi.fn().mockReturnValue({
    mainBranch: 'main',
    bootstrapScript: null,
    prGate: null,
    bashRules: null,
    allowedTools: [],
    mcp_servers: undefined,
  }),
  isGrantable: vi.fn().mockReturnValue(true),
  isToolShapedCapability: vi.fn().mockReturnValue(true),
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
  resolveResumeBranchSlug: vi
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

import { EventEmitter } from 'events';
import { SessionManager } from '../session/SessionManager';
import * as queries from '../db/queries';
import * as configModule from '../config';
import { recordEvent } from '../audit/AuditLog';
import fs from 'fs';
import type { AgentSession } from '../session/AgentSession';

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

  it('idle session: leaves item undelivered for retry when sendOrResume throws, and records verdict_routing_failed', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-idle-2',
      status: 'idle',
      task_id: 'notion:task-2',
      project_id: 'proj-2',
    } as never);

    const sm = new SessionManager();
    vi.spyOn(sm, 'sendOrResume').mockRejectedValue(new Error('respawn failed'));

    await sm.enqueueFeedback('sess-idle-2', 'system:nudge', 'nudge text');

    expect(queries.markInboxItemsDelivered).not.toHaveBeenCalled();
    expect(queries.listUndeliveredInboxItems('sess-idle-2')).toHaveLength(1);
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'verdict_routing_failed',
        actor_id: 'sess-idle-2',
        project_id: 'proj-2',
        task_id: 'notion:task-2',
      }),
    );
  });

  it('idle session: leaves item undelivered and records verdict_routing_failed when sendOrResume returns null', async () => {
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: 'sess-idle-3',
      status: 'idle',
      task_id: null,
      project_id: null,
    } as never);

    const sm = new SessionManager();
    vi.spyOn(sm, 'sendOrResume').mockResolvedValue(null);

    await sm.enqueueFeedback('sess-idle-3', 'system:nudge', 'nudge text');

    expect(queries.markInboxItemsDelivered).not.toHaveBeenCalled();
    expect(queries.listUndeliveredInboxItems('sess-idle-3')).toHaveLength(1);
    expect(vi.mocked(recordEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'verdict_routing_failed',
        actor_id: 'sess-idle-3',
      }),
    );
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

  describe('session_feedback_pending', () => {
    it('idle (parked) session: emits pending=true before sendOrResume resolves, then pending=false once delivered', async () => {
      vi.mocked(queries.getSession).mockReturnValue({
        session_id: 'sess-parked',
        status: 'idle',
      } as never);

      const sm = new SessionManager();
      const emitSpy = vi.spyOn(sm, 'emit');
      let resolveResume!: (v: string) => void;
      vi.spyOn(sm, 'sendOrResume').mockReturnValue(
        new Promise((resolve) => {
          resolveResume = resolve;
        }),
      );

      const done = sm.enqueueFeedback(
        'sess-parked',
        'operator-disposition',
        'capability granted',
      );

      // pending=true must be emitted before sendOrResume resolves.
      expect(emitSpy).toHaveBeenCalledWith(
        'message',
        expect.objectContaining({
          type: 'session_feedback_pending',
          sessionId: 'sess-parked',
          pending: true,
        }),
      );
      expect(queries.markInboxItemsDelivered).not.toHaveBeenCalled();

      resolveResume('sess-parked');
      await done;

      expect(emitSpy).toHaveBeenCalledWith(
        'message',
        expect.objectContaining({
          type: 'session_feedback_pending',
          sessionId: 'sess-parked',
          pending: false,
        }),
      );
      expect(queries.markInboxItemsDelivered).toHaveBeenCalled();
    });

    it('live, idle session (direct send() path): does not leave a pending state visible after delivery', async () => {
      vi.mocked(queries.getSession).mockReturnValue({
        session_id: 'sess-live-idle-2',
        status: 'running',
      } as never);

      const sm = new SessionManager();
      (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
        'sess-live-idle-2',
        { hasActiveTurn: () => false },
      );
      const emitSpy = vi.spyOn(sm, 'emit');
      vi.spyOn(sm, 'sendOrResume').mockResolvedValue('sess-live-idle-2');

      await sm.enqueueFeedback(
        'sess-live-idle-2',
        'ai-reviewer',
        'needs_changes feedback',
      );

      const pendingCalls = emitSpy.mock.calls.filter(
        ([, msg]) =>
          (msg as { type?: string }).type === 'session_feedback_pending',
      );
      expect(pendingCalls.length).toBeGreaterThan(0);
      // The last emitted pending state must be cleared (false), not left as true.
      const lastPending = pendingCalls[pendingCalls.length - 1][1] as {
        pending: boolean;
      };
      expect(lastPending.pending).toBe(false);
    });

    it('is distinguishable from session_action_failed on message shape', async () => {
      vi.mocked(queries.getSession).mockReturnValue({
        session_id: 'sess-dead-2',
        status: 'error',
      } as never);

      const sm = new SessionManager();
      const emitSpy = vi.spyOn(sm, 'emit');
      vi.spyOn(sm, 'sendOrResume').mockResolvedValue(null);

      await sm.enqueueFeedback(
        'sess-dead-2',
        'operator-disposition',
        'pushback reason',
      );

      const pendingMsg = emitSpy.mock.calls
        .map(([, msg]) => msg as Record<string, unknown>)
        .find((msg) => msg.type === 'session_feedback_pending');
      const failedMsg = emitSpy.mock.calls
        .map(([, msg]) => msg as Record<string, unknown>)
        .find((msg) => msg.type === 'session_action_failed');

      expect(pendingMsg).toBeDefined();
      expect(failedMsg).toBeDefined();
      // Distinct message shapes: the pending state never carries a
      // failure/reason field, and is never rendered by the same path.
      expect(pendingMsg).not.toHaveProperty('reason');
      expect(pendingMsg).not.toHaveProperty('action');
      expect(pendingMsg).not.toHaveProperty('detail');
    });

    it('sendOrResume that throws clears the pending state without asserting delivery is still in progress', async () => {
      vi.mocked(queries.getSession).mockReturnValue({
        session_id: 'sess-idle-3',
        status: 'idle',
      } as never);

      const sm = new SessionManager();
      const emitSpy = vi.spyOn(sm, 'emit');
      vi.spyOn(sm, 'sendOrResume').mockRejectedValue(
        new Error('respawn failed'),
      );

      await sm.enqueueFeedback('sess-idle-3', 'system:nudge', 'nudge text');

      const pendingCalls = emitSpy.mock.calls.filter(
        ([, msg]) =>
          (msg as { type?: string }).type === 'session_feedback_pending',
      );
      expect(pendingCalls.length).toBe(2);
      expect((pendingCalls[0][1] as { pending: boolean }).pending).toBe(true);
      expect((pendingCalls[1][1] as { pending: boolean }).pending).toBe(false);
      expect(queries.markInboxItemsDelivered).not.toHaveBeenCalled();
      expect(queries.listUndeliveredInboxItems('sess-idle-3')).toHaveLength(1);
    });
  });
});

/**
 * Grant-respawn staged-intent reap suppression: respawnForCapabilityGrant's
 * kill (used by grantCapability/revokeCapability/respawnForTransientOverload
 * to apply a widened/narrowed --allowed-tools to a live session) is not a
 * real death — the same session id comes back with --resume — so it must
 * not reap the session's staged intents the way a genuine kill does.
 */
describe('SessionManager grant-respawn: staged-intent reap suppression', () => {
  function grantRow(overrides: Record<string, unknown> = {}) {
    return {
      session_id: 'sess-grant',
      task_id: 'task-1',
      task_url: 'https://notion.so/task',
      project_context_url: 'https://notion.so/ctx',
      project_id: 'proj-1',
      status: 'running',
      session_type: 'standard',
      worktree_path: '/tmp/proj/.claude/worktrees/sess-grant',
      pr_url: null,
      task_name: 'Test task',
      ...overrides,
    };
  }

  function fakeSpawnedSession(): AgentSession {
    const emitter = new EventEmitter() as unknown as AgentSession;
    Object.assign(emitter, {
      taskId: 'task-1',
      sessionType: 'standard',
      prUrl: null,
      hasEnded: false,
      run: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    return emitter;
  }

  function withLiveSession(
    sm: SessionManager,
    killSpy: ReturnType<typeof vi.fn>,
  ) {
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
      'sess-grant',
      { kill: killSpy, hasActiveTurn: () => false },
    );
  }

  beforeEach(() => {
    vi.mocked(queries.getSession).mockReturnValue(grantRow() as never);
    vi.mocked(configModule.getProjectById).mockReturnValue({
      id: 'proj-1',
      projectDir: '/tmp/proj',
      taskSource: 'notion',
      baseBranch: 'dev',
      gitMode: 'worktree',
    } as never);
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  it('grant applied to a live session with a staged intent leaves it in its prior state — no superseded/session_killed transition', async () => {
    const killSpy = vi.fn().mockResolvedValue(undefined);
    const sm = new SessionManager();
    withLiveSession(sm, killSpy);
    vi.spyOn(sm as never, 'respawnSession').mockReturnValue(
      fakeSpawnedSession() as never,
    );

    await sm.grantCapability('sess-grant', 'Bash(find *)');

    expect(killSpy).toHaveBeenCalledWith({ suppressReap: true });
    expect(queries.expireStagedIntentsForSession).not.toHaveBeenCalled();
  });

  it('a sibling session.requestCapability staged by the same session survives the grant of a different capability (regression for live instance 2)', async () => {
    const killSpy = vi.fn().mockResolvedValue(undefined);
    const sm = new SessionManager();
    withLiveSession(sm, killSpy);
    vi.spyOn(sm as never, 'respawnSession').mockReturnValue(
      fakeSpawnedSession() as never,
    );

    await sm.grantCapability('sess-grant', 'Bash(cat *)');

    // The kill that applies this grant must never reap ANY of this
    // session's staged intents, including a sibling capability request
    // awaiting its own operator disposition.
    expect(queries.expireStagedIntentsForSession).not.toHaveBeenCalled();
  });

  it('a grant respawn that fails at the worktree-missing exit never calls kill() and leaves the live session untouched', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const killSpy = vi.fn().mockResolvedValue(undefined);
    const sm = new SessionManager();
    withLiveSession(sm, killSpy);

    await sm.grantCapability('sess-grant', 'Bash(find *)');

    expect(killSpy).not.toHaveBeenCalled();
    expect(queries.expireStagedIntentsForSession).not.toHaveBeenCalled();
    expect(
      (sm as unknown as { sessions: Map<string, unknown> }).sessions.has(
        'sess-grant',
      ),
    ).toBe(true);
  });

  it('a grant respawn that fails at usage-admission-deferred (respawnSession returns null after a reap-suppressed kill) explicitly reaps via expireStagedIntentsForSession', async () => {
    const killSpy = vi.fn().mockResolvedValue(undefined);
    const sm = new SessionManager();
    withLiveSession(sm, killSpy);
    vi.spyOn(sm as never, 'respawnSession').mockReturnValue(null as never);

    await sm.grantCapability('sess-grant', 'Bash(find *)');

    expect(killSpy).toHaveBeenCalledWith({ suppressReap: true });
    expect(queries.expireStagedIntentsForSession).toHaveBeenCalledWith(
      'sess-grant',
      'session_killed',
      expect.any(Number),
    );
  });

  it('a grant respawn where no live in-memory session exists (kill() never called) and the respawn attempt fails at usage-admission-deferred also reaps via the same failure-branch call', async () => {
    const sm = new SessionManager();
    // No entry in sessions map — this.sessions.get returns undefined.
    vi.spyOn(sm as never, 'respawnSession').mockReturnValue(null as never);

    const respawned = await sm.respawnForTransientOverload('sess-grant');

    expect(respawned).toBe(false);
    expect(queries.expireStagedIntentsForSession).toHaveBeenCalledWith(
      'sess-grant',
      'session_killed',
      expect.any(Number),
    );
  });

  it('intents belonging to a different session are untouched by a grant respawn', async () => {
    const killSpy = vi.fn().mockResolvedValue(undefined);
    const sm = new SessionManager();
    withLiveSession(sm, killSpy);
    vi.spyOn(sm as never, 'respawnSession').mockReturnValue(
      fakeSpawnedSession() as never,
    );

    await sm.grantCapability('sess-grant', 'Bash(find *)');

    expect(queries.expireStagedIntentsForSession).not.toHaveBeenCalledWith(
      'other-session',
      expect.anything(),
      expect.anything(),
    );
    expect(queries.expireStagedIntentsForSession).not.toHaveBeenCalled();
  });

  // ── grantCapability's returned respawn-applied outcome ──────────────────
  // The notice the session receives (stagedIntents.ts's resumeCapabilityRequester)
  // must be derived from whether the respawn actually applied the grant, not
  // from the fact that a grant was requested. These assert grantCapability's
  // own return value directly, independent of that call site.
  it('returns respawnApplied: true when the underlying respawn resolves true', async () => {
    vi.mocked(queries.addGrantedCapability).mockReturnValue([
      'Bash(find *)',
    ] as never);
    const killSpy = vi.fn().mockResolvedValue(undefined);
    const sm = new SessionManager();
    withLiveSession(sm, killSpy);
    vi.spyOn(sm as never, 'respawnSession').mockReturnValue(
      fakeSpawnedSession() as never,
    );

    const result = await sm.grantCapability('sess-grant', 'Bash(find *)');

    expect(result.respawnApplied).toBe(true);
    expect(result.granted).toContain('Bash(find *)');
  });

  it('returns respawnApplied: false when respawnForCapabilityGrant returns false at the worktree-missing exit', async () => {
    vi.mocked(queries.addGrantedCapability).mockReturnValue([
      'Bash(find *)',
    ] as never);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const killSpy = vi.fn().mockResolvedValue(undefined);
    const sm = new SessionManager();
    withLiveSession(sm, killSpy);

    const result = await sm.grantCapability('sess-grant', 'Bash(find *)');

    expect(result.respawnApplied).toBe(false);
    expect(result.granted).toContain('Bash(find *)');
  });

  it('returns respawnApplied: false when respawnForCapabilityGrant returns false at the usage-admission-deferred exit', async () => {
    vi.mocked(queries.addGrantedCapability).mockReturnValue([
      'Bash(find *)',
    ] as never);
    const killSpy = vi.fn().mockResolvedValue(undefined);
    const sm = new SessionManager();
    withLiveSession(sm, killSpy);
    vi.spyOn(sm as never, 'respawnSession').mockReturnValue(null as never);

    const result = await sm.grantCapability('sess-grant', 'Bash(find *)');

    expect(result.respawnApplied).toBe(false);
    expect(result.granted).toContain('Bash(find *)');
  });

  it('returns respawnApplied: false without attempting a respawn when the session is not live in the map', async () => {
    vi.mocked(queries.addGrantedCapability).mockReturnValue([
      'Bash(find *)',
    ] as never);
    const sm = new SessionManager();
    // No withLiveSession() call — session is absent from the in-memory map.
    const respawnSpy = vi.spyOn(sm as never, 'respawnSession');

    const result = await sm.grantCapability('sess-grant', 'Bash(find *)');

    expect(result.respawnApplied).toBe(false);
    expect(result.granted).toContain('Bash(find *)');
    expect(respawnSpy).not.toHaveBeenCalled();
  });
});
