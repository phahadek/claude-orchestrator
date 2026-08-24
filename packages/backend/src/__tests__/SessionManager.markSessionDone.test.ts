import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── In-memory DB (real runMigrations schema) ─────────────────────────────────
vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../session/sessionRecovery', () => ({
  recoverSession: vi.fn(async () => {}),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    attachPR: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    fetchTaskPage: vi.fn(async () => ''),
    fetchNonMilestoneTasks: vi.fn(async () => []),
  })),
}));

// Pass through real query functions; only stub DB-adjacent helpers that SSM calls
// for its timer bookkeeping.
vi.mock('../db/queries', async () => {
  const actual =
    await vi.importActual<typeof import('../db/queries')>('../db/queries');
  return {
    ...actual,
    setPauseReason: vi.fn(),
    insertPauseInterval: vi.fn(),
    closePauseInterval: vi.fn(),
    upsertStuckSessionTimer: vi.fn(),
    deleteStuckSessionTimer: vi.fn(),
    getAllStuckSessionTimers: vi.fn(() => []),
  };
});

import { StuckSessionMonitor } from '../orchestration/StuckSessionMonitor';
import type { SessionManager } from '../session/SessionManager';
import {
  markSessionDone,
  markSessionIdle,
  markSessionSuperseded,
  applyPendingDone,
  updateSessionStatus,
  insertStagedIntent,
  getStagedIntent,
  expireStagedIntentsForSession,
  sweepStagedIntentsForTerminalSessions,
  hasUndispositionedStagedIntentsForSession,
} from '../db/queries';
import { queryAuditLogByProject } from '../audit/AuditLog';
import { db } from '../db/db.js';
import {
  buildResumeMessage,
  buildPlanningResumeMessage,
  PLANNING_RESTART_RESUME_MESSAGE,
} from '../session/SessionManager';
import type { Session } from '../db/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockSessionManager(alive = false): SessionManager {
  const sm = new EventEmitter() as unknown as SessionManager;
  (sm as unknown as { send: ReturnType<typeof vi.fn> }).send = vi.fn();
  (sm as unknown as { kill: ReturnType<typeof vi.fn> }).kill = vi
    .fn()
    .mockResolvedValue(undefined);
  (sm as unknown as { isAlive: ReturnType<typeof vi.fn> }).isAlive = vi
    .fn()
    .mockReturnValue(alive);
  return sm;
}

