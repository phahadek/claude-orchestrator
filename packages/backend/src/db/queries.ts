import { db } from './db';
import { logger } from '../logger';
import { recordEvent } from '../audit/AuditLog';
import {
  pauseReasonFromCanonical,
  serializePauseReason,
  parsePauseReason,
} from './pauseReason';
import type {
  Session,
  NewSession,
  SessionEvent,
  NewSessionEvent,
  PermissionEvent,
  NewPermissionEvent,
  PermissionRule,
  PermissionDenialRow,
  NewPermissionDenialRow,
  TaskCache,
  PullRequestRow,
  PauseReason,
  CanonicalPauseReason,
  PauseReasonStruct,
  ProjectRow,
  NewProjectRow,
  MilestoneRow,
  NewMilestoneRow,
  LocalBranchRow,
  NewLocalBranchRow,
  DeviceRow,
  NewDeviceRow,
  SessionPauseInterval,
} from './types';

// ─── sessions ──────────────────────────────────────────────────────────────

const stmtInsertSession = db.prepare<NewSession>(`
  INSERT INTO sessions
    (session_id, task_id, task_url, project_context_url,
     project_id, status, started_at, ended_at, pr_url, worktree_path, session_type, task_name)
  VALUES
    (@session_id, @task_id, @task_url, @project_context_url,
     @project_id, @status, @started_at, @ended_at, @pr_url, @worktree_path, @session_type, @task_name)
`);

const stmtUpdateSessionStatus = db.prepare<{
  session_id: string;
  status: string;
  ended_at: number | null;
}>(`
  UPDATE sessions
  SET status = @status, ended_at = @ended_at
  WHERE session_id = @session_id
`);

const stmtUpdateSessionWorktreePath = db.prepare<{
  session_id: string;
  worktree_path: string;
}>(`
  UPDATE sessions
  SET worktree_path = @worktree_path
  WHERE session_id = @session_id
`);

const stmtGetSession = db.prepare<{ session_id: string }>(`
  SELECT * FROM sessions WHERE session_id = @session_id
`);

const stmtGetAllSessionIds = db.prepare(`
  SELECT session_id FROM sessions
`);

const stmtDeleteSession = db.prepare<{ session_id: string }>(`
  DELETE FROM sessions WHERE session_id = @session_id
`);

const stmtInsertSessionOrIgnore = db.prepare<NewSession>(`
  INSERT OR IGNORE INTO sessions
    (session_id, task_id, task_url, project_context_url,
     project_id, status, started_at, ended_at, pr_url, worktree_path, session_type, task_name)
  VALUES
    (@session_id, @task_id, @task_url, @project_context_url,
     @project_id, @status, @started_at, @ended_at, @pr_url, @worktree_path, @session_type, @task_name)
`);

export function insertSession(s: NewSession): void {
  stmtInsertSession.run({
    ended_at: null,
    pr_url: null,
    worktree_path: null,
    project_id: null,
    session_type: 'standard',
    ...s,
    task_name: s.task_name ?? null,
  });
}

export function updateSessionStatus(
  sessionId: string,
  status: string,
  endedAt?: number,
): void {
  stmtUpdateSessionStatus.run({
    session_id: sessionId,
    status,
    ended_at: endedAt ?? null,
  });
}

export function updateSessionWorktreePath(
  sessionId: string,
  worktreePath: string,
): void {
  stmtUpdateSessionWorktreePath.run({
    session_id: sessionId,
    worktree_path: worktreePath,
  });
}

export function setSessionPauseReason(sessionId: string, reason: string): void {
  db.prepare<{ session_id: string; pause_reason: string }>(
    `UPDATE sessions SET pause_reason = @pause_reason WHERE session_id = @session_id`,
  ).run({ session_id: sessionId, pause_reason: reason });
}

export function setSessionLastErrorDetail(
  sessionId: string,
  detail: string,
): void {
  db.prepare<{ session_id: string; last_error_detail: string }>(
    `UPDATE sessions SET last_error_detail = @last_error_detail WHERE session_id = @session_id`,
  ).run({ session_id: sessionId, last_error_detail: detail });
}

const stmtMarkSessionDone = db.prepare<{
  session_id: string;
  ended_at: number;
  pr_url: string | null;
}>(`
  UPDATE sessions
  SET status = 'done', ended_at = @ended_at, pr_url = COALESCE(@pr_url, pr_url)
  WHERE session_id = @session_id
`);

const stmtMarkSessionIdle = db.prepare<{
  session_id: string;
  ended_at: number;
  pr_url: string | null;
}>(`
  UPDATE sessions
  SET status = 'idle', ended_at = @ended_at, pr_url = COALESCE(@pr_url, pr_url)
  WHERE session_id = @session_id
`);

const stmtMarkSessionSuperseded = db.prepare<{
  session_id: string;
  ended_at: number;
}>(`
  UPDATE sessions
  SET status = 'superseded', ended_at = @ended_at
  WHERE session_id = @session_id
`);

/**
 * Mark a session as superseded — used when sendOrResume creates a continuation
 * and another running row for the same task_id exists and must be retired.
 * Superseded rows are treated as terminal: excluded from active-session checks
 * and not resumed on next boot.
 */
export function markSessionSuperseded(
  sessionId: string,
  endedAt: number,
): void {
  stmtMarkSessionSuperseded.run({ session_id: sessionId, ended_at: endedAt });
}

/**
 * Returns other standard (non-review) sessions in status='running' for the same
 * task_id, excluding the given session. Used by sendOrResume to reconcile zombie
 * rows before respawning.
 */
export function getOtherRunningSessionsForTask(
  taskId: string,
  excludeSessionId: string,
): Session[] {
  const norm = taskId.replace(/-/g, '');
  return db
    .prepare<{ task_id: string; session_id: string }>(
      `
    SELECT * FROM sessions
    WHERE REPLACE(COALESCE(task_id, ''), '-', '') = @task_id
      AND session_id != @session_id
      AND status = 'running'
      AND (session_type = 'standard' OR session_type IS NULL)
  `,
    )
    .all({ task_id: norm, session_id: excludeSessionId }) as Session[];
}

/**
 * Atomically mark a session as done, setting ended_at and pr_url in a single
 * write. Preferred over updateSessionStatus for clean-exit paths because it
 * also persists pr_url without a second round-trip.
 * pr_url is only overwritten when non-null — existing value is preserved otherwise.
 *
 * Advisory guard: if the current session status is 'running', emits a
 * session_marked_done_while_running audit event to surface premature transitions
 * in production data. The write proceeds regardless (advisory only).
 */
export function markSessionDone(
  sessionId: string,
  endedAt: number,
  prUrl?: string | null,
  callSite?: string,
): void {
  const current = stmtGetSession.get({ session_id: sessionId }) as
    | { status: string; task_id: string | null }
    | undefined;
  if (current?.status === 'running') {
    logger.warn(
      `[markSessionDone] running→done for ${sessionId.slice(0, 8)} call_site=${callSite ?? 'unknown'} — emitting audit event`,
    );
    recordEvent({
      event_type: 'session_marked_done_while_running',
      actor_type: 'system',
      actor_id: sessionId,
      task_id: current.task_id ?? null,
      payload: { call_site: callSite ?? 'unknown', status_before: 'running' },
    });
  }
  stmtMarkSessionDone.run({
    session_id: sessionId,
    ended_at: endedAt,
    pr_url: prUrl ?? null,
  });
}

/**
 * Atomically mark a session as idle (process exited, PR open, waiting for
 * review/merge). Sets ended_at and pr_url in a single write. The session
 * remains resumable via sendOrResume; it becomes done only when the PR merges.
 */
export function markSessionIdle(
  sessionId: string,
  endedAt: number,
  prUrl?: string | null,
): void {
  stmtMarkSessionIdle.run({
    session_id: sessionId,
    ended_at: endedAt,
    pr_url: prUrl ?? null,
  });
}

export interface StuckResultSessionRow {
  session_id: string;
  task_id: string | null;
  task_url: string | null;
  project_context_url: string | null;
  project_id: string | null;
  pr_url: string | null;
  worktree_path: string | null;
  session_type: string;
  last_ts: number;
}

/**
 * Query sessions stuck at status='running' whose last recorded event is a
 * result event (the CLI's clean-exit signal). Does NOT update the DB.
 * Matches production storage: result events are persisted with event_type='system'
 * and payload.type='result' (i.e. eventKind(row) === 'result'), NOT event_type='result'.
 * If minAgeMs is provided, only returns sessions older than that threshold.
 */
export function getStuckResultSessionRows(
  minAgeMs?: number,
): StuckResultSessionRow[] {
  if (minAgeMs !== undefined) {
    return db
      .prepare(
        `
      SELECT s.session_id, s.task_id, s.task_url, s.project_context_url,
             s.project_id, s.pr_url, s.worktree_path, s.session_type,
             e.timestamp AS last_ts
      FROM sessions s
      JOIN session_events e ON e.session_id = s.session_id
      WHERE s.status = 'running'
        AND e.id = (SELECT MAX(id) FROM session_events WHERE session_id = s.session_id)
        AND e.event_type = 'system'
        AND json_extract(e.payload, '$.type') = 'result'
        AND s.started_at < (unixepoch('now') - @min_age_seconds) * 1000
    `,
      )
      .all({
        min_age_seconds: Math.floor(minAgeMs / 1000),
      }) as StuckResultSessionRow[];
  }
  return db
    .prepare(
      `
    SELECT s.session_id, s.task_id, s.task_url, s.project_context_url,
           s.project_id, s.pr_url, s.worktree_path, s.session_type,
           e.timestamp AS last_ts
    FROM sessions s
    JOIN session_events e ON e.session_id = s.session_id
    WHERE s.status = 'running'
      AND e.id = (SELECT MAX(id) FROM session_events WHERE session_id = s.session_id)
      AND e.event_type = 'system'
      AND json_extract(e.payload, '$.type') = 'result'
  `,
    )
    .all() as StuckResultSessionRow[];
}

/**
 * Query running sessions whose PR is already merged or closed — these should be
 * reaped on boot rather than resumed as orphans.
 * Covers both GitHub PRs (pull_requests table, state='merged'|'closed') and
 * local-only branches (local_branches table, status='merged').
 */
export function getRunningSessionsWithMergedOrClosedPR(): StuckResultSessionRow[] {
  return db
    .prepare(
      `
    SELECT s.session_id, s.task_id, s.task_url, s.project_context_url,
           s.project_id, s.pr_url, s.worktree_path, s.session_type,
           COALESCE(e.timestamp, s.started_at) AS last_ts
    FROM sessions s
    LEFT JOIN session_events e ON e.session_id = s.session_id
      AND e.id = (SELECT MAX(id) FROM session_events WHERE session_id = s.session_id)
    WHERE s.status = 'running'
      AND (
        EXISTS (
          SELECT 1 FROM pull_requests pr
          WHERE pr.session_id = s.session_id
            AND pr.state IN ('merged', 'closed')
        )
        OR EXISTS (
          SELECT 1 FROM local_branches lb
          WHERE lb.session_id = s.session_id
            AND lb.status = 'merged'
        )
      )
  `,
    )
    .all() as StuckResultSessionRow[];
}

