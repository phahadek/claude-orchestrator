import { db } from '../db/db';
import type { AuditEvent } from './types';

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
 * Count task_orphan_nudged events for the session recorded after sinceTs.
 * Used for episode-scoped counting: only nudges newer than the session's
 * last activity count toward NUDGE_LIMIT.
 */
export function countNudgeEventsSince(
  sessionId: string,
  sinceTs: number,
): number {
  const row = db
    .prepare<[string, number], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM audit_log
       WHERE event_type = 'task_orphan_nudged' AND actor_id = ? AND ts > ?`,
    )
    .get(sessionId, sinceTs);
  return row?.cnt ?? 0;
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
