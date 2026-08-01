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

/**
 * Resolves a project id for an event that didn't supply one, so the write
 * path — not each of its many call sites — is the single place the
 * actor/task → project invariant is enforced. Tries actor_id first (when it
 * names a known session), then falls back to task_id (via
 * task_repo_assignments). Returns null when neither resolves (e.g.
 * process_boot, which is attributed to neither) — recordEvent still writes
 * the row in that case, just without a project_id.
 */
function resolveProjectId(
  actorId: string | null,
  taskId: string | null,
): string | null {
  if (actorId) {
    const row = db
      .prepare<
        [string],
        { project_id: string | null }
      >(`SELECT project_id FROM sessions WHERE session_id = ?`)
      .get(actorId);
    if (row?.project_id) {
      return row.project_id;
    }
  }
  if (taskId) {
    const row = db
      .prepare<
        [string],
        { project_id: string }
      >(`SELECT project_id FROM task_repo_assignments WHERE task_id = ?`)
      .get(taskId);
    if (row?.project_id) {
      return row.project_id;
    }
  }
  return null;
}

export function recordEvent(event: AuditEvent): void {
  const stmt = db.prepare(`
    INSERT INTO audit_log (ts, event_type, actor_type, actor_id, project_id, task_id, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const projectId =
    event.project_id ??
    resolveProjectId(event.actor_id ?? null, event.task_id ?? null);
  stmt.run(
    Date.now(),
    event.event_type,
    event.actor_type,
    event.actor_id ?? null,
    projectId,
    event.task_id ?? null,
    JSON.stringify(event.payload),
  );
}

export interface AuditLogEntry {
  id: number;
  ts: number;
  eventType: string;
  actorType: string;
  actorId: string | null;
  projectId: string | null;
  taskId: string | null;
  payload: unknown;
}

/**
 * Returns every audit_log row recorded for the given session (matched on
 * actor_id, the convention every session-attributed audit event already
 * writes — see recordEvent call sites) — the own-record read this
 * orchestrator's grant surface can broker for a dispatched session
 * verifying its own or another session's runtime history (see
 * routes/sessionRecordRead.ts).
 */
export function getAuditLogByActorId(actorId: string): AuditLogEntry[] {
  const rows = db
    .prepare<
      [string],
      AuditRow
    >(`SELECT * FROM audit_log WHERE actor_id = ? ORDER BY id ASC`)
    .all(actorId);
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    eventType: r.event_type,
    actorType: r.actor_type,
    actorId: r.actor_id,
    projectId: r.project_id,
    taskId: r.task_id,
    payload: JSON.parse(r.payload) as unknown,
  }));
}

/**
 * Row cap for `queryAuditLogByProject`'s `entries` — an unfiltered
 * project-wide `SELECT *` against a large project's audit_log can run to
 * tens of thousands of rows and tens of megabytes, which blows the MCP
 * client's tool-result size limit (see the task context: 78,896 rows /
 * 22.9 MB for one project, silently surfaced by the CLI as an unrelated
 * "MCP server session expired" error). Mirrors SESSION_EVENTS_ROW_CAP
 * (db/queries.ts).
 */
export const AUDIT_LOG_ROW_CAP = 200;

export interface AuditLogQueryFilters {
  taskId?: string;
  eventType?: string;
  /** Inclusive lower bound on `ts` (epoch ms). */
  since?: number;
  /** Inclusive upper bound on `ts` (epoch ms). */
  until?: number;
}

/**
 * Distinguishes the three shapes a project-scoped audit query can return:
 * - `entries`: matching rows, project-scoped as before.
 * - `unattributedCount`: rows elsewhere in the table matching the same
 *   task/eventType/window filters but with no project_id at all — i.e. the
 *   event did happen, it just isn't attributed to any project (some events,
 *   like process_boot, never resolve to one). A caller seeing `entries: []`
 *   alongside `unattributedCount > 0` must not read that as "this did not
 *   happen."
 * - `eventTypeRecognized`: null when no `eventType` filter was supplied
 *   (not applicable); otherwise whether that event type matches any row at
 *   all, anywhere in the table — false means the name is unrecognized or
 *   retired, not that it merely didn't fire in this window.
 * - `matchedCount`: the total number of project-scoped rows matching the
 *   filters, independent of the `entries` cap — lets a caller tell
 *   `entries.length < matchedCount` apart from "that's really all of them"
 *   without a silent truncation.
 */
export interface AuditLogQueryResult {
  entries: AuditLogEntry[];
  unattributedCount: number;
  eventTypeRecognized: boolean | null;
  matchedCount: number;
}

function buildFilterClauses(filters: AuditLogQueryFilters): {
  clauses: string[];
  params: (string | number)[];
} {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filters.taskId !== undefined) {
    clauses.push('task_id = ?');
    params.push(filters.taskId);
  }
  if (filters.eventType !== undefined) {
    clauses.push('event_type = ?');
    params.push(filters.eventType);
  }
  if (filters.since !== undefined) {
    clauses.push('ts >= ?');
    params.push(filters.since);
  }
  if (filters.until !== undefined) {
    clauses.push('ts <= ?');
    params.push(filters.until);
  }
  return { clauses, params };
}

/**
 * Returns every audit_log row for the given project, optionally narrowed by
 * task id / event type / a `[since, until]` ts window — the query behind the
 * `auditLog.query` MCP tool (see mcp/tools/auditLogReadTools.ts). Always
 * project-scoped: there is no unscoped-across-all-projects variant, matching
 * the `read:audit-log:<projectId>` capability shape it is gated behind.
 * Backed by `idx_audit_log_project_task` (db/schema.ts) so this doesn't
 * table-scan.
 *
 * Also returns `unattributedCount`, `eventTypeRecognized`, and
 * `matchedCount` (see `AuditLogQueryResult`) so a caller can tell "this did
 * not happen" apart from "this happened but isn't project-attributed",
 * "that event name doesn't exist", and "this was truncated to the cap" — an
 * empty or short `entries` array alone can't distinguish any of those.
 *
 * `entries` is capped at `AUDIT_LOG_ROW_CAP` rows (or `limit`, if lower) and
 * returns the most recent matching rows (`ORDER BY id DESC`, re-ascended to
 * chronological order for the response) rather than the oldest — the useful
 * slice when the full result is too large to return in one call.
 */
export function queryAuditLogByProject(
  projectId: string,
  filters: AuditLogQueryFilters = {},
  limit: number = AUDIT_LOG_ROW_CAP,
): AuditLogQueryResult {
  const { clauses, params } = buildFilterClauses(filters);
  const cappedLimit = Math.min(limit, AUDIT_LOG_ROW_CAP);

  const scopedClauses = ['project_id = ?', ...clauses];
  const scopedParams = [projectId, ...params];
  const rows = db
    .prepare<
      (string | number)[],
      AuditRow
    >(`SELECT * FROM audit_log WHERE ${scopedClauses.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...scopedParams, cappedLimit);
  const entries = rows
    .map((r) => ({
      id: r.id,
      ts: r.ts,
      eventType: r.event_type,
      actorType: r.actor_type,
      actorId: r.actor_id,
      projectId: r.project_id,
      taskId: r.task_id,
      payload: JSON.parse(r.payload) as unknown,
    }))
    .reverse();

  const matchedRow = db
    .prepare<
      (string | number)[],
      { cnt: number }
    >(`SELECT COUNT(*) AS cnt FROM audit_log WHERE ${scopedClauses.join(' AND ')}`)
    .get(...scopedParams);
  const matchedCount = matchedRow?.cnt ?? 0;

  const unattributedClauses = ['project_id IS NULL', ...clauses];
  const unattributedRow = db
    .prepare<
      (string | number)[],
      { cnt: number }
    >(`SELECT COUNT(*) AS cnt FROM audit_log WHERE ${unattributedClauses.join(' AND ')}`)
    .get(...params);
  const unattributedCount = unattributedRow?.cnt ?? 0;

  let eventTypeRecognized: boolean | null = null;
  if (filters.eventType !== undefined) {
    const existsRow = db
      .prepare<
        [string],
        { one: number }
      >(`SELECT 1 AS one FROM audit_log WHERE event_type = ? LIMIT 1`)
      .get(filters.eventType);
    eventTypeRecognized = existsRow !== undefined;
  }

  return { entries, unattributedCount, eventTypeRecognized, matchedCount };
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
 * True when a task_ops_stranded_surfaced event has already been recorded for
 * this task at this exact ops_journal.updated_at value — the sweep-cycle
 * dedup for StrandedOpsTaskMonitor. The journal's updated_at cannot change
 * while the task is genuinely stranded (nothing can advance it), so this
 * suppresses a duplicate event every cycle while still allowing a fresh
 * event if the journal is later touched and lands stranded again.
 */
export function hasStrandedOpsSurfacedEvent(
  taskId: string,
  journalUpdatedAt: string,
): boolean {
  const rows = db
    .prepare<[string], { payload: string }>(
      `SELECT payload FROM audit_log
       WHERE task_id = ? AND event_type = 'task_ops_stranded_surfaced'`,
    )
    .all(taskId);
  return rows.some((r) => {
    try {
      return (
        (JSON.parse(r.payload) as { journalUpdatedAt?: string })
          .journalUpdatedAt === journalUpdatedAt
      );
    } catch {
      return false;
    }
  });
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

/**
 * True when a task_body_updated or task_deps_updated event has been recorded
 * for `taskId` after `sinceTs` — the orchestrator-authored-write signal a
 * committed planning.noOp's grooming suppression retires on (see
 * isGroomNoOpSuppressed in db/queries.ts). Both event types are written by
 * AuditingTaskBackend for every orchestrator-authored body/deps edit; a raw
 * break-glass Notion edit doesn't itself retire the suppression, only the
 * next orchestrator-authored write does.
 */
export function hasTaskEditSinceTimestamp(
  taskId: string,
  sinceTs: number,
): boolean {
  const row = db
    .prepare<[string, number], { one: number }>(
      `SELECT 1 AS one FROM audit_log
       WHERE task_id = ? AND event_type IN ('task_body_updated', 'task_deps_updated') AND ts > ?
       LIMIT 1`,
    )
    .get(taskId, sinceTs);
  return row !== undefined;
}

/**
 * True when a pr_body_updated_via_marker event has been recorded for
 * `taskId` after `sinceTs` — the signal that a coding session already applied
 * a PR-body-only remedy (see AgentSession.handlePRBodyMarker) to an
 * outstanding needs_changes verdict. Used by StalledPRReconciler to
 * disambiguate "the session responded via a non-push remedy and is waiting on
 * a re-review neither the push nor session-end trigger can fire" from "the
 * session is genuinely silent," so its session_inert remedy can force a
 * re-review in the former case instead of nudging a session that already did
 * its part.
 */
export function hasPrBodyMarkerUpdateSinceTimestamp(
  taskId: string,
  sinceTs: number,
): boolean {
  const row = db
    .prepare<[string, number], { one: number }>(
      `SELECT 1 AS one FROM audit_log
       WHERE task_id = ? AND event_type = 'pr_body_updated_via_marker' AND ts > ?
       LIMIT 1`,
    )
    .get(taskId, sinceTs);
  return row !== undefined;
}