export function getSession(sessionId: string): Session | undefined {
  return stmtGetSession.get({ session_id: sessionId }) as Session | undefined;
}

export function getAllSessionIds(): string[] {
  return (stmtGetAllSessionIds.all() as { session_id: string }[]).map(
    (r) => r.session_id,
  );
}

export function insertSessionOrIgnore(s: NewSession): void {
  stmtInsertSessionOrIgnore.run({
    ended_at: null,
    pr_url: null,
    worktree_path: null,
    project_id: null,
    session_type: 'standard',
    ...s,
    task_name: s.task_name ?? null,
  });
}

export function deleteSession(sessionId: string): boolean {
  const result = stmtDeleteSession.run({ session_id: sessionId });
  return result.changes > 0;
}

/**
 * Delete sessions that have no events — these are "ghost sessions" created by
 * either empty JSONL imports or session starts that never ran the subprocess.
 * Returns the number of sessions deleted.
 */
export function deleteGhostSessions(): number {
  const result = db
    .prepare(
      `
    DELETE FROM sessions
    WHERE session_id NOT IN (SELECT DISTINCT session_id FROM session_events)
  `,
    )
    .run();
  return result.changes;
}

export function getSessionsByStatus(statuses: string[]): Session[] {
  const placeholders = statuses.map(() => '?').join(', ');
  return db
    .prepare(
      `
    SELECT * FROM sessions WHERE status IN (${placeholders}) ORDER BY started_at DESC
  `,
    )
    .all(...statuses) as Session[];
}

/**
 * Returns true when a standard (non-review) session is currently active for the
 * given task id. "Active" means not in a terminal status (done, error, killed).
 * Used by AutoLauncher to avoid re-launching a task whose status hasn't yet
 * propagated back from the task backend.
 * Strips hyphens from both sides to normalize UUID format differences.
 */
/**
 * Returns terminal (done/error/killed/superseded) standard sessions for a task,
 * most recent first. Used to identify stale predecessor sessions on fresh launch.
 */
export function getTerminalSessionsForTask(taskId: string): Session[] {
  const norm = taskId.replace(/-/g, '');
  return db
    .prepare<{ task_id: string }>(
      `SELECT * FROM sessions
       WHERE REPLACE(COALESCE(task_id, ''), '-', '') = @task_id
         AND status IN ('done', 'error', 'killed', 'superseded')
         AND (session_type = 'standard' OR session_type IS NULL)
       ORDER BY started_at DESC`,
    )
    .all({ task_id: norm }) as Session[];
}

export function hasActiveSessionForTask(taskId: string): boolean {
  const norm = taskId.replace(/-/g, '');
  const row = db
    .prepare<{ task_id: string }>(
      `
    SELECT 1 FROM sessions
    WHERE REPLACE(COALESCE(task_id, ''), '-', '') = @task_id
      AND status NOT IN ('idle', 'done', 'error', 'killed', 'superseded')
      AND (session_type = 'standard' OR session_type IS NULL)
    LIMIT 1
  `,
    )
    .get({ task_id: norm });
  return !!row;
}

export function getActiveSessions(): Session[] {
  // LEFT JOIN pull_requests so that prUrl is populated even when sessions.pr_url
  // is NULL (e.g. sessions started before their PR was linked back to the row).
  return db
    .prepare(
      `
    SELECT
      s.session_id, s.task_id, s.task_url, s.project_context_url,
      s.project_id, s.status, s.started_at, s.ended_at, s.worktree_path,
      s.archived, s.favorited, s.session_type, s.note, s.tags,
      s.total_input_tokens, s.total_output_tokens, s.model, s.task_name,
      COALESCE(s.pr_url, (
        SELECT p.pr_url FROM pull_requests p WHERE p.session_id = s.session_id LIMIT 1
      )) AS pr_url
    FROM sessions s
    WHERE s.archived = 0
    ORDER BY s.started_at DESC
  `,
    )
    .all() as Session[];
}

export function getArchivedSessions(): Session[] {
  return db
    .prepare(
      'SELECT * FROM sessions WHERE archived = 1 ORDER BY started_at DESC',
    )
    .all() as Session[];
}

export function archiveSession(sessionId: string): boolean {
  const result = db
    .prepare('UPDATE sessions SET archived = 1 WHERE session_id = ?')
    .run(sessionId);
  return result.changes > 0;
}

export function unarchiveSession(sessionId: string): boolean {
  const result = db
    .prepare('UPDATE sessions SET archived = 0 WHERE session_id = ?')
    .run(sessionId);
  return result.changes > 0;
}

export function favoriteSession(sessionId: string): boolean {
  const result = db
    .prepare('UPDATE sessions SET favorited = 1 WHERE session_id = ?')
    .run(sessionId);
  return result.changes > 0;
}

export function unfavoriteSession(sessionId: string): boolean {
  const result = db
    .prepare('UPDATE sessions SET favorited = 0 WHERE session_id = ?')
    .run(sessionId);
  return result.changes > 0;
}

export function archiveFinishedSessions(): number {
  const result = db
    .prepare(
      `UPDATE sessions SET archived = 1 WHERE status IN ('done', 'error', 'killed', 'idle')`,
    )
    .run();
  return result.changes;
}

/**
 * Archive concluded sessions (status IN ('done','error','killed'), archived=0)
 * whose ended_at is older than the given cutoff timestamp (ms).
 * Idle sessions are excluded — the CLI subprocess is still alive and resumable.
 * Returns the session_ids of archived sessions.
 */
export function archiveConcludedSessionsOlderThan(cutoffMs: number): string[] {
  const rows = db
    .prepare(
      `SELECT session_id FROM sessions
       WHERE status IN ('done', 'error', 'killed')
         AND archived = 0
         AND ended_at IS NOT NULL
         AND ended_at < @cutoff`,
    )
    .all({ cutoff: cutoffMs }) as { session_id: string }[];

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.session_id);
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(
    `UPDATE sessions SET archived = 1 WHERE session_id IN (${placeholders})`,
  ).run(...ids);

  return ids;
}

export function getSessionsByProject(projectId: string): Session[] {
  return db
    .prepare(
      'SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC',
    )
    .all(projectId) as Session[];
}

export function setSessionNote(sessionId: string, note: string | null): void {
  db.prepare('UPDATE sessions SET note = ? WHERE session_id = ?').run(
    note,
    sessionId,
  );
}

export function setSessionModel(sessionId: string, model: string): void {
  db.prepare('UPDATE sessions SET model = ? WHERE session_id = ?').run(
    model,
    sessionId,
  );
}

export function setSessionTags(sessionId: string, tags: string[]): void {
  db.prepare('UPDATE sessions SET tags = ? WHERE session_id = ?').run(
    JSON.stringify(tags),
    sessionId,
  );
}

export function getSessionTags(sessionId: string): string[] {
  const row = db
    .prepare('SELECT tags FROM sessions WHERE session_id = ?')
    .get(sessionId) as { tags: string | null } | undefined;
  if (!row?.tags) return [];
  try {
    return JSON.parse(row.tags) as string[];
  } catch {
    return [];
  }
}

export function setDerivedTitle(sessionId: string, title: string): void {
  setSessionMetadata(sessionId, { derivedTitle: title });
}

export function setSessionMetadata(
  sessionId: string,
  fields: Record<string, unknown>,
): void {
  const row = db
    .prepare('SELECT metadata FROM sessions WHERE session_id = ?')
    .get(sessionId) as { metadata: string | null } | undefined;
  let existing: Record<string, unknown> = {};
  if (row?.metadata) {
    try {
      existing = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      /* ignore malformed */
    }
  }
  db.prepare('UPDATE sessions SET metadata = ? WHERE session_id = ?').run(
    JSON.stringify({ ...existing, ...fields }),
    sessionId,
  );
}

// ─── session_events ────────────────────────────────────────────────────────

export const MAX_EVENT_PAYLOAD_BYTES = 262144;
const HEAD_BYTES = 8192;

function capEventPayload(payload: string): string {
  if (Buffer.byteLength(payload, 'utf8') <= MAX_EVENT_PAYLOAD_BYTES)
    return payload;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = null;
  }
  const rec =
    parsed != null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  const truncated: Record<string, unknown> = { truncated: true };
  if ('type' in rec) truncated.type = rec.type;
  if ('usage' in rec) truncated.usage = rec.usage;
  truncated.head = payload.slice(0, HEAD_BYTES);
  return JSON.stringify(truncated);
}

const stmtInsertEvent = db.prepare<
  NewSessionEvent & { message_id: string | null }
>(`
  INSERT INTO session_events (session_id, event_type, payload, timestamp, message_id)
  VALUES (@session_id, @event_type, @payload, @timestamp, @message_id)
`);

const stmtInsertEventOrIgnore = db.prepare<
  NewSessionEvent & { message_id: string | null }
>(`
  INSERT OR IGNORE INTO session_events (session_id, event_type, payload, timestamp, message_id)
  VALUES (@session_id, @event_type, @payload, @timestamp, @message_id)
`);

const stmtUpdateEventPayload = db.prepare<{
  id: number;
  payload: string;
  timestamp: number;
}>(`
  UPDATE session_events SET payload = @payload, timestamp = @timestamp WHERE id = @id
`);

const stmtGetEventsBySession = db.prepare<{ session_id: string }>(`
  SELECT * FROM session_events WHERE session_id = @session_id ORDER BY id ASC
`);

/** Returns the timestamp of the most recent session_events row for the session, or null. */
export function getLatestSessionEventTimestamp(
  sessionId: string,
): number | null {
  const row = db
    .prepare<
      [string],
      { ts: number | null }
    >(`SELECT MAX(timestamp) AS ts FROM session_events WHERE session_id = ?`)
    .get(sessionId);
  return row?.ts ?? null;
}

export function insertEvent(e: NewSessionEvent): void {
  stmtInsertEvent.run({
    message_id: null,
    ...e,
    payload: capEventPayload(e.payload),
  });
}

export function insertEventOrIgnore(e: NewSessionEvent): void {
  stmtInsertEventOrIgnore.run({
    message_id: null,
    ...e,
    payload: capEventPayload(e.payload),
  });
}

/**
 * Upsert a session event keyed on session_id + message_id.
 * If `existingId` is provided, updates the existing row's payload in-place.
 * Otherwise inserts a new row. Returns the row ID in both cases.
 *
 * Defensive guard: if no sessions row exists for e.session_id the INSERT
 * would fail the FK constraint and crash the readline listener (which has no
 * reliable recovery path). Warn-and-return -1 instead so callers stay alive.
 */
