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
import { markSessionDone } from '../db/queries';
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
    .prepare('SELECT event_type, actor_id, payload FROM audit_log WHERE event_type = ?')
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

// ── Advisory guard in markSessionDone ────────────────────────────────────────

describe('markSessionDone advisory guard', () => {
  it('writes session_marked_done_while_running to audit_log when status=running', () => {
    insertSession('sess-run', 'running', 'task-abc');

    markSessionDone('sess-run', Date.now(), null, 'test_call_site');

    const rows = getAuditRows('session_marked_done_while_running');
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload) as {
      call_site: string;
      status_before: string;
    };
    expect(payload.call_site).toBe('test_call_site');
    expect(payload.status_before).toBe('running');
    expect(rows[0].actor_id).toBe('sess-run');
    // Transition proceeds despite advisory
    expect(getStatus('sess-run')).toBe('done');
  });

  it('does NOT write audit event when status=idle (legitimate idle→done transition)', () => {
    insertSession('sess-idle', 'idle');

    markSessionDone('sess-idle', Date.now(), null, 'boot_idle_merged_pr');

    expect(getAuditRows('session_marked_done_while_running')).toHaveLength(0);
    expect(getStatus('sess-idle')).toBe('done');
  });

  it('records call_site=unknown when callSite argument is omitted', () => {
    insertSession('sess-no-site', 'running');

    markSessionDone('sess-no-site', Date.now(), null);

    const rows = getAuditRows('session_marked_done_while_running');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload)).toMatchObject({ call_site: 'unknown' });
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

  it('records session_marked_done_while_running with call_site=stuck_session_no_pr_periodic when subprocess dead', async () => {
    insertSession('sess-dead-audit', 'running');
    insertResultEvent('sess-dead-audit');

    const sm = makeMockSessionManager(false);
    const monitor = new StuckSessionMonitor(sm, vi.fn());

    await monitor.scanForStuckSessions();

    const rows = getAuditRows('session_marked_done_while_running');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      call_site: 'stuck_session_no_pr_periodic',
    });
  });
});
