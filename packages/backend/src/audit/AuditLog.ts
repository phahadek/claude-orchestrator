import { db } from '../db/db';
import type { AuditEvent } from './types';

export interface AuditRow {
  id: number;
  ts: number;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  project_id: string | null;
  task_id: string | null;
  payload: string;
}

export function recordEvent(event: AuditEvent): void {
  const stmt = db.prepare(`
    INSERT INTO audit_log (ts, event_type, actor_type, actor_id, project_id, task_id, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    Date.now(),
    event.event_type,
    event.actor_type,
    event.actor_id ?? null,
    event.project_id ?? null,
    event.task_id ?? null,
    JSON.stringify(event.payload),
  );
}

/**
 * Returns the number of task_orphan_nudged events recorded for the given
 * session. Used to derive the persisted nudge count across sweeper cycles.
 */
export function countNudgeEvents(sessionId: string): number {
  const row = db
    .prepare<[string], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM audit_log
       WHERE event_type = 'task_orphan_nudged' AND actor_id = ?`,
    )
    .get(sessionId);
  return row?.cnt ?? 0;
}

/** Returns the ts of the most recent task_orphan_nudged event for the session, or null. */
export function getLatestNudgeTimestamp(sessionId: string): number | null {
  const row = db
    .prepare<[string], { ts: number | null }>(
      `SELECT MAX(ts) AS ts FROM audit_log
       WHERE event_type = 'task_orphan_nudged' AND actor_id = ?`,
    )
    .get(sessionId);
  return row?.ts ?? null;
}

/**
 * Returns the number of pr_creation_failed events with stage='push' recorded
 * for the given session. Used to derive the persisted push-retry count.
 */
export function countPushFailureEvents(sessionId: string): number {
  const rows = db
    .prepare(
      `SELECT payload FROM audit_log
       WHERE event_type = 'pr_creation_failed' AND actor_id = ?`,
    )
    .all(sessionId) as { payload: string }[];
  return rows.filter((r) => {
    try {
      return (JSON.parse(r.payload) as { stage?: string }).stage === 'push';
    } catch {
      return false;
    }
  }).length;
}

/**
 * Returns the number of audit_log rows of the given event type recorded for
 * the given session (matched on actor_id). Used to distinguish a planning
 * session's first turn from a later one (e.g. counting prior
 * handle_clean_exit_session_marked_idle events).
 */
export function countEventsBySessionAndType(
  sessionId: string,
  eventType: string,
): number {
  const row = db
    .prepare<[string, string], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM audit_log
       WHERE event_type = ? AND actor_id = ?`,
    )
    .get(eventType, sessionId);
  return row?.cnt ?? 0;
}

/** Returns the most recent audit_log row of the given event type, or undefined. */
export function getLatestEventByType(eventType: string): AuditRow | undefined {
  return db
    .prepare<
      [string],
      AuditRow
    >(`SELECT * FROM audit_log WHERE event_type = ? ORDER BY ts DESC LIMIT 1`)
    .get(eventType);
}