export function upsertSessionEvent(
  e: NewSessionEvent & { message_id?: string | null },
  existingId?: number,
): number {
  const cappedPayload = capEventPayload(e.payload);
  if (existingId != null) {
    stmtUpdateEventPayload.run({
      id: existingId,
      payload: cappedPayload,
      timestamp: e.timestamp,
    });
    return existingId;
  }
  const sessionRow = stmtGetSession.get({ session_id: e.session_id });
  if (!sessionRow) {
    logger.error(
      `[upsertSessionEvent] no sessions row for ${e.session_id} — dropping event (type=${e.event_type})`,
    );
    return -1;
  }
  const result = stmtInsertEvent.run({
    message_id: null,
    ...e,
    payload: cappedPayload,
  });
  return result.lastInsertRowid as number;
}

export function getEventsBySession(sessionId: string): SessionEvent[] {
  return stmtGetEventsBySession.all({
    session_id: sessionId,
  }) as SessionEvent[];
}

// ─── permission_events ─────────────────────────────────────────────────────

const stmtInsertPermissionEvent = db.prepare<NewPermissionEvent>(`
  INSERT INTO permission_events
    (session_id, tool_name, proposed_action, decision, rule_matched, decided_at)
  VALUES
    (@session_id, @tool_name, @proposed_action, @decision, @rule_matched, @decided_at)
`);

export function insertPermissionEvent(e: NewPermissionEvent): void {
  stmtInsertPermissionEvent.run(e);
}

export function getRecentPermissionEvents(
  limit: number,
): Array<PermissionEvent & { task_url: string | null }> {
  return db
    .prepare(
      `SELECT pe.*, s.task_url FROM permission_events pe
       LEFT JOIN sessions s ON pe.session_id = s.session_id
       ORDER BY pe.decided_at DESC LIMIT ?`,
    )
    .all(limit) as Array<PermissionEvent & { task_url: string | null }>;
}

const stmtClearPermissionEvents = db.prepare(`DELETE FROM permission_events`);

export function clearPermissionEvents(): void {
  stmtClearPermissionEvents.run();
}

const stmtClearPermissionDenials = db.prepare(`DELETE FROM permission_denials`);

export function clearPermissionDenials(): void {
  stmtClearPermissionDenials.run();
}

// ─── permission_rules ──────────────────────────────────────────────────────

const stmtGetRules = db.prepare(`
  SELECT * FROM permission_rules WHERE enabled = 1 ORDER BY order_index ASC
`);

export function getRules(): PermissionRule[] {
  return stmtGetRules.all() as PermissionRule[];
}

// ─── permission_denials ─────────────────────────────────────────────────────

const stmtInsertPermissionDenial = db.prepare<NewPermissionDenialRow>(`
  INSERT INTO permission_denials (session_id, tool_name, tool_use_id, tool_input, timestamp)
  VALUES (@session_id, @tool_name, @tool_use_id, @tool_input, @timestamp)
`);

const stmtGetDenialsBySession = db.prepare<{ session_id: string }>(`
  SELECT * FROM permission_denials WHERE session_id = @session_id ORDER BY id ASC
`);

export function insertPermissionDenial(d: NewPermissionDenialRow): void {
  stmtInsertPermissionDenial.run(d);
}

export function getDenialsBySession(sessionId: string): PermissionDenialRow[] {
  return stmtGetDenialsBySession.all({
    session_id: sessionId,
  }) as PermissionDenialRow[];
}

export function deleteDenialsBySession(sessionId: string): void {
  db.prepare<{ session_id: string }>(
    `
    DELETE FROM permission_denials WHERE session_id = @session_id
  `,
  ).run({ session_id: sessionId });
}

export function getRecentPermissionDenials(
  limit: number,
): Array<PermissionDenialRow & { task_url: string | null }> {
  return db
    .prepare(
      `SELECT d.*, s.task_url FROM permission_denials d
       LEFT JOIN sessions s ON d.session_id = s.session_id
       ORDER BY d.id DESC LIMIT ?`,
    )
    .all(limit) as Array<PermissionDenialRow & { task_url: string | null }>;
}

// ─── task_cache ────────────────────────────────────────────────────────────

const stmtUpsertTaskCache = db.prepare<{
  task_id: string;
  fetched_at: number;
  raw_json: string;
}>(`
  INSERT INTO task_cache (task_id, fetched_at, raw_json)
  VALUES (@task_id, @fetched_at, @raw_json)
  ON CONFLICT(task_id) DO UPDATE SET
    fetched_at = excluded.fetched_at,
    raw_json   = excluded.raw_json
`);

const stmtGetTaskCache = db.prepare<{ task_id: string }>(`
  SELECT * FROM task_cache WHERE task_id = @task_id
`);

export function updateTaskCacheStatus(taskId: string, status: string): void {
  const row = getTaskCache(taskId);
  if (!row) return;
  try {
    const parsed = JSON.parse(row.raw_json);
    // NotionTask stores status at top-level; raw Notion API uses properties.Status.select.name
    if ('status' in parsed) {
      parsed.status = status;
    } else if (parsed?.properties?.Status?.select) {
      parsed.properties.Status.select.name = status;
    }
    stmtUpsertTaskCache.run({
      task_id: row.task_id,
      fetched_at: row.fetched_at,
      raw_json: JSON.stringify(parsed),
    });
  } catch {
    // If parsing fails, leave cache as-is rather than deleting it
  }
}

export function upsertTaskCache(taskId: string, rawJson: string): void {
  stmtUpsertTaskCache.run({
    task_id: taskId,
    fetched_at: Date.now(),
    raw_json: rawJson,
  });
}

export function getTaskCache(taskId: string): TaskCache | undefined {
  return stmtGetTaskCache.get({ task_id: taskId }) as TaskCache | undefined;
}

export function getCacheAge(taskId: string): number {
  const row = getTaskCache(taskId);
  if (!row) return Infinity;
  return Date.now() - row.fetched_at;
}

export function incrementTokens(
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
): void {
  db.prepare(
    `
    UPDATE sessions
    SET total_input_tokens  = total_input_tokens  + ?,
        total_output_tokens = total_output_tokens + ?
    WHERE session_id = ?
  `,
  ).run(inputTokens, outputTokens, sessionId);
}

export function incrementCompactionCount(sessionId: string): void {
  db.prepare(
    `UPDATE sessions SET compaction_count = compaction_count + 1 WHERE session_id = ?`,
  ).run(sessionId);
}

/**
 * Returns all cached tasks (from task_cache) whose status matches the given display
 * status string. Only returns individual task entries (skips board/page/non-milestone
 * sentinel keys). Prefix filters to a specific task source (e.g. 'notion:').
 */
export function getTasksByStatusFromCache(
  status: string,
  prefix: string,
): { task_id: string; raw_json: string }[] {
  return db
    .prepare(
      `SELECT task_id, raw_json FROM task_cache
       WHERE task_id LIKE ?
         AND JSON_EXTRACT(raw_json, '$.status') = ?`,
    )
    .all(`${prefix}%`, status) as { task_id: string; raw_json: string }[];
}

export function setContextOccupancy(sessionId: string, tokens: number): void {
  db.prepare(
    `UPDATE sessions SET context_occupancy_tokens = ? WHERE session_id = ?`,
  ).run(tokens, sessionId);
}

export function getZeroTokenSessions(limit: number): Session[] {
  return db
    .prepare(
      `
    SELECT * FROM sessions
    WHERE total_input_tokens = 0 AND total_output_tokens = 0
    ORDER BY started_at DESC
    LIMIT ?
  `,
    )
    .all(limit) as Session[];
}

export function getTaskTitleFromCache(taskId: string): string | null {
  const row = getTaskCache(taskId);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.raw_json) as { title?: unknown };
    return typeof parsed.title === 'string' ? parsed.title : null;
  } catch {
    return null;
  }
}

// ─── pull_requests ──────────────────────────────────────────────────────────

export function upsertPullRequest(
  pr: Omit<
    PullRequestRow,
    | 'id'
    | 'review_session_id'
    | 'review_iteration'
    | 'last_reviewed_sha'
    | 'node_id'
    | 'mergeable'
    | 'merge_state'
    | 'merge_state_checked_at'
    | 'failing_checks'
    | 'pending_push'
    | 'pause_reason'
    | 'pause_reason_set_at'
    | 'ci_remediation_attempted_sha'
    | 'pre_review_stage'
  > & {
    review_session_id?: string | null;
    review_iteration?: number;
    last_reviewed_sha?: string | null;
    node_id?: string | null;
    mergeable?: number | null;
    merge_state?: string | null;
    merge_state_checked_at?: string | null;
    failing_checks?: string | null;
    pause_reason?: PullRequestRow['pause_reason'];
  },
): PullRequestRow | null {
  if (!getProjectByGithubRepo(pr.repo)) {
    logger.warn(
      `[upsertPullRequest] rejected: repo "${pr.repo}" not configured in any project — skipping upsert to prevent phantom row (pr_url=${pr.pr_url})`,
    );
    return null;
  }
  db.prepare(
    `
    INSERT INTO pull_requests
      (pr_number, pr_url, task_id, session_id, repo, title, body,
       head_branch, base_branch, state, draft, review_result, review_at,
       created_at, updated_at, synced_at, node_id, head_sha,
       mergeable, merge_state, merge_state_checked_at)
    VALUES
      (@pr_number, @pr_url, @task_id, @session_id, @repo, @title, @body,
       @head_branch, @base_branch, @state, @draft, @review_result, @review_at,
       @created_at, @updated_at, @synced_at, @node_id, @head_sha,
       @mergeable, @merge_state, @merge_state_checked_at)
    ON CONFLICT(pr_url) DO UPDATE SET
      synced_at              = excluded.synced_at,
      state                  = CASE WHEN state IN ('merged', 'closed') THEN state ELSE excluded.state END,
      draft                  = excluded.draft,
      title                  = COALESCE(excluded.title, title),
      body                   = COALESCE(excluded.body, body),
      head_branch            = COALESCE(excluded.head_branch, head_branch),
      base_branch            = COALESCE(excluded.base_branch, base_branch),
      task_id                = COALESCE(excluded.task_id, task_id),
      session_id             = COALESCE(excluded.session_id, session_id),
      updated_at             = excluded.updated_at,
      node_id                = COALESCE(excluded.node_id, node_id),
      head_sha               = COALESCE(excluded.head_sha, head_sha),
      mergeable              = COALESCE(excluded.mergeable, mergeable),
      merge_state            = COALESCE(excluded.merge_state, merge_state),
      merge_state_checked_at = COALESCE(excluded.merge_state_checked_at, merge_state_checked_at)
  `,
  ).run({
    mergeable: null,
    merge_state: null,
    merge_state_checked_at: null,
    ...pr,
  });
  return db
    .prepare<{ pr_url: string }>(
      `
    SELECT * FROM pull_requests WHERE pr_url = @pr_url
  `,
    )
    .get({ pr_url: pr.pr_url }) as PullRequestRow;
}

