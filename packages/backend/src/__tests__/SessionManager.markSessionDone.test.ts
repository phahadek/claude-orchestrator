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
import { markSessionDone, applyPendingDone } from '../db/queries';
import { db } from '../db/db.js';

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

beforeEach(() => {
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
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

    expect(getAuditRows('session_done_deferred_while_running')).toHaveLength(
      0,
    );
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

    expect(getAuditRows('session_done_deferred_while_running')).toHaveLength(
      0,
    );
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

    expect(
      getAuditRows('session_done_deferred_while_running'),
    ).toHaveLength(0);
    expect(getStatus('sess-dead-audit')).toBe('done');
  });
});