function insertSession(
  sessionId: string,
  status: string,
  taskId = 'task-1',
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
       status, started_at, session_type)
     VALUES (?, ?, 'https://notion.so/task', 'https://notion.so/ctx', ?, ?, 'standard')`,
  ).run(sessionId, taskId, status, Date.now() - 10 * 60 * 1000);
}

function insertResultEvent(sessionId: string): void {
  db.prepare(
    `INSERT INTO session_events (session_id, event_type, payload, timestamp)
     VALUES (?, 'system', '{"type":"result"}', ?)`,
  ).run(sessionId, Date.now() - 6 * 60 * 1000);
}

function getStatus(sessionId: string): string | undefined {
  return (
    db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get(sessionId) as { status: string } | undefined
  )?.status;
}

function getTimestamps(
  sessionId: string,
): { ended_at: number | null; terminalized_at: number | null } | undefined {
  return db
    .prepare(
      'SELECT ended_at, terminalized_at FROM sessions WHERE session_id = ?',
    )
    .get(sessionId) as
    | { ended_at: number | null; terminalized_at: number | null }
    | undefined;
}

function getTerminalCompletionReason(sessionId: string): string | null {
  return (
    db
      .prepare(
        'SELECT terminal_completion_reason FROM sessions WHERE session_id = ?',
      )
      .get(sessionId) as { terminal_completion_reason: string | null }
  ).terminal_completion_reason;
}

function getAuditRows(
  eventType: string,
): Array<{ event_type: string; actor_id: string; payload: string }> {
  return db
    .prepare(
      'SELECT event_type, actor_id, payload FROM audit_log WHERE event_type = ?',
    )
    .all(eventType) as Array<{
    event_type: string;
    actor_id: string;
    payload: string;
  }>;
}

let nextStagedIntentId = 0;

function stageIntent(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): string {
  const id = `intent-${++nextStagedIntentId}`;
  insertStagedIntent({
    id,
    kind: 'task.setStatus',
    payload: '{}',
    payload_hash: 'hash',
    task_id: null,
    project_id: 'test-proj',
    session_id: sessionId,
    group_id: null,
    milestone: null,
    state: 'staged',
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    investigation: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    applied_task_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  } as never);
  return id;
}

beforeEach(() => {
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM staged_intent').run();
  vi.clearAllMocks();
});

// ── In-flight guard in markSessionDone ───────────────────────────────────────

describe('markSessionDone in-flight guard', () => {
  it('defers instead of writing done when status=running, recording session_done_deferred_while_running', () => {
    insertSession('sess-run', 'running', 'task-abc');

    markSessionDone('sess-run', Date.now(), null, 'test_call_site');

    const rows = getAuditRows('session_done_deferred_while_running');
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload) as {
      call_site: string;
      status_before: string;
    };
    expect(payload.call_site).toBe('test_call_site');
    expect(payload.status_before).toBe('running');
    expect(rows[0].actor_id).toBe('sess-run');
    // No immediate write — the transition is deferred, not lost.
    expect(getStatus('sess-run')).toBe('running');
  });

  it('does NOT defer or write audit event when status=idle (legitimate idle→done transition)', () => {
    insertSession('sess-idle', 'idle');

    markSessionDone('sess-idle', Date.now(), null, 'boot_idle_merged_pr');

    expect(getAuditRows('session_done_deferred_while_running')).toHaveLength(0);
    expect(getStatus('sess-idle')).toBe('done');
  });

  it('records call_site=unknown when callSite argument is omitted', () => {
    insertSession('sess-no-site', 'running');

    markSessionDone('sess-no-site', Date.now(), null);

    const rows = getAuditRows('session_done_deferred_while_running');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload)).toMatchObject({ call_site: 'unknown' });
  });

  it('skipInFlightGuard bypasses deferral for callers that already confirmed no live process exists', () => {
    insertSession('sess-confirmed-dead', 'running');

    markSessionDone('sess-confirmed-dead', Date.now(), null, 'boot_sweep', {
      skipInFlightGuard: true,
    });

    expect(getAuditRows('session_done_deferred_while_running')).toHaveLength(0);
    expect(getStatus('sess-confirmed-dead')).toBe('done');
  });

  it('applyPendingDone applies a deferred transition once the turn completes', () => {
    insertSession('sess-deferred', 'running', 'task-abc');
    markSessionDone(
      'sess-deferred',
      Date.now(),
      'https://github.com/o/r/pull/9',
      'test_call_site',
    );
    expect(getStatus('sess-deferred')).toBe('running');

    const applied = applyPendingDone('sess-deferred');

    expect(applied).toBe(true);
    expect(getStatus('sess-deferred')).toBe('done');
    const rows = getAuditRows('session_done_deferred_applied');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      call_site: 'test_call_site',
    });
  });

  it('applyPendingDone is a no-op when nothing is pending', () => {
    insertSession('sess-clean', 'idle');

    expect(applyPendingDone('sess-clean')).toBe(false);
    expect(getStatus('sess-clean')).toBe('idle');
  });

  it("a session_done_deferred_while_running row is visible via a project-scoped auditLog query for that session's project, even though the write site never supplied project_id", () => {
    db.prepare(
      `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
         status, started_at, session_type, project_id)
       VALUES (?, ?, 'https://notion.so/task', 'https://notion.so/ctx', ?, ?, 'standard', ?)`,
    ).run(
      'sess-proj-scoped',
      'task-proj-scoped',
      'running',
      Date.now() - 10 * 60 * 1000,
      'proj-markdone-e2e',
    );

    markSessionDone('sess-proj-scoped', Date.now(), null, 'test_call_site');

    const result = queryAuditLogByProject('proj-markdone-e2e', {
      eventType: 'session_done_deferred_while_running',
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      actorId: 'sess-proj-scoped',
      projectId: 'proj-markdone-e2e',
    });
  });

  it('applyPendingDone drops a stale deferred mark when the session already reached a terminal status via another path', () => {
    insertSession('sess-raced', 'running', 'task-abc');
    markSessionDone('sess-raced', Date.now(), null, 'test_call_site');
    expect(getStatus('sess-raced')).toBe('running');

    // Some other path (e.g. error handling) already concluded the session.
    db.prepare(`UPDATE sessions SET status = 'error' WHERE session_id = ?`).run(
      'sess-raced',
    );

    expect(applyPendingDone('sess-raced')).toBe(false);
    expect(getStatus('sess-raced')).toBe('error');
  });
});

// ── terminalized_at: durable genuine-terminalization timestamp ──────────────

describe('terminalized_at', () => {
  it('stays NULL while a done-transition is deferred (status_before=running is not terminal), and is set only once the deferred transition drains', () => {
    insertSession('sess-deferred-term', 'running', 'task-abc');
    const deferredEndedAt = Date.now() - 1000;

    markSessionDone(
      'sess-deferred-term',
      deferredEndedAt,
      null,
      'test_call_site',
    );

    // Deferral is not a terminal transition: status stays running, and
    // terminalized_at must not be set even though a done-transition (with
    // its own ended_at value) has been recorded for later application.
    expect(getStatus('sess-deferred-term')).toBe('running');
    expect(getTimestamps('sess-deferred-term')?.terminalized_at).toBeNull();

    const applied = applyPendingDone('sess-deferred-term');
    expect(applied).toBe(true);

    const after = getTimestamps('sess-deferred-term');
    // ended_at semantics are unchanged: it reflects the original deferral
    // time, preserved for backwards compatibility.
    expect(after?.ended_at).toBe(deferredEndedAt);
    // terminalized_at reflects the genuine terminal instant — when the
    // transition actually drained — not the original deferral time.
    expect(after?.terminalized_at).not.toBeNull();
    expect(after?.terminalized_at).toBeGreaterThanOrEqual(deferredEndedAt);
  });

  it('is set immediately for an idle→done transition (not deferred)', () => {
    insertSession('sess-idle-term', 'idle');
    const endedAt = Date.now();

    markSessionDone('sess-idle-term', endedAt, null, 'boot_idle_merged_pr');

    const row = getTimestamps('sess-idle-term');
    expect(row?.ended_at).toBe(endedAt);
    expect(row?.terminalized_at).toBe(endedAt);
  });
});

describe('terminalized_at on error/killed transitions', () => {
  it('sets terminalized_at when a session reaches error', () => {
    insertSession('sess-error-term', 'running');
    const endedAt = Date.now();

    updateSessionStatus('sess-error-term', 'error', endedAt);

    expect(getStatus('sess-error-term')).toBe('error');
    const row = getTimestamps('sess-error-term');
    expect(row?.ended_at).toBe(endedAt);
    expect(row?.terminalized_at).toBe(endedAt);
  });

  it('sets terminalized_at when a session reaches killed', () => {
    insertSession('sess-killed-term', 'running');
    const endedAt = Date.now();

    updateSessionStatus('sess-killed-term', 'killed', endedAt);

    expect(getStatus('sess-killed-term')).toBe('killed');
    const row = getTimestamps('sess-killed-term');
    expect(row?.ended_at).toBe(endedAt);
    expect(row?.terminalized_at).toBe(endedAt);
  });

  it('does NOT set terminalized_at for a non-terminal status transition (e.g. running)', () => {
    insertSession('sess-running-term', 'starting');

    updateSessionStatus('sess-running-term', 'running');

    expect(getStatus('sess-running-term')).toBe('running');
    expect(getTimestamps('sess-running-term')?.terminalized_at).toBeNull();
  });
});

// ── terminal_completion_reason persistence ───────────────────────────────────

describe('terminal_completion_reason', () => {
  it('markSessionDone persists terminal_completion_reason equal to its callSite value (idle→done, immediate)', () => {
    insertSession('sess-done-reason', 'idle');

    markSessionDone(
      'sess-done-reason',
      Date.now(),
      null,
      'boot_idle_merged_pr',
    );

    expect(getTerminalCompletionReason('sess-done-reason')).toBe(
      'boot_idle_merged_pr',
    );
  });

  it('markSessionDone does not write a reason when callSite is omitted', () => {
    insertSession('sess-done-no-reason', 'idle');

    markSessionDone('sess-done-no-reason', Date.now(), null);

    expect(getTerminalCompletionReason('sess-done-no-reason')).toBeNull();
  });

  it('a deferred markSessionDone transition persists its callSite as the reason once applyPendingDone drains it', () => {
    insertSession('sess-deferred-reason', 'running', 'task-abc');
    markSessionDone('sess-deferred-reason', Date.now(), null, 'test_call_site');
    // Not yet applied — no reason written yet.
    expect(getTerminalCompletionReason('sess-deferred-reason')).toBeNull();

    applyPendingDone('sess-deferred-reason');

    expect(getTerminalCompletionReason('sess-deferred-reason')).toBe(
      'test_call_site',
    );
  });

  it('markSessionSuperseded persists a reason once given one', () => {
    insertSession('sess-superseded-reason', 'running');

    markSessionSuperseded(
      'sess-superseded-reason',
      Date.now(),
      'resume_superseded',
    );

    expect(getTerminalCompletionReason('sess-superseded-reason')).toBe(
      'resume_superseded',
    );
    expect(getStatus('sess-superseded-reason')).toBe('superseded');
  });

  it('markSessionSuperseded does not write a reason when none is given', () => {
    insertSession('sess-superseded-no-reason', 'running');

    markSessionSuperseded('sess-superseded-no-reason', Date.now());

    expect(getTerminalCompletionReason('sess-superseded-no-reason')).toBeNull();
  });
});

// ── Terminal-path staged-intent reaping regression ───────────────────────────
//
// A genuine session death must still reap uncommitted staged intents —
// expireStagedIntentsForSession exists to prevent a parked proposal from
// sitting on the decision surface forever once its owning session can never
// resolve it. This is the DB-level contract that SessionManager.markSessionErrored
// relies on for every real terminal path (only the grant-respawn kill, which
// is not a real death, suppresses it — see markSessionErrored.test.ts).

describe('expireStagedIntentsForSession / sweepStagedIntentsForTerminalSessions — terminal-path reaping regression', () => {
  it("expireStagedIntentsForSession supersedes a session's staged and approved intents", () => {
    const staged = stageIntent('sess-dead', { state: 'staged' });
    const approved = stageIntent('sess-dead', { state: 'approved' });
    const otherSession = stageIntent('sess-alive', { state: 'staged' });

    const changed = expireStagedIntentsForSession(
      'sess-dead',
      'session_killed',
      Date.now(),
    );

    expect(changed).toBe(2);
    expect(getStagedIntent(staged)?.state).toBe('superseded');
    expect(getStagedIntent(staged)?.disposition_reason).toBe('session_killed');
    expect(getStagedIntent(approved)?.state).toBe('superseded');
    // A different session's staged intent is untouched.
    expect(getStagedIntent(otherSession)?.state).toBe('staged');
  });

  it('sweepStagedIntentsForTerminalSessions (the periodic backstop) still reaps intents whose owning session already sits terminal in the DB', () => {
    insertSession('sess-terminal-backstop', 'killed');
    const staged = stageIntent('sess-terminal-backstop');

    const swept = sweepStagedIntentsForTerminalSessions(
      'session_killed',
      Date.now(),
    );

    const forSession = swept.find(
      (s) => s.sessionId === 'sess-terminal-backstop',
    );
    expect(forSession?.expired.length).toBeGreaterThanOrEqual(1);
    expect(getStagedIntent(staged)?.state).toBe('superseded');
  });

  it('expiring the notification path does not resurrect the expired intent — state stays superseded', () => {
    const staged = stageIntent('sess-dead-2');

    expireStagedIntentsForSession('sess-dead-2', 'session_killed', Date.now());
    // Reading the row back (as the notification path does) must not mutate it.
    expect(getStagedIntent(staged)?.state).toBe('superseded');
    expect(getStagedIntent(staged)?.disposition_reason).toBe('session_killed');
  });
});

// ── hasUndispositionedStagedIntentsForSession / markSessionIdle call_site ──

describe('hasUndispositionedStagedIntentsForSession — used by boot orphan recovery to park planning sessions', () => {
  it('is true when the session holds a staged or approved intent', () => {
    stageIntent('sess-parked', { state: 'staged' });
    expect(hasUndispositionedStagedIntentsForSession('sess-parked')).toBe(true);
  });

  it('is false when the session has no intents at all', () => {
    expect(hasUndispositionedStagedIntentsForSession('sess-none')).toBe(false);
  });

  it('is false once the intent has been disposed (committed/withdrawn/superseded)', () => {
    stageIntent('sess-disposed', { state: 'committed' });
    expect(hasUndispositionedStagedIntentsForSession('sess-disposed')).toBe(
      false,
    );
  });

  it('surviving staged intents are not reaped by a subsequent terminal-session sweep once the session is idle, not done', () => {
    insertSession('sess-idle-parked', 'idle');
    const staged = stageIntent('sess-idle-parked');

    sweepStagedIntentsForTerminalSessions(
      'session_terminal_backstop',
      Date.now(),
    );

    expect(getStagedIntent(staged)?.state).toBe('staged');
  });
});

describe('markSessionIdle call_site', () => {
  it('records call_site on the session_status_changed audit row', () => {
    insertSession('sess-idle-callsite', 'running');

    markSessionIdle(
      'sess-idle-callsite',
      Date.now(),
      null,
      'boot_orphan_result_event_parked_planning',
    );

    const rows = getAuditRows('session_status_changed');
    const row = rows.find((r) => r.actor_id === 'sess-idle-callsite');
    expect(row).toBeDefined();
    expect(JSON.parse(row!.payload)).toMatchObject({
      from: 'running',
      to: 'idle',
      call_site: 'boot_orphan_result_event_parked_planning',
    });
  });
});

// ── Resume message must not contradict a real expiry notice ────────────────

function makePlanningSessionRow(overrides: Partial<Session> = {}): Session {
  return {
    session_id: 'sess-ops',
    session_type: 'ops',
    task_id: 'task-1',
    task_url: 'https://notion.so/task',
    project_context_url: 'https://notion.so/ctx',
    project_id: 'test-proj',
    status: 'running',
    started_at: Date.now(),
    ended_at: null,
    pr_url: null,
    worktree_path: null,
    note: null,
    tags: null,
    model: null,
    task_name: 'ops task',
    archived: 0,
    favorited: 0,
    ...overrides,
  } as Session;
}

describe('buildResumeMessage / buildPlanningResumeMessage — restart-resume vs. staged-intent expiry', () => {
  it('a restart-caused resume with no expired intents still gets the unqualified reassurance', () => {
    const row = makePlanningSessionRow();

    expect(buildResumeMessage(row, 'restart')).toBe(
      PLANNING_RESTART_RESUME_MESSAGE,
    );
  });

  it('a restart-caused resume with an expired staged intent does NOT get the false "nothing was decided or rejected" reassurance', () => {
    const row = makePlanningSessionRow();
    stageIntent(row.session_id);
    expireStagedIntentsForSession(row.session_id, 'session_killed', Date.now());

    const message = buildResumeMessage(row, 'restart');

    expect(message).not.toBe(PLANNING_RESTART_RESUME_MESSAGE);
    expect(message).not.toContain(
      'Nothing was decided or rejected while you were gone',
    );
  });

  it('a disposition-caused resume (not restart) is unaffected by expired intents — its own reject-state branch still wins', () => {
    const row = makePlanningSessionRow();
    stageIntent(row.session_id);
    expireStagedIntentsForSession(row.session_id, 'session_killed', Date.now());

    // No reject-state intent exists, so this falls to the plain fallback either way.
    expect(buildPlanningResumeMessage(row, 'disposition')).toBe(
      buildPlanningResumeMessage(row, 'disposition'),
    );
    expect(buildPlanningResumeMessage(row, 'disposition')).not.toContain(
      'Nothing was decided or rejected while you were gone',
    );
  });
});

// ── StuckSessionMonitor: no-PR branch liveness guard ─────────────────────────

describe('StuckSessionMonitor.scanForStuckSessions — liveness guard (no PR row)', () => {
  it('routes to idle when subprocess is alive and no PR row exists', async () => {
    insertSession('sess-alive', 'running');
    insertResultEvent('sess-alive');

    const sm = makeMockSessionManager(true); // subprocess alive
    const broadcast = vi.fn();
    const monitor = new StuckSessionMonitor(sm, broadcast);

    await monitor.scanForStuckSessions();

    expect(getStatus('sess-alive')).toBe('idle');
    // No premature done audit event
    expect(getAuditRows('session_marked_done_while_running')).toHaveLength(0);
  });

  it('broadcasts stuck_session_idle_open_pr for alive subprocess with no PR', async () => {
    insertSession('sess-alive-bc', 'running');
    insertResultEvent('sess-alive-bc');

    const sm = makeMockSessionManager(true);
    const broadcast = vi.fn();
    const monitor = new StuckSessionMonitor(sm, broadcast);

    await monitor.scanForStuckSessions();

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stuck_session_idle_open_pr',
        sessionId: 'sess-alive-bc',
      }),
    );
  });

  it('marks done (not idle) when subprocess is NOT alive and no PR row exists', async () => {
    insertSession('sess-dead', 'running');
    insertResultEvent('sess-dead');

    const sm = makeMockSessionManager(false); // subprocess NOT alive
    const monitor = new StuckSessionMonitor(sm, vi.fn());

    await monitor.scanForStuckSessions();

    expect(getStatus('sess-dead')).toBe('done');
  });

  it('does not defer or emit session_done_deferred_while_running when subprocess is confirmed dead — StuckSessionMonitor already verified liveness itself', async () => {
    insertSession('sess-dead-audit', 'running');
    insertResultEvent('sess-dead-audit');

    const sm = makeMockSessionManager(false);
    const monitor = new StuckSessionMonitor(sm, vi.fn());

    await monitor.scanForStuckSessions();

    expect(getAuditRows('session_done_deferred_while_running')).toHaveLength(0);
    expect(getStatus('sess-dead-audit')).toBe('done');
  });
});