export function setReviewSessionId(
  prNumber: number,
  repo: string,
  reviewSessionId: string,
): void {
  db.prepare<{ pr_number: number; repo: string; review_session_id: string }>(
    `
    UPDATE pull_requests
    SET review_session_id = @review_session_id
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({ pr_number: prNumber, repo, review_session_id: reviewSessionId });
}

export function incrementReviewIteration(
  prNumber: number,
  repo: string,
): number {
  db.prepare<{ pr_number: number; repo: string }>(
    `
    UPDATE pull_requests
    SET review_iteration = review_iteration + 1
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({ pr_number: prNumber, repo });
  const row = db
    .prepare<{ pr_number: number; repo: string }>(
      `
    SELECT review_iteration FROM pull_requests WHERE pr_number = @pr_number AND repo = @repo
  `,
    )
    .get({ pr_number: prNumber, repo }) as
    | { review_iteration: number }
    | undefined;
  return row?.review_iteration ?? 1;
}

export function setLastReviewedSha(
  prNumber: number,
  repo: string,
  sha: string | null,
): void {
  db.prepare<{
    pr_number: number;
    repo: string;
    last_reviewed_sha: string | null;
  }>(
    `
    UPDATE pull_requests
    SET last_reviewed_sha = @last_reviewed_sha
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({ pr_number: prNumber, repo, last_reviewed_sha: sha });
}

export function setHeadSha(
  prNumber: number,
  repo: string,
  sha: string | null,
): void {
  db.prepare<{ pr_number: number; repo: string; head_sha: string | null }>(
    `
    UPDATE pull_requests
    SET head_sha = @head_sha
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({ pr_number: prNumber, repo, head_sha: sha });
}

export function setPendingPush(
  prNumber: number,
  repo: string,
  value: 0 | 1,
): void {
  db.prepare<{ pr_number: number; repo: string; pending_push: number }>(
    `
    UPDATE pull_requests SET pending_push = @pending_push WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({ pr_number: prNumber, repo, pending_push: value });
}

export function getPRBySessionId(sessionId: string): PullRequestRow | null {
  return db
    .prepare<{ session_id: string }>(
      `
    SELECT * FROM pull_requests WHERE session_id = @session_id LIMIT 1
  `,
    )
    .get({ session_id: sessionId }) as PullRequestRow | null;
}

function getPRByTaskId(taskId: string): PullRequestRow | null {
  return db
    .prepare<{ task_id: string }>(
      `
    SELECT * FROM pull_requests WHERE task_id = @task_id ORDER BY pr_number DESC LIMIT 1
  `,
    )
    .get({ task_id: taskId }) as PullRequestRow | null;
}

export const getPRByNotionTaskId = getPRByTaskId;

/**
 * Returns the most recent merged PR for a task, or null if none exists.
 * Used by AutoLauncher to skip tasks whose PR was already merged but whose
 * Notion status wasn't updated (e.g. the merge-handler fired silently).
 */
export function getMergedPRForTask(taskId: string): PullRequestRow | null {
  return db
    .prepare<{
      task_id: string;
    }>(
      `SELECT * FROM pull_requests WHERE task_id = @task_id AND state = 'merged' ORDER BY pr_number DESC LIMIT 1`,
    )
    .get({ task_id: taskId }) as PullRequestRow | null;
}

export function getPRs(repo: string): PullRequestRow[] {
  return db
    .prepare<{ repo: string }>(
      `
    SELECT * FROM pull_requests WHERE repo = @repo ORDER BY pr_number DESC
  `,
    )
    .all({ repo }) as PullRequestRow[];
}

export function getPRByNumber(
  prNumber: number,
  repo: string,
): PullRequestRow | null {
  return db
    .prepare<{ pr_number: number; repo: string }>(
      `
    SELECT * FROM pull_requests WHERE pr_number = @pr_number AND repo = @repo
  `,
    )
    .get({ pr_number: prNumber, repo }) as PullRequestRow | null;
}

/**
 * Persist a JSON-encoded review result for a PR. Valid verdict values are:
 * 'approved' | 'needs_changes' | 'incomplete' | 'error' | 'verify_failed' | 'autofix_failed'
 * Gate failure verdicts (verify_failed, autofix_failed) are set by ReviewOrchestrator
 * before any review session is spawned and do not consume a review iteration.
 */
export function setPRReviewResult(
  prNumber: number,
  repo: string,
  result: string,
): void {
  db.prepare<{
    pr_number: number;
    repo: string;
    review_result: string;
    review_at: string;
  }>(
    `
    UPDATE pull_requests
    SET review_result = @review_result, review_at = @review_at
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({
    pr_number: prNumber,
    repo,
    review_result: result,
    review_at: new Date().toISOString(),
  });
}

export function updatePRDraftStatus(
  prNumber: number,
  repo: string,
  draft: number,
): void {
  db.prepare<{ pr_number: number; repo: string; draft: number }>(
    `
    UPDATE pull_requests SET draft = @draft WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({ pr_number: prNumber, repo, draft });
}

export function updatePRState(
  prNumber: number,
  repo: string,
  state: string,
): void {
  db.prepare<{ pr_number: number; repo: string; state: string }>(
    `
    UPDATE pull_requests SET state = @state WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({ pr_number: prNumber, repo, state });
}

export function setPreReviewStage(
  prNumber: number,
  repo: string,
  stage: string | null,
): void {
  db.prepare<{ pr_number: number; repo: string; stage: string | null }>(
    `UPDATE pull_requests SET pre_review_stage = @stage WHERE pr_number = @pr_number AND repo = @repo`,
  ).run({ pr_number: prNumber, repo, stage });
}

export function deletePR(prNumber: number, repo: string): boolean {
  const result = db
    .prepare<{ pr_number: number; repo: string }>(
      `
    DELETE FROM pull_requests WHERE pr_number = @pr_number AND repo = @repo
  `,
    )
    .run({ pr_number: prNumber, repo });
  return result.changes > 0;
}

// ─── branch → session linkage ───────────────────────────────────────────────

export interface SessionBranchMatch {
  session_id: string;
  task_id: string | null;
}

/**
 * Attempt to derive a session from a PR's head_branch by matching against
 * sessions.worktree_path. Returns the match when exactly one session path
 * contains the branch name. Logs a warning and returns null for zero or
 * multiple matches.
 */
export function lookupSessionByBranch(
  headBranch: string,
): SessionBranchMatch | null {
  const rows = db
    .prepare<{ pattern: string }>(
      `SELECT session_id, task_id FROM sessions
       WHERE worktree_path LIKE @pattern`,
    )
    .all({ pattern: `%${headBranch}%` }) as SessionBranchMatch[];

  if (rows.length === 1) {
    return rows[0];
  }
  if (rows.length === 0) {
    logger.warn(
      `[lookupSessionByBranch] no session found for branch "${headBranch}"`,
    );
  } else {
    const ids = rows.map((r) => r.session_id.slice(0, 8)).join(', ');
    logger.warn(
      `[lookupSessionByBranch] ambiguous: ${rows.length} sessions match branch "${headBranch}" (${ids}) — leaving session_id null`,
    );
  }
  return null;
}

// ─── settings ────────────────────────────────────────────────────────────────

export function getSetting(key: string): string | undefined {
  const row = db
    .prepare<{ key: string }>(`SELECT value FROM settings WHERE key = @key`)
    .get({ key }) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare<{ key: string; value: string }>(
    `
    INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `,
  ).run({ key, value });
}

export function getAllSettings(): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ─── session_audits ──────────────────────────────────────────────────────────

export interface SessionAuditRow {
  id: number;
  session_id: string;
  pr_opened: number;
  pr_targets: string | null;
  task_status: string | null;
  violations: string;
  spec_mismatch: string | null;
  audited_at: string;
}

export function insertSessionAudit(row: Omit<SessionAuditRow, 'id'>): void {
  db.prepare<Omit<SessionAuditRow, 'id'>>(
    `
    INSERT INTO session_audits
      (session_id, pr_opened, pr_targets, task_status, violations, spec_mismatch, audited_at)
    VALUES
      (@session_id, @pr_opened, @pr_targets, @task_status, @violations, @spec_mismatch, @audited_at)
  `,
  ).run(row);
}

export function updateMergeState(
  prNumber: number,
  repo: string,
  mergeable: number | null,
  mergeState: string | null,
  failingChecks: string[] | null = null,
): void {
  const failingChecksJson =
    failingChecks && failingChecks.length > 0
      ? JSON.stringify(failingChecks)
      : null;
  db.prepare<{
    pr_number: number;
    repo: string;
    mergeable: number | null;
    merge_state: string | null;
    checked_at: string;
    failing_checks: string | null;
  }>(
    `
    UPDATE pull_requests
    SET mergeable = @mergeable,
        merge_state = @merge_state,
        merge_state_checked_at = @checked_at,
        failing_checks = @failing_checks
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({
    pr_number: prNumber,
    repo,
    mergeable,
    merge_state: mergeState,
    checked_at: new Date().toISOString(),
    failing_checks: failingChecksJson,
  });
}

/**
 * Reset the review counter and clear any pause_reason on a PR row. Called from
 * the re-review pathway in routes/prs.ts; clearing pause_reason here is what
 * lets the stuck-session resume mechanism unblock auto-launch and auto-merge
 * via the same call that resets the iteration counter.
 */
export function resetReviewIteration(prNumber: number, repo: string): void {
  db.prepare<{ pr_number: number; repo: string }>(
    `
    UPDATE pull_requests
    SET review_iteration = 0, pause_reason = NULL
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({ pr_number: prNumber, repo });
}

export function setCiRemediationAttemptedSha(
  prNumber: number,
  repo: string,
  sha: string | null,
): void {
  db.prepare(
    `UPDATE pull_requests SET ci_remediation_attempted_sha = ? WHERE pr_number = ? AND repo = ?`,
  ).run(sha, prNumber, repo);
}

export function setConflictNudgeSha(
  prNumber: number,
  repo: string,
  sha: string,
): void {
  db.prepare(
    `UPDATE pull_requests SET conflict_nudge_sha = ? WHERE pr_number = ? AND repo = ?`,
  ).run(sha, prNumber, repo);
}

export function setPauseReason(
  prNumber: number,
  repo: string,
  reason: PauseReason | null,
  detail?: string,
): void {
  const serialized =
    reason !== null
      ? serializePauseReason(pauseReasonFromCanonical(reason, detail))
      : null;
  db.prepare<{
    pr_number: number;
    repo: string;
    pause_reason: string | null;
    pause_reason_set_at: number | null;
  }>(
    `
    UPDATE pull_requests
    SET pause_reason = @pause_reason,
        pause_reason_set_at = @pause_reason_set_at
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({
    pr_number: prNumber,
    repo,
    pause_reason: serialized,
    pause_reason_set_at: reason !== null ? Date.now() : null,
  });
}

/**
 * PRs that are open, approved, mergeable=1, merge_state='clean', and have no
 * pause_reason — i.e. orphaned merge-ready rows that AutoMerger missed because
 * they were already in this state before the backend started.
 */
export function getOrphanMergeablePRs(): Array<{
  pr_number: number;
  repo: string;
}> {
  return db
    .prepare(
      `
    SELECT pr_number, repo FROM pull_requests
    WHERE state = 'open'
      AND mergeable = 1
      AND merge_state = 'clean'
      AND pause_reason IS NULL
      AND review_result IS NOT NULL
      AND json_extract(review_result, '$.verdict') = 'approved'
  `,
    )
    .all() as Array<{ pr_number: number; repo: string }>;
}

/**
 * PRs with pause_reason='auto_merge_failed' whose pause_reason_set_at is older
 * than thresholdMs milliseconds ago. These are stale transient failures eligible
 * for automatic retry.
 */
export function getStaleAutoMergeFailedPRs(thresholdMs: number): Array<{
  pr_number: number;
  repo: string;
}> {
  const cutoff = Date.now() - thresholdMs;
  return db
    .prepare(
      `
    SELECT pr_number, repo FROM pull_requests
    WHERE state = 'open'
      AND (pause_reason = 'auto_merge_failed' OR json_extract(pause_reason, '$.reason') = 'auto_merge_failed')
      AND pause_reason_set_at IS NOT NULL
      AND pause_reason_set_at < @cutoff
  `,
    )
    .all({ cutoff }) as Array<{ pr_number: number; repo: string }>;
}

/**
 * Open PRs that may need a catch-up conflict/rebase nudge:
 * - pause_reason='auto_merge_failed': stalled by a blocked/behind merge that
 *   may not have been notified (e.g. pre-fix pauses or failed deliveries).
 * - pause_reason IS NULL, merge_state IN ('dirty','blocked'): PRMergeWatcher
 *   recorded the conflict but the transition-gated nudge was never sent.
 * Both cases require session_id, head_sha, and that the current head_sha has
 * not already been nudged (dedup via conflict_nudge_sha).
 */
export function getConflictNudgeCandidates(): Array<{
  pr_number: number;
  repo: string;
}> {
  return db
    .prepare(
      `
    SELECT pr_number, repo FROM pull_requests
    WHERE state = 'open'
      AND session_id IS NOT NULL
      AND head_sha IS NOT NULL
      AND (conflict_nudge_sha IS NULL OR head_sha != conflict_nudge_sha)
      AND (
        pause_reason = 'auto_merge_failed'
        OR json_extract(pause_reason, '$.reason') = 'auto_merge_failed'
        OR (pause_reason IS NULL AND merge_state IN ('dirty', 'blocked'))
      )
  `,
    )
    .all() as Array<{ pr_number: number; repo: string }>;
}

/**
 * Returns the pause_reason of the most recent PR for the given task id,
 * or null if no PR exists or the PR is not paused. Used by auto-runner
 * components to skip tasks paused by stuck_timeout (or any other reason).
 */
export function getPausedPrReasonForTask(
  taskId: string,
): PauseReasonStruct | null {
  const row = db
    .prepare<{ task_id: string }>(
      `
    SELECT pause_reason FROM pull_requests
    WHERE task_id = @task_id
      AND pause_reason IS NOT NULL
    ORDER BY pr_number DESC
    LIMIT 1
  `,
    )
    .get({ task_id: taskId }) as { pause_reason: string | null } | undefined;
  return parsePauseReason(row?.pause_reason ?? null);
}

// ─── task_pause_reasons ────────────────────────────────────────────────────────

/**
 * Persist a task-level pause reason for tasks that have no PR yet (e.g. launch_failed).
 * Replaces any existing entry for the same task_id.
 */
export function setTaskPauseReason(
  taskId: string,
  reason: PauseReason,
  detail: string,
): void {
  const serialized = serializePauseReason(
    pauseReasonFromCanonical(reason, detail || undefined),
  );
  db.prepare<{
    task_id: string;
    pause_reason: string;
    detail: string;
    set_at: number;
  }>(
    `INSERT OR REPLACE INTO task_pause_reasons (task_id, pause_reason, detail, set_at)
     VALUES (@task_id, @pause_reason, @detail, @set_at)`,
  ).run({
    task_id: taskId,
    pause_reason: serialized,
    detail,
    set_at: Date.now(),
  });
}

/** Returns the task-level pause reason struct, or null if none is set. */
export function getTaskPauseReason(taskId: string): PauseReasonStruct | null {
  const row = db
    .prepare<{
      task_id: string;
    }>(`SELECT pause_reason FROM task_pause_reasons WHERE task_id = @task_id`)
    .get({ task_id: taskId }) as { pause_reason: string } | undefined;
  return parsePauseReason(row?.pause_reason ?? null);
}

/** Clear a task-level pause reason (e.g. on successful launch). */
export function clearTaskPauseReason(taskId: string): void {
  db.prepare<{ task_id: string }>(
    `DELETE FROM task_pause_reasons WHERE task_id = @task_id`,
  ).run({ task_id: taskId });
}

/**
 * Approved + open PRs that are eligible to be auto-merged. Excludes PRs paused
 * via any pause_reason (e.g. stuck_timeout) so the Auto-merger skips tasks that
 * a human needs to look at first — see AC under "Stuck session timer".
 */
export function getApprovedOpenPRs(): PullRequestRow[] {
  return db
    .prepare(
      `
    SELECT * FROM pull_requests
    WHERE state = 'open'
      AND review_result LIKE '%approved%'
      AND pause_reason IS NULL
  `,
    )
    .all() as PullRequestRow[];
}

export function getAllOpenPRs(): PullRequestRow[] {
  return db
    .prepare(
      `
    SELECT * FROM pull_requests WHERE state = 'open'
  `,
    )
    .all() as PullRequestRow[];
}

export interface IdleSessionWithResolvedPR {
  session_id: string;
  task_id: string | null;
  project_id: string | null;
  pr_state: string;
  pr_number: number;
  repo: string;
  pr_url: string | null;
}

/**
 * Returns idle sessions that have a linked PR already in a terminal state
 * (merged or closed). Used by the boot-time reconciliation pass to apply
 * session terminal transitions for PRs that resolved while the server was down.
 */
export function getIdleSessionsWithResolvedPRs(): IdleSessionWithResolvedPR[] {
  return db
    .prepare(
      `
    SELECT s.session_id, s.task_id, s.project_id,
           pr.state AS pr_state, pr.pr_number, pr.repo, pr.pr_url
    FROM sessions s
    JOIN pull_requests pr ON pr.session_id = s.session_id
    WHERE s.status = 'idle'
      AND pr.state IN ('merged', 'closed')
  `,
    )
    .all() as IdleSessionWithResolvedPR[];
}

/**
 * Returns eligible PRs for the bulk-merge button: open, approved verdict,
 * not paused, and mergeable=1, scoped to the given project's milestone.
 */
export function getMergeReadyPRs(
  projectId: string,
  milestoneId: string,
): PullRequestRow[] {
  // Resolve milestone source_id to build the board cache key.
  const milestone = db
    .prepare<{
      id: string;
      project_id: string;
    }>(
      `SELECT source_id FROM milestones WHERE id = @id AND project_id = @project_id`,
    )
    .get({ id: milestoneId, project_id: projectId }) as
    | { source_id: string | null }
    | undefined;

  if (!milestone) return [];

  const boardKey = milestone.source_id ?? milestoneId;
  const cacheKey = `board:${boardKey}`;

  const boardCache = db
    .prepare<{
      task_id: string;
    }>(`SELECT raw_json FROM task_cache WHERE task_id = @task_id`)
    .get({ task_id: cacheKey }) as { raw_json: string } | undefined;

  if (!boardCache) return [];

  let taskIds: string[];
  try {
    const tasks = JSON.parse(boardCache.raw_json) as { id: string }[];
    taskIds = tasks.map((t) => `notion:${t.id}`);
  } catch {
    return [];
  }

  if (taskIds.length === 0) return [];

  const placeholders = taskIds.map(() => '?').join(', ');
  return db
    .prepare(
      `
    SELECT * FROM pull_requests
    WHERE state = 'open'
      AND pause_reason IS NULL
      AND mergeable = 1
      AND JSON_EXTRACT(review_result, '$.verdict') = 'approved'
      AND task_id IN (${placeholders})
  `,
    )
    .all(...taskIds) as PullRequestRow[];
}

// ─── task aggregation ─────────────────────────────────────────────────────────

export interface TaskAggregateRow {
  task_id: string;
  raw_json: string;
  // code session (session_type = 'standard')
  code_session_id: string | null;
  code_session_status: string | null;
  code_session_started_at: number | null;
  code_session_ended_at: number | null;
  code_session_input_tokens: number | null;
  code_session_output_tokens: number | null;
  code_session_last_event_payload: string | null;
  code_session_context_occupancy_tokens: number | null;
  code_session_compaction_count: number | null;
  code_session_model: string | null;
  code_session_type: string | null;
  // review session (session_type = 'review')
  review_session_id: string | null;
  review_session_status: string | null;
  review_session_input_tokens: number | null;
  review_session_output_tokens: number | null;
  review_session_result: string | null; // sessions.review_result (local-only fallback)
  // pull request
  pr_number: number | null;
  pr_url: string | null;
  pr_title: string | null;
  pr_head_branch: string | null;
  pr_base_branch: string | null;
  pr_state: string | null;
  pr_draft: number | null;
  pr_review_result: string | null;
  pr_review_iteration: number | null;
  pr_merge_state: string | null;
  pr_pause_reason: string | null;
  pr_pre_review_stage: string | null;
  session_pr_creation_failed_pause_reason: string | null;
}

export function getActiveTaskAggregates(taskIds: string[]): TaskAggregateRow[] {
  if (taskIds.length === 0) return [];
  const placeholders = taskIds.map(() => '?').join(', ');
  // Single query using window functions (ROW_NUMBER) to pick the latest code session,
  // review session, and PR per task — avoids N×3 correlated subqueries.
  // The inline event-payload subquery runs once per matched code session and is
  // O(1) with idx_session_events_session_id_id covering (session_id, id DESC).
  // Direct task_id comparison allows idx_sessions_notion_task_id_session_type and
  // idx_pull_requests_task_id_pr_number to be used by the query planner.
  return db
    .prepare(
      `
    WITH
      ranked_code AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY task_id
            ORDER BY started_at DESC
          ) AS rn
        FROM sessions
        WHERE session_type = 'standard' OR session_type IS NULL
      ),
      ranked_review AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY task_id
            ORDER BY started_at DESC
          ) AS rn
        FROM sessions
        WHERE session_type = 'review'
      ),
      ranked_pr AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY task_id
            ORDER BY pr_number DESC
          ) AS rn
        FROM pull_requests
      )
    SELECT
      tc.task_id,
      tc.raw_json,
      cs.session_id          AS code_session_id,
      cs.status              AS code_session_status,
      cs.started_at          AS code_session_started_at,
      cs.ended_at            AS code_session_ended_at,
      cs.total_input_tokens        AS code_session_input_tokens,
      cs.total_output_tokens       AS code_session_output_tokens,
      (
        SELECT payload FROM session_events
        WHERE session_id = cs.session_id
          AND event_type IN ('text', 'tool_use', 'tool_result', 'error')
        ORDER BY id DESC LIMIT 1
      )                            AS code_session_last_event_payload,
      cs.context_occupancy_tokens  AS code_session_context_occupancy_tokens,
      cs.compaction_count          AS code_session_compaction_count,
      cs.model                     AS code_session_model,
      cs.session_type              AS code_session_type,
      rs.session_id          AS review_session_id,
      rs.status              AS review_session_status,
      rs.total_input_tokens  AS review_session_input_tokens,
      rs.total_output_tokens AS review_session_output_tokens,
      rs.review_result       AS review_session_result,
      pr.pr_number,
      pr.pr_url,
      pr.title               AS pr_title,
      pr.head_branch         AS pr_head_branch,
      pr.base_branch         AS pr_base_branch,
      pr.state               AS pr_state,
      pr.draft               AS pr_draft,
      pr.review_result       AS pr_review_result,
      pr.review_iteration    AS pr_review_iteration,
      pr.merge_state         AS pr_merge_state,
      pr.pause_reason        AS pr_pause_reason,
      pr.pre_review_stage    AS pr_pre_review_stage,
      CASE
        WHEN pr.pr_number IS NULL
          AND cs.pause_reason IN ('pr_creation_failed', 'stalled_idle')
        THEN cs.pause_reason
        ELSE NULL
      END                    AS session_pr_creation_failed_pause_reason
    FROM task_cache tc
    LEFT JOIN ranked_code cs ON cs.task_id = tc.task_id AND cs.rn = 1
    LEFT JOIN ranked_review rs ON rs.task_id = tc.task_id AND rs.rn = 1
    LEFT JOIN ranked_pr pr ON pr.task_id = tc.task_id AND pr.rn = 1
    WHERE tc.task_id IN (${placeholders})
    ORDER BY tc.fetched_at DESC
  `,
    )
    .all(...taskIds) as TaskAggregateRow[];
}

/** Returns the most recent standard (non-review) session for a given task ID. */
export function getLatestCodeSessionByNotionTaskId(
  taskId: string,
): Session | undefined {
  return db
    .prepare<{ task_id: string }>(
      `
    SELECT * FROM sessions
    WHERE task_id = @task_id AND (session_type = 'standard' OR session_type IS NULL)
    ORDER BY started_at DESC
    LIMIT 1
  `,
    )
    .get({ task_id: taskId }) as Session | undefined;
}

// ─── projects ──────────────────────────────────────────────────────────────

export function insertProject(p: NewProjectRow): ProjectRow {
  const now = Date.now();
  db.prepare<NewProjectRow>(
    `
    INSERT INTO projects
      (id, name, project_dir, context_url, github_repo, task_source, git_mode,
       auto_launch_enabled, auto_launch_milestone_id, auto_merge_enabled,
       task_source_config, base_branch,
       created_at, updated_at)
    VALUES
      (@id, @name, @project_dir, @context_url, @github_repo, @task_source, @git_mode,
       @auto_launch_enabled, @auto_launch_milestone_id, @auto_merge_enabled,
       @task_source_config, @base_branch,
       @created_at, @updated_at)
  `,
  ).run({
    ...p,
    git_mode: p.git_mode ?? 'github',
    auto_launch_enabled: p.auto_launch_enabled ?? 0,
    auto_launch_milestone_id: p.auto_launch_milestone_id ?? null,
    auto_merge_enabled: p.auto_merge_enabled ?? 0,
    task_source_config: p.task_source_config ?? null,
    base_branch: p.base_branch ?? 'dev',
    created_at: p.created_at ?? now,
    updated_at: p.updated_at ?? now,
  });
  return getProjectRowById(p.id)!;
}

export function getProjectRowById(id: string): ProjectRow | undefined {
  return db
    .prepare<{ id: string }>(`SELECT * FROM projects WHERE id = @id`)
    .get({ id }) as ProjectRow | undefined;
}

function getProjectByGithubRepo(githubRepo: string): ProjectRow | undefined {
  return db
    .prepare<{
      github_repo: string;
    }>(`SELECT * FROM projects WHERE github_repo = @github_repo LIMIT 1`)
    .get({ github_repo: githubRepo }) as ProjectRow | undefined;
}

export function listProjectRows(): ProjectRow[] {
  return db
    .prepare(`SELECT * FROM projects ORDER BY created_at ASC`)
    .all() as ProjectRow[];
}

export function countProjects(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as {
    n: number;
  };
  return row.n;
}

export interface ProjectPatch {
  name?: string;
  project_dir?: string;
  context_url?: string | null;
  github_repo?: string | null;
  task_source?: 'notion' | 'yaml' | 'jira' | 'github';
  git_mode?: 'github' | 'local-only';
  auto_launch_enabled?: number;
  auto_launch_milestone_id?: string | null;
  auto_merge_enabled?: number;
  milestone_branching?: 'two_tier' | 'flat' | null;
  non_milestone_source_config?: string | null;
  task_source_config?: string | null;
  data_residency_confirmed?: number;
  base_branch?: string;
}

export function updateProject(
  id: string,
  patch: ProjectPatch,
): ProjectRow | undefined {
  const existing = getProjectRowById(id);
  if (!existing) return undefined;
  const now = Date.now();
  db.prepare<{
    id: string;
    name: string;
    project_dir: string;
    context_url: string | null;
    github_repo: string | null;
    task_source: string;
    git_mode: string;
    auto_launch_enabled: number;
    auto_launch_milestone_id: string | null;
    auto_merge_enabled: number;
    milestone_branching: string | null;
    non_milestone_source_config: string | null;
    task_source_config: string | null;
    data_residency_confirmed: number;
    base_branch: string;
    updated_at: number;
  }>(
    `
    UPDATE projects
    SET name = @name,
        project_dir = @project_dir,
        context_url = @context_url,
        github_repo = @github_repo,
        task_source = @task_source,
        git_mode = @git_mode,
        auto_launch_enabled = @auto_launch_enabled,
        auto_launch_milestone_id = @auto_launch_milestone_id,
        auto_merge_enabled = @auto_merge_enabled,
        milestone_branching = @milestone_branching,
        non_milestone_source_config = @non_milestone_source_config,
        task_source_config = @task_source_config,
        data_residency_confirmed = @data_residency_confirmed,
        base_branch = @base_branch,
        updated_at = @updated_at
    WHERE id = @id
  `,
  ).run({
    id,
    name: patch.name ?? existing.name,
    project_dir: patch.project_dir ?? existing.project_dir,
    context_url:
      patch.context_url !== undefined
        ? patch.context_url
        : existing.context_url,
    github_repo:
      patch.github_repo !== undefined
        ? patch.github_repo
        : existing.github_repo,
    task_source: patch.task_source ?? existing.task_source,
    git_mode: patch.git_mode ?? existing.git_mode ?? 'github',
    auto_launch_enabled:
      patch.auto_launch_enabled !== undefined
        ? patch.auto_launch_enabled
        : existing.auto_launch_enabled,
    auto_launch_milestone_id:
      patch.auto_launch_milestone_id !== undefined
        ? patch.auto_launch_milestone_id
        : existing.auto_launch_milestone_id,
    auto_merge_enabled:
      patch.auto_merge_enabled !== undefined
        ? patch.auto_merge_enabled
        : existing.auto_merge_enabled,
    milestone_branching:
      'milestone_branching' in patch
        ? (patch.milestone_branching ?? null)
        : (existing.milestone_branching ?? null),
    non_milestone_source_config:
      'non_milestone_source_config' in patch
        ? (patch.non_milestone_source_config ?? null)
        : (existing.non_milestone_source_config ?? null),
    task_source_config:
      'task_source_config' in patch
        ? (patch.task_source_config ?? null)
        : (existing.task_source_config ?? null),
    data_residency_confirmed:
      patch.data_residency_confirmed !== undefined
        ? patch.data_residency_confirmed
        : (existing.data_residency_confirmed ?? 0),
    base_branch: patch.base_branch ?? existing.base_branch ?? 'dev',
    updated_at: now,
  });
  return getProjectRowById(id);
}

export function deleteProject(id: string): boolean {
  const result = db
    .prepare<{ id: string }>(`DELETE FROM projects WHERE id = @id`)
    .run({ id });
  return result.changes > 0;
}

// ─── milestones ────────────────────────────────────────────────────────────

export function insertMilestone(m: NewMilestoneRow): MilestoneRow {
  const now = Date.now();
  db.prepare<NewMilestoneRow>(
    `
    INSERT INTO milestones
      (id, project_id, name, source_id, display_order, created_at, updated_at)
    VALUES
      (@id, @project_id, @name, @source_id, @display_order, @created_at, @updated_at)
  `,
  ).run({
    ...m,
    display_order: m.display_order ?? 0,
    created_at: m.created_at ?? now,
    updated_at: m.updated_at ?? now,
  });
  return getMilestoneById(m.id)!;
}

export function getMilestoneById(id: string): MilestoneRow | undefined {
  return db
    .prepare<{ id: string }>(`SELECT * FROM milestones WHERE id = @id`)
    .get({ id }) as MilestoneRow | undefined;
}

export function listMilestonesByProject(projectId: string): MilestoneRow[] {
  return db
    .prepare<{ project_id: string }>(
      `
    SELECT * FROM milestones
    WHERE project_id = @project_id
    ORDER BY display_order ASC, created_at ASC
  `,
    )
    .all({ project_id: projectId }) as MilestoneRow[];
}

export interface MilestonePatch {
  name?: string;
  source_id?: string | null;
  display_order?: number;
}

export function updateMilestone(
  id: string,
  patch: MilestonePatch,
): MilestoneRow | undefined {
  const existing = getMilestoneById(id);
  if (!existing) return undefined;
  const now = Date.now();
  db.prepare<{
    id: string;
    name: string;
    source_id: string | null;
    display_order: number;
    updated_at: number;
  }>(
    `
    UPDATE milestones
    SET name = @name,
        source_id = @source_id,
        display_order = @display_order,
        updated_at = @updated_at
    WHERE id = @id
  `,
  ).run({
    id,
    name: patch.name ?? existing.name,
    source_id:
      patch.source_id !== undefined ? patch.source_id : existing.source_id,
    display_order: patch.display_order ?? existing.display_order,
    updated_at: now,
  });
  return getMilestoneById(id);
}

export function deleteMilestone(id: string): boolean {
  const result = db
    .prepare<{ id: string }>(`DELETE FROM milestones WHERE id = @id`)
    .run({ id });
  return result.changes > 0;
}

// ─── local_branches ────────────────────────────────────────────────────────

export function insertLocalBranch(row: NewLocalBranchRow): LocalBranchRow {
  const result = db
    .prepare(
      `INSERT INTO local_branches
        (project_id, session_id, branch_name, base_branch, status, review_result, created_at, updated_at)
       VALUES
        (@project_id, @session_id, @branch_name, @base_branch, @status, @review_result, @created_at, @updated_at)`,
    )
    .run(row);
  return getLocalBranchById(result.lastInsertRowid as number)!;
}

export function getLocalBranchById(id: number): LocalBranchRow | undefined {
  return db.prepare(`SELECT * FROM local_branches WHERE id = ?`).get(id) as
    | LocalBranchRow
    | undefined;
}

export function getLocalBranchBySession(
  sessionId: string,
): LocalBranchRow | undefined {
  return db
    .prepare(`SELECT * FROM local_branches WHERE session_id = ? LIMIT 1`)
    .get(sessionId) as LocalBranchRow | undefined;
}

export function setLocalBranchReviewResult(
  id: number,
  reviewResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE local_branches SET review_result = ?, updated_at = ? WHERE id = ?`,
  ).run(reviewResult, now, id);
}

