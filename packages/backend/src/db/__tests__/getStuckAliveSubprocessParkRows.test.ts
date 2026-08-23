/**
 * DB-level tests for getStuckAliveSubprocessParkRows — the query
 * StuckSessionMonitor uses to bound a stuck_session_alive_subprocess park.
 *
 * Uses a real in-memory SQLite DB (setupTestDb) so the audit_log JOIN and
 * json_extract filtering are exercised for real, not mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import(
    '../../../test/helpers/setupTestDb.js'
  );
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import { getStuckAliveSubprocessParkRows } from '../queries.js';

function insertSession(sessionId: string, status = 'idle'): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, project_id, task_id, task_url, project_context_url,
        status, started_at, ended_at, session_type, worktree_path, pr_url)
     VALUES (?, 'proj-1', 'task-1', 'https://notion.so/task', 'https://notion.so/ctx',
       ?, ?, ?, 'standard', '/fake/wt', NULL)`,
  ).run(
    sessionId,
    status,
    Date.now() - 60 * 60 * 1000,
    Date.now() - 30 * 60 * 1000,
  );
}

function insertStatusChangedAudit(
  sessionId: string,
  callSite: string,
  ts: number,
): void {
  db.prepare(
    `INSERT INTO audit_log (ts, event_type, actor_type, actor_id, payload)
     VALUES (?, 'session_status_changed', 'system', ?, ?)`,
  ).run(
    ts,
    sessionId,
    JSON.stringify({ from: 'running', to: 'idle', call_site: callSite }),
  );
}

function insertSessionEvent(sessionId: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO session_events (session_id, event_type, payload, timestamp)
     VALUES (?, 'system', '{}', ?)`,
  ).run(sessionId, timestamp);
}

beforeEach(() => {
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM sessions').run();
});

describe('getStuckAliveSubprocessParkRows', () => {
  it('matches a session whose latest transition parked it via stuck_session_alive_subprocess', () => {
    insertSession('sess-1');
    const parkTs = Date.now() - 30 * 60 * 1000;
    insertStatusChangedAudit('sess-1', 'stuck_session_alive_subprocess', parkTs);
    insertSessionEvent('sess-1', parkTs);

    const rows = getStuckAliveSubprocessParkRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'sess-1',
      parked_at: parkTs,
    });
  });

  it('never matches a session parked via stuck_session_open_pr, regardless of age', () => {
    insertSession('sess-2');
    const parkTs = Date.now() - 24 * 60 * 60 * 1000;
    insertStatusChangedAudit('sess-2', 'stuck_session_open_pr', parkTs);
    insertSessionEvent('sess-2', parkTs);

    const rows = getStuckAliveSubprocessParkRows();

    expect(rows).toHaveLength(0);
  });

  it('excludes a session no longer idle even if it was once parked via stuck_session_alive_subprocess', () => {
    insertSession('sess-3', 'running');
    insertStatusChangedAudit(
      'sess-3',
      'stuck_session_alive_subprocess',
      Date.now() - 30 * 60 * 1000,
    );

    const rows = getStuckAliveSubprocessParkRows();

    expect(rows).toHaveLength(0);
  });

  it('only considers the latest session_status_changed transition, not an earlier alive-subprocess park superseded by a later transition', () => {
    insertSession('sess-4');
    insertStatusChangedAudit(
      'sess-4',
      'stuck_session_alive_subprocess',
      Date.now() - 60 * 60 * 1000,
    );
    insertStatusChangedAudit(
      'sess-4',
      'stuck_session_open_pr',
      Date.now() - 10 * 60 * 1000,
    );

    const rows = getStuckAliveSubprocessParkRows();

    expect(rows).toHaveLength(0);
  });

  it('reports a later session_events timestamp than the park as latest_event_ts, distinct from the value known at park time', () => {
    insertSession('sess-5');
    const parkTs = Date.now() - 30 * 60 * 1000;
    insertStatusChangedAudit('sess-5', 'stuck_session_alive_subprocess', parkTs);
    insertSessionEvent('sess-5', parkTs - 1000);
    const laterEventTs = Date.now() - 5000;
    insertSessionEvent('sess-5', laterEventTs);

    const rows = getStuckAliveSubprocessParkRows();

    expect(rows).toHaveLength(1);
    expect(rows[0].latest_event_ts).toBe(laterEventTs);
  });
});