export function setLocalBranchPauseReason(
  id: number,
  reason: PauseReason | null,
  detail?: string,
): void {
  const serialized =
    reason !== null
      ? serializePauseReason(pauseReasonFromCanonical(reason, detail))
      : null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE local_branches SET pause_reason = ?, updated_at = ? WHERE id = ?`,
  ).run(serialized, now, id);
}

/**
 * Approved open local branches eligible for auto-merge. Only returns rows where
 * the associated project has auto_merge_enabled = 1, review verdict is 'approved',
 * and no pause_reason is set.
 */
export function getApprovedLocalBranches(): LocalBranchRow[] {
  return db
    .prepare(
      `
    SELECT lb.* FROM local_branches lb
    JOIN projects p ON lb.project_id = p.id
    WHERE lb.status = 'open'
      AND lb.review_result LIKE '%approved%'
      AND lb.pause_reason IS NULL
      AND p.auto_merge_enabled = 1
  `,
    )
    .all() as LocalBranchRow[];
}

export function markLocalBranchMerged(
  id: number,
  commitSha: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE local_branches SET status = 'merged', merge_commit_sha = ?, updated_at = ? WHERE id = ?`,
  ).run(commitSha ?? null, now, id);
}

// ─── pr_review_comments_routed ────────────────────────────────────────────────

export function getRoutedCommentIds(
  prNumber: number,
  repo: string,
): Set<string> {
  const rows = db
    .prepare<{
      pr_number: number;
      repo: string;
    }>(
      `SELECT comment_id FROM pr_review_comments_routed WHERE pr_number = @pr_number AND repo = @repo`,
    )
    .all({ pr_number: prNumber, repo }) as { comment_id: string }[];
  return new Set(rows.map((r) => r.comment_id));
}

export function markCommentsRouted(
  prNumber: number,
  repo: string,
  commentIds: string[],
): void {
  if (commentIds.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare<{
    pr_number: number;
    repo: string;
    comment_id: string;
    routed_at: number;
  }>(
    `INSERT OR IGNORE INTO pr_review_comments_routed (pr_number, repo, comment_id, routed_at)
     VALUES (@pr_number, @repo, @comment_id, @routed_at)`,
  );
  for (const comment_id of commentIds) {
    stmt.run({ pr_number: prNumber, repo, comment_id, routed_at: now });
  }
}

// ─── devices ────────────────────────────────────────────────────────────────

export function insertDevice(device: NewDeviceRow): void {
  db.prepare<NewDeviceRow>(
    `
    INSERT INTO devices (id, name, user_agent, last_ip, last_seen, enrolled_at, token, revoked)
    VALUES (@id, @name, @user_agent, @last_ip, @last_seen, @enrolled_at, @token, @revoked)
  `,
  ).run({
    last_seen: null,
    revoked: 0,
    ...device,
  });
}

export function getDeviceByToken(token: string): DeviceRow | null {
  return (
    (db
      .prepare<{
        token: string;
      }>(`SELECT * FROM devices WHERE token = @token AND revoked = 0`)
      .get({ token }) as DeviceRow | undefined) ?? null
  );
}

export function getDeviceById(id: string): DeviceRow | null {
  return (
    (db
      .prepare<{ id: string }>(`SELECT * FROM devices WHERE id = @id`)
      .get({ id }) as DeviceRow | undefined) ?? null
  );
}

export function listDevices(): DeviceRow[] {
  return db
    .prepare(`SELECT * FROM devices ORDER BY enrolled_at DESC`)
    .all() as DeviceRow[];
}

export function updateDeviceName(id: string, name: string): void {
  db.prepare<{ id: string; name: string }>(
    `UPDATE devices SET name = @name WHERE id = @id`,
  ).run({ id, name });
}

export function revokeDevice(id: string): void {
  db.prepare<{ id: string }>(
    `UPDATE devices SET revoked = 1 WHERE id = @id`,
  ).run({ id });
}

export function updateDeviceLastSeen(
  id: string,
  lastIp: string | null,
  lastSeen: number,
): void {
  db.prepare<{
    id: string;
    last_ip: string | null;
    last_seen: number;
  }>(
    `UPDATE devices SET last_ip = @last_ip, last_seen = @last_seen WHERE id = @id`,
  ).run({
    id,
    last_ip: lastIp,
    last_seen: lastSeen,
  });
}

export function getActiveDeviceCount(): number {
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM devices WHERE revoked = 0`)
    .get() as { count: number };
  return row.count;
}

// ─── orchestrator_autofix_shas ────────────────────────────────────────────────

export function addAutofixSha(
  prNumber: number,
  repo: string,
  sha: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO orchestrator_autofix_shas (pr_number, repo, sha, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(prNumber, repo, sha, new Date().toISOString());
}

export function consumeAutofixSha(
  prNumber: number,
  repo: string,
  sha: string,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM orchestrator_autofix_shas WHERE pr_number = ? AND repo = ? AND sha = ?`,
    )
    .run(prNumber, repo, sha);
  return result.changes > 0;
}

export function deleteAllAutofixShasForPR(
  prNumber: number,
  repo: string,
): void {
  db.prepare(
    `DELETE FROM orchestrator_autofix_shas WHERE pr_number = ? AND repo = ?`,
  ).run(prNumber, repo);
}

// ─── pending_review_sync ───────────────────────────────────────────────────────

export interface PendingReviewSyncRow {
  pr_number: number;
  repo: string;
  sync_state: string;
}

export function insertPendingReviewSync(prNumber: number, repo: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO pending_review_sync (pr_number, repo, sync_state) VALUES (?, ?, 'pending')`,
  ).run(prNumber, repo);
}

export function deletePendingReviewSync(prNumber: number, repo: string): void {
  db.prepare(
    `DELETE FROM pending_review_sync WHERE pr_number = ? AND repo = ?`,
  ).run(prNumber, repo);
}

export function getAllPendingReviewSyncs(): PendingReviewSyncRow[] {
  return db
    .prepare(`SELECT * FROM pending_review_sync`)
    .all() as PendingReviewSyncRow[];
}

// ─── task_no_op_attempts ──────────────────────────────────────────────────────

export interface TaskNoOpAttemptRow {
  task_id: string;
  retry_count: number;
  last_attempt_at: string;
}

export function getTaskNoOpAttempts(
  taskId: string,
): TaskNoOpAttemptRow | undefined {
  return db
    .prepare<{
      task_id: string;
    }>(
      `SELECT task_id, retry_count, last_attempt_at FROM task_no_op_attempts WHERE task_id = @task_id`,
    )
    .get({ task_id: taskId }) as TaskNoOpAttemptRow | undefined;
}

export function bumpTaskNoOpAttempts(taskId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO task_no_op_attempts (task_id, retry_count, last_attempt_at)
     VALUES (?, 1, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       retry_count = retry_count + 1,
       last_attempt_at = excluded.last_attempt_at`,
  ).run(taskId, now);
}

// ─── task_crash_counts ────────────────────────────────────────────────────────

function getTaskCrashCount(taskId: string): number {
  const row = db
    .prepare<{
      task_id: string;
    }>(
      `SELECT consecutive_crashes FROM task_crash_counts WHERE task_id = @task_id`,
    )
    .get({ task_id: taskId }) as { consecutive_crashes: number } | undefined;
  return row?.consecutive_crashes ?? 0;
}

/** Increment consecutive_crashes and return the new count. */
export function incrementTaskCrashCount(taskId: string): number {
  const now = Date.now();
  db.prepare(
    `INSERT INTO task_crash_counts (task_id, consecutive_crashes, last_crash_at)
     VALUES (?, 1, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       consecutive_crashes = consecutive_crashes + 1,
       last_crash_at = excluded.last_crash_at`,
  ).run(taskId, now);
  return getTaskCrashCount(taskId);
}

export function resetTaskCrashCount(taskId: string): void {
  db.prepare(`DELETE FROM task_crash_counts WHERE task_id = ?`).run(taskId);
}

// ─── session_pause_intervals ────────────────────────────────────────────────

export function insertPauseInterval(
  sessionId: string,
  pauseReason: CanonicalPauseReason,
): void {
  const serialized = serializePauseReason(
    pauseReasonFromCanonical(pauseReason),
  );
  db.prepare(
    `INSERT INTO session_pause_intervals (session_id, pause_reason, paused_at)
     VALUES (?, ?, ?)`,
  ).run(sessionId, serialized, Date.now());
}

export function closePauseInterval(sessionId: string): void {
  db.prepare(
    `UPDATE session_pause_intervals
     SET resumed_at = ?
     WHERE id = (
       SELECT id FROM session_pause_intervals
       WHERE session_id = ? AND resumed_at IS NULL
       ORDER BY paused_at DESC, id DESC
       LIMIT 1
     )`,
  ).run(Date.now(), sessionId);
}

export function getPauseIntervalsBySession(
  sessionId: string,
): SessionPauseInterval[] {
  const rows = db
    .prepare(
      `SELECT * FROM session_pause_intervals WHERE session_id = ? ORDER BY paused_at ASC`,
    )
    .all(sessionId) as Array<
    Omit<SessionPauseInterval, 'pause_reason'> & { pause_reason: string }
  >;
  return rows.map((row) => ({
    ...row,
    pause_reason: parsePauseReason(row.pause_reason)!,
  }));
}

export function getTotalPausedMs(
  sessionId: string,
  endedAt?: number | null,
): number {
  const implicit = endedAt ?? Date.now();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(resumed_at, ?) - paused_at), 0) AS total
       FROM session_pause_intervals
       WHERE session_id = ?`,
    )
    .get(implicit, sessionId) as { total: number };
  return row.total;
}

// ─── stuck_session_timers ─────────────────────────────────────────────────────

export interface StuckSessionTimerRow {
  session_id: string;
  task_name: string;
  notify_deadline: number;
  pause_deadline: number;
  hard_stop_deadline: number;
  hard_stop_armed: number;
  notify_remaining_ms: number | null;
  pause_remaining_ms: number | null;
  hard_stop_remaining_ms: number | null;
}

export function upsertStuckSessionTimer(
  sessionId: string,
  taskName: string,
  notifyDeadline: number,
  pauseDeadline: number,
  hardStopDeadline: number,
  hardStopArmed: boolean,
  notifyRemainingMs: number | null,
  pauseRemainingMs: number | null,
  hardStopRemainingMs: number | null,
): void {
  db.prepare<{
    session_id: string;
    task_name: string;
    notify_deadline: number;
    pause_deadline: number;
    hard_stop_deadline: number;
    hard_stop_armed: number;
    notify_remaining_ms: number | null;
    pause_remaining_ms: number | null;
    hard_stop_remaining_ms: number | null;
  }>(
    `
    INSERT INTO stuck_session_timers
      (session_id, task_name, notify_deadline, pause_deadline, hard_stop_deadline,
       hard_stop_armed, notify_remaining_ms, pause_remaining_ms, hard_stop_remaining_ms)
    VALUES
      (@session_id, @task_name, @notify_deadline, @pause_deadline, @hard_stop_deadline,
       @hard_stop_armed, @notify_remaining_ms, @pause_remaining_ms, @hard_stop_remaining_ms)
    ON CONFLICT(session_id) DO UPDATE SET
      task_name              = excluded.task_name,
      notify_deadline        = excluded.notify_deadline,
      pause_deadline         = excluded.pause_deadline,
      hard_stop_deadline     = excluded.hard_stop_deadline,
      hard_stop_armed        = excluded.hard_stop_armed,
      notify_remaining_ms    = excluded.notify_remaining_ms,
      pause_remaining_ms     = excluded.pause_remaining_ms,
      hard_stop_remaining_ms = excluded.hard_stop_remaining_ms
  `,
  ).run({
    session_id: sessionId,
    task_name: taskName,
    notify_deadline: notifyDeadline,
    pause_deadline: pauseDeadline,
    hard_stop_deadline: hardStopDeadline,
    hard_stop_armed: hardStopArmed ? 1 : 0,
    notify_remaining_ms: notifyRemainingMs,
    pause_remaining_ms: pauseRemainingMs,
    hard_stop_remaining_ms: hardStopRemainingMs,
  });
}

export function deleteStuckSessionTimer(sessionId: string): void {
  db.prepare<{ session_id: string }>(
    `DELETE FROM stuck_session_timers WHERE session_id = @session_id`,
  ).run({ session_id: sessionId });
}

export function getAllStuckSessionTimers(): StuckSessionTimerRow[] {
  return db
    .prepare(`SELECT * FROM stuck_session_timers`)
    .all() as StuckSessionTimerRow[];
}

// ─── active_merges ────────────────────────────────────────────────────────────

export interface ActiveMergeRow {
  key: string;
  repo: string;
  pr_number: number;
  started_at: number;
}

export function upsertActiveMerge(
  key: string,
  repo: string,
  prNumber: number,
): void {
  db.prepare<{
    key: string;
    repo: string;
    pr_number: number;
    started_at: number;
  }>(
    `INSERT OR REPLACE INTO active_merges (key, repo, pr_number, started_at)
     VALUES (@key, @repo, @pr_number, @started_at)`,
  ).run({ key, repo, pr_number: prNumber, started_at: Date.now() });
}

export function deleteActiveMerge(key: string): void {
  db.prepare<{ key: string }>(`DELETE FROM active_merges WHERE key = @key`).run(
    { key },
  );
}

export function getAllActiveMerges(): ActiveMergeRow[] {
  return db.prepare(`SELECT * FROM active_merges`).all() as ActiveMergeRow[];
}

// ─── orchestrator_test_results ────────────────────────────────────────────────

export interface TestResultRow {
  pr_number: number;
  repo: string;
  sha: string;
  passed: number;
  output: string;
  ran_at: string;
}

export function hasTestResultForSha(
  prNumber: number,
  repo: string,
  sha: string,
): boolean {
  const row = db
    .prepare<{
      pr_number: number;
      repo: string;
      sha: string;
    }>(
      `SELECT 1 FROM orchestrator_test_results WHERE pr_number = @pr_number AND repo = @repo AND sha = @sha`,
    )
    .get({ pr_number: prNumber, repo, sha });
  return row != null;
}

export function upsertTestResult(
  prNumber: number,
  repo: string,
  sha: string,
  passed: boolean,
  output: string,
): void {
  db.prepare<{
    pr_number: number;
    repo: string;
    sha: string;
    passed: number;
    output: string;
    ran_at: string;
  }>(
    `INSERT OR REPLACE INTO orchestrator_test_results (pr_number, repo, sha, passed, output, ran_at)
     VALUES (@pr_number, @repo, @sha, @passed, @output, @ran_at)`,
  ).run({
    pr_number: prNumber,
    repo,
    sha,
    passed: passed ? 1 : 0,
    output,
    ran_at: new Date().toISOString(),
  });
}

export function getTestResult(
  prNumber: number,
  repo: string,
  sha: string,
): TestResultRow | undefined {
  return db
    .prepare<{
      pr_number: number;
      repo: string;
      sha: string;
    }>(
      `SELECT * FROM orchestrator_test_results WHERE pr_number = @pr_number AND repo = @repo AND sha = @sha`,
    )
    .get({ pr_number: prNumber, repo, sha }) as TestResultRow | undefined;
}

// ─── orchestrator_analyze_results ───────────────────────────────────────────

export interface AnalyzeResultRow {
  pr_number: number;
  repo: string;
  sha: string;
  passed: number;
  output: string;
  ran_at: string;
}

export function hasAnalyzeResultForSha(
  prNumber: number,
  repo: string,
  sha: string,
): boolean {
  const row = db
    .prepare<{
      pr_number: number;
      repo: string;
      sha: string;
    }>(
      `SELECT 1 FROM orchestrator_analyze_results WHERE pr_number = @pr_number AND repo = @repo AND sha = @sha`,
    )
    .get({ pr_number: prNumber, repo, sha });
  return row != null;
}

export function upsertAnalyzeResult(
  prNumber: number,
  repo: string,
  sha: string,
  passed: boolean,
  output: string,
): void {
  db.prepare<{
    pr_number: number;
    repo: string;
    sha: string;
    passed: number;
    output: string;
    ran_at: string;
  }>(
    `INSERT OR REPLACE INTO orchestrator_analyze_results (pr_number, repo, sha, passed, output, ran_at)
     VALUES (@pr_number, @repo, @sha, @passed, @output, @ran_at)`,
  ).run({
    pr_number: prNumber,
    repo,
    sha,
    passed: passed ? 1 : 0,
    output,
    ran_at: new Date().toISOString(),
  });
}

export function getAnalyzeResult(
  prNumber: number,
  repo: string,
  sha: string,
): AnalyzeResultRow | undefined {
  return db
    .prepare<{
      pr_number: number;
      repo: string;
      sha: string;
    }>(
      `SELECT * FROM orchestrator_analyze_results WHERE pr_number = @pr_number AND repo = @repo AND sha = @sha`,
    )
    .get({ pr_number: prNumber, repo, sha }) as AnalyzeResultRow | undefined;
}

// ─── session_events pruner ──────────────────────────────────────────────────

export interface PruneEligibleSession {
  session_id: string;
  total_input_tokens: number;
  total_output_tokens: number;
}

/**
 * Returns sessions eligible for payload pruning: archived, ended before the
 * retention cutoff, and not yet pruned.
 */
export function getPruneEligibleSessions(
  endedAtCutoff: number,
  limit: number,
): PruneEligibleSession[] {
  return db
    .prepare<{ cutoff: number; limit: number }>(
      `SELECT session_id, total_input_tokens, total_output_tokens
       FROM sessions
       WHERE archived = 1
         AND ended_at IS NOT NULL
         AND ended_at < @cutoff
         AND events_pruned_at IS NULL
       ORDER BY ended_at ASC
       LIMIT @limit`,
    )
    .all({ cutoff: endedAtCutoff, limit }) as PruneEligibleSession[];
}

/**
 * Returns system event IDs and payloads for a session in a paginated batch,
 * for use in the pruner's batched update loop.
 */
export function getSystemEventBatch(
  sessionId: string,
  afterId: number,
  limit: number,
): { id: number; payload: string }[] {
  return db
    .prepare<{ session_id: string; after_id: number; limit: number }>(
      `SELECT id, payload FROM session_events
       WHERE session_id = @session_id
         AND event_type = 'system'
         AND id > @after_id
       ORDER BY id ASC
       LIMIT @limit`,
    )
    .all({ session_id: sessionId, after_id: afterId, limit }) as {
    id: number;
    payload: string;
  }[];
}

/**
 * Bulk-updates a batch of system event rows to their pruned stub payloads.
 * Runs in a single transaction to keep write locks short.
 */
export function pruneSystemEventBatch(
  updates: { id: number; payload: string }[],
): void {
  const stmt = db.prepare<{ id: number; payload: string }>(
    `UPDATE session_events SET payload = @payload WHERE id = @id`,
  );
  const tx = db.transaction((rows: { id: number; payload: string }[]) => {
    for (const row of rows) {
      stmt.run(row);
    }
  });
  tx(updates);
}

/** Marks a session's events as pruned. */
export function markSessionEventsPruned(
  sessionId: string,
  prunedAt: number,
): void {
  db.prepare<{ session_id: string; pruned_at: number }>(
    `UPDATE sessions SET events_pruned_at = @pruned_at WHERE session_id = @session_id`,
  ).run({ session_id: sessionId, pruned_at: prunedAt });
}

// ─── scheduler_audit ──────────────────────────────────────────────────────

export interface NewSchedulerAuditRow {
  job: string;
  status: 'ok' | 'failed' | 'skipped';
  started_at: string;
  completed_at: string;
  duration_ms: number;
  items_processed?: number | null;
  error?: string | null;
}

export function insertSchedulerAudit(row: NewSchedulerAuditRow): void {
  db.prepare<NewSchedulerAuditRow>(
    `INSERT INTO scheduler_audit (job, status, started_at, completed_at, duration_ms, items_processed, error)
     VALUES (@job, @status, @started_at, @completed_at, @duration_ms, @items_processed, @error)`,
  ).run({
    items_processed: null,
    error: null,
    ...row,
  });
}

export function pruneSchedulerAudit(keepPerJob = 1000): void {
  const jobs = db.prepare(`SELECT DISTINCT job FROM scheduler_audit`).all() as {
    job: string;
  }[];
  for (const { job } of jobs) {
    db.prepare<{ job: string; keep: number }>(
      `DELETE FROM scheduler_audit
       WHERE job = @job AND id NOT IN (
         SELECT id FROM scheduler_audit WHERE job = @job ORDER BY started_at DESC LIMIT @keep
       )`,
    ).run({ job, keep: keepPerJob });
  }
}
