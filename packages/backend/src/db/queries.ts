import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { db } from './db';
import { logger } from '../logger';
import { recordEvent, hasTaskEditSinceTimestamp } from '../audit/AuditLog';
import { normalizeTaskId, normalizeBoardId } from '../tasks/taskId';
import { isCodeSession } from '../session/sessionPredicates';
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
  TaskRepoAssignmentRow,
  FeedbackInboxRow,
  OpsJournalRow,
  GateItemRow,
  GateItemSourceRow,
  NewGateItemSourceRow,
  GateItemEventRow,
  NewGateItemEventRow,
  GateAccretionRow,
  GateItemClassification,
  DeployRunRow,
  DeployRunEventRow,
  NewDeployRunEventRow,
  SeedItemRow,
  SeedItemSourceRow,
  NewSeedItemSourceRow,
  SeedItemEventRow,
  NewSeedItemEventRow,
  SeedAccretionRow,
  ArchUnitRow,
  NewArchUnitRow,
  ArchUnitEventRow,
  NewArchUnitEventRow,
  ArchUnitQuery,
  CompletenessDispositionRow,
  NewCompletenessDispositionRow,
  CompletenessDispositionQuestion,
  CompletenessDispositionRecord,
  CompletenessProbedGapClass,
  StagedIntentRow,
  StagedIntentState,
  StagedIntentGroupRow,
  FlowArmRow,
  ConvergenceSnapshotRow,
  NewConvergenceSnapshotRow,
} from './types';
import { FLOW_IDS, DEFAULT_ARM, type FlowId } from '../orchestration/flowArm';

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

// pending_done_* are prepared lazily (inline, per-call) rather than as
// module-level consts — unlike the sessions table's long-standing columns,
// these are new, and some callers of queries.ts run against a `db` handle
// that was never taken through schema.ts's runMigrations (only db.ts's own
// bootstrap schema — see production callers vs. test fixtures that don't
// mock db.ts). A module-level db.prepare() against a column that handle
// doesn't have would fail at import time for every such caller, not just
// ones that actually use pending-done. Preparing inline defers that check to
// first actual use, matching the existing convention for other newer
// optional columns in this file (e.g. addGrantedCapability).
function setPendingDone(
  sessionId: string,
  endedAt: number,
  prUrl: string | null,
  callSite: string,
): void {
  db.prepare<{
    session_id: string;
    pending_done_ended_at: number;
    pending_done_pr_url: string | null;
    pending_done_call_site: string;
  }>(
    `UPDATE sessions
     SET pending_done_ended_at = @pending_done_ended_at,
         pending_done_pr_url = @pending_done_pr_url,
         pending_done_call_site = @pending_done_call_site
     WHERE session_id = @session_id`,
  ).run({
    session_id: sessionId,
    pending_done_ended_at: endedAt,
    pending_done_pr_url: prUrl,
    pending_done_call_site: callSite,
  });
}

function clearPendingDone(sessionId: string): void {
  db.prepare<{ session_id: string }>(
    `UPDATE sessions
     SET pending_done_ended_at = NULL, pending_done_pr_url = NULL, pending_done_call_site = NULL
     WHERE session_id = @session_id`,
  ).run({ session_id: sessionId });
}

/**
 * Durable copy of PlanningOrchestrator's in-memory pendingApproveTerminal
 * Set — written when an approve-driven terminal transition is deferred
 * because the session's turn is still in flight, cleared once that
 * transition is applied. Exported (unlike setPendingDone/clearPendingDone)
 * because PlanningOrchestrator writes/clears it directly and
 * SessionManager's boot-time sweep reads it to apply any transition that
 * never got its turn-boundary drain before a restart.
 */
export function setPendingApproveTerminal(sessionId: string, at: number): void {
  db.prepare<{ session_id: string; pending_approve_terminal_at: number }>(
    `UPDATE sessions
     SET pending_approve_terminal_at = @pending_approve_terminal_at
     WHERE session_id = @session_id`,
  ).run({ session_id: sessionId, pending_approve_terminal_at: at });
}

export function clearPendingApproveTerminal(sessionId: string): void {
  db.prepare<{ session_id: string }>(
    `UPDATE sessions
     SET pending_approve_terminal_at = NULL
     WHERE session_id = @session_id`,
  ).run({ session_id: sessionId });
}

/** Sessions with an unapplied deferred approve-terminal transition — read by the boot-time sweep. */
export function getSessionsWithPendingApproveTerminal(): Session[] {
  return db
    .prepare(
      `SELECT * FROM sessions WHERE pending_approve_terminal_at IS NOT NULL`,
    )
    .all() as Session[];
}

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
 * Returns other standard (non-review, non-planning) sessions in
 * status='running' for the same task_id, excluding the given session. Used
 * by sendOrResume to reconcile zombie rows before respawning.
 *
 * Only meaningful for a standard-session resume: a standard session's
 * resume is a continuation of a prior standard session's work on the same
 * task, so a stale running standard row is genuinely superseded. A
 * planning-session (groom/design/ops/split) resume is not a continuation of
 * a code session — e.g. resuming a groom session to deliver an operator
 * disposition must never retire the task's live code session — so
 * `resumingSessionType` gates the sweep to same-lineage resumes only; a
 * non-standard resuming type returns no rows.
 */
export function getOtherRunningSessionsForTask(
  taskId: string,
  excludeSessionId: string,
  resumingSessionType: string | null | undefined,
): Session[] {
  if (resumingSessionType && !isCodeSession(resumingSessionType)) return [];
  const norm = normalizeBoardId(taskId);
  const rows = db
    .prepare<{ session_id: string }>(
      `
    SELECT * FROM sessions
    WHERE session_id != @session_id
      AND status = 'running'
      AND (session_type = 'standard' OR session_type IS NULL)
  `,
    )
    .all({ session_id: excludeSessionId }) as Session[];
  return rows.filter((row) => normalizeBoardId(row.task_id ?? '') === norm);
}

/**
 * Atomically mark a session as done, setting ended_at and pr_url in a single
 * write. Preferred over updateSessionStatus for clean-exit paths because it
 * also persists pr_url without a second round-trip.
 * pr_url is only overwritten when non-null — existing value is preserved otherwise.
 *
 * In-flight guard: if the current session status is 'running', a turn may
 * still be in progress (or about to be — e.g. a resume race), so writing
 * 'done' now would either stomp an active turn or get silently reverted by
 * that turn's own terminal write once it finishes. Instead of writing, the
 * transition is deferred onto pending_done_* and a session_done_deferred_while_running
 * audit event is recorded. The deferred transition is applied once the turn
 * completes — see applyPendingDone, called from SessionManager's run()-settle
 * handler and its boot-time sweep — so it is never silently lost.
 *
 * opts.skipInFlightGuard bypasses the guard for callers that have already
 * independently confirmed there is no live process for this session (e.g.
 * SessionManager's boot-time orphan recovery, reconciling a row stuck at
 * 'running' from a crash before any process for it exists again this run) —
 * never set this from a caller that cannot make that guarantee.
 */
export function markSessionDone(
  sessionId: string,
  endedAt: number,
  prUrl?: string | null,
  callSite?: string,
  opts?: { skipInFlightGuard?: boolean },
): void {
  const current = stmtGetSession.get({ session_id: sessionId }) as
    | { status: string; task_id: string | null }
    | undefined;
  if (current?.status === 'running' && !opts?.skipInFlightGuard) {
    logger.warn(
      `[markSessionDone] deferring running→done for ${sessionId.slice(0, 8)} call_site=${callSite ?? 'unknown'} — turn still in flight`,
    );
    recordEvent({
      event_type: 'session_done_deferred_while_running',
      actor_type: 'system',
      actor_id: sessionId,
      task_id: current.task_id ?? null,
      payload: { call_site: callSite ?? 'unknown', status_before: 'running' },
    });
    setPendingDone(sessionId, endedAt, prUrl ?? null, callSite ?? 'unknown');
    return;
  }
  stmtMarkSessionDone.run({
    session_id: sessionId,
    ended_at: endedAt,
    pr_url: prUrl ?? null,
  });
}

/**
 * Applies a done-transition previously deferred by markSessionDone, once the
 * session's turn has genuinely completed (i.e. its process has exited — the
 * caller is responsible for only invoking this at that point, never while a
 * turn might still be in flight). No-op if nothing is pending. If the session
 * already reached a terminal status via another path in the meantime, the
 * stale pending mark is dropped rather than applied (that other terminal
 * status wins — it reflects something more recent).
 * Returns true if a deferred done-transition was applied.
 */
export function applyPendingDone(sessionId: string): boolean {
  const current = stmtGetSession.get({ session_id: sessionId }) as
    | {
        status: string;
        task_id: string | null;
        pending_done_ended_at: number | null;
        pending_done_pr_url: string | null;
        pending_done_call_site: string | null;
      }
    | undefined;
  if (!current || current.pending_done_ended_at == null) return false;
  if (TERMINAL_SESSION_STATUSES.has(current.status)) {
    clearPendingDone(sessionId);
    return false;
  }
  stmtMarkSessionDone.run({
    session_id: sessionId,
    ended_at: current.pending_done_ended_at,
    pr_url: current.pending_done_pr_url,
  });
  clearPendingDone(sessionId);
  recordEvent({
    event_type: 'session_done_deferred_applied',
    actor_type: 'system',
    actor_id: sessionId,
    task_id: current.task_id ?? null,
    payload: { call_site: current.pending_done_call_site ?? 'unknown' },
  });
  return true;
}

/**
 * Sessions with an unapplied deferred done-transition (pending_done_ended_at
 * set) that are not currently 'running' — these can arise if the backend
 * restarted between the pending write and applyPendingDone's own call (e.g.
 * mid-way through a clean-exit). Running rows are excluded because they are
 * already covered by the ordinary orphan-resume path: once resumed and the
 * turn completes again, applyPendingDone fires from the settle handler same
 * as any other session. Used by SessionManager's boot sweep to close the
 * loop on the rest.
 */
export function getSessionsWithUnappliedPendingDone(): Session[] {
  return db
    .prepare(
      `SELECT * FROM sessions WHERE pending_done_ended_at IS NOT NULL AND status != 'running'`,
    )
    .all() as Session[];
}

/**
 * Terminal session statuses shared across the codebase. A session in one of
 * these states has concluded and must never be reverted by a stale write
 * from an in-flight subprocess (e.g. a clean-exit that races a merge).
 * SessionManager's own TERMINAL_STATUSES additionally includes 'superseded'
 * for its branch-deletion gate — that's a distinct, wider vocabulary and is
 * derived from this one rather than duplicated.
 */
export const TERMINAL_SESSION_STATUSES = new Set(['done', 'error', 'killed']);

/**
 * TERMINAL_SESSION_STATUSES plus 'superseded' — the wider terminal vocabulary
 * used by consumers below (hasActiveSessionForTask, hasActivePlanningSessionForTask,
 * hasNonTerminalPlanningSessionForTask, archiveFinishedSessions) that also treat a
 * superseded session as concluded. Derived, never re-enumerated, so 'idle' can
 * never silently reappear in one of these collections.
 */
const TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED = new Set([
  ...TERMINAL_SESSION_STATUSES,
  'superseded',
]);

/** SQL `IN (...)`-ready literal list derived from TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED. */
const TERMINAL_STATUS_SQL_LIST = [...TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED]
  .map((s) => `'${s}'`)
  .join(', ');

/** SQL `IN (...)`-ready literal list derived from TERMINAL_SESSION_STATUSES (no 'superseded'). */
const BASE_TERMINAL_STATUS_SQL_LIST = [...TERMINAL_SESSION_STATUSES]
  .map((s) => `'${s}'`)
  .join(', ');

const stmtBackfillPrUrlIfNull = db.prepare<{
  session_id: string;
  pr_url: string | null;
}>(`
  UPDATE sessions
  SET pr_url = COALESCE(pr_url, @pr_url)
  WHERE session_id = @session_id
`);

/**
 * Atomically mark a session as idle (process exited, PR open, waiting for
 * review/merge). Sets ended_at and pr_url in a single write. The session
 * remains resumable via sendOrResume; it becomes done only when the PR merges.
 *
 * Terminal guard: if the session has already concluded (done/error/killed —
 * e.g. its PR merged and PRMergeWatcher/_concludeSessions already marked it
 * done), a subsequent clean-exit write must not revert that terminal status
 * back to idle. The write is skipped and a session_idle_write_skipped_terminal
 * audit event is recorded. Any scraped pr_url is still backfilled onto the
 * row when it currently has none, so recoverSession/SessionAuditor can still
 * find it.
 */
export function markSessionIdle(
  sessionId: string,
  endedAt: number,
  prUrl?: string | null,
): void {
  const current = stmtGetSession.get({ session_id: sessionId }) as
    | { status: string; task_id: string | null }
    | undefined;
  if (current && TERMINAL_SESSION_STATUSES.has(current.status)) {
    recordEvent({
      event_type: 'session_idle_write_skipped_terminal',
      actor_type: 'system',
      actor_id: sessionId,
      task_id: current.task_id ?? null,
      payload: { status_before: current.status },
    });
    if (prUrl) {
      stmtBackfillPrUrlIfNull.run({ session_id: sessionId, pr_url: prUrl });
    }
    return;
  }
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

const GATE_ITEM_TASK_PREFIX = 'gate-item:';

export interface GateItemVerifySession {
  itemId: string;
  sessionId: string;
  sessionStatus: string;
  startedAt: number;
  endedAt: number | null;
}

/**
 * Resolves the gate-item ↔ verify-session linkage: sessions whose task_id
 * is 'gate-item:<id>' (set by GateItemVerifier on dispatch), for the given
 * gate item ids. Most recent first, so callers can take the live/latest one.
 */
export function getVerifySessionsForGateItems(
  itemIds: string[],
): GateItemVerifySession[] {
  if (itemIds.length === 0) return [];
  const taskIds = itemIds.map((id) => `${GATE_ITEM_TASK_PREFIX}${id}`);
  const placeholders = taskIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT session_id, task_id, status, started_at, ended_at
       FROM sessions
       WHERE task_id IN (${placeholders})
       ORDER BY started_at DESC`,
    )
    .all(...taskIds) as {
    session_id: string;
    task_id: string | null;
    status: string;
    started_at: number;
    ended_at: number | null;
  }[];
  return rows
    .filter((r): r is typeof r & { task_id: string } => r.task_id !== null)
    .map((r) => ({
      itemId: r.task_id.slice(GATE_ITEM_TASK_PREFIX.length),
      sessionId: r.session_id,
      sessionStatus: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }));
}

/**
 * True if this gate item has a live (non-terminal) verify session — the
 * gate reconciler's per-item dispatch guard, keyed on the same
 * `gate-item:<id>` task_id convention as getVerifySessionsForGateItems.
 * Unlike the reconciler's in-memory inFlightVerifications set, this is
 * DB-backed and so survives a process restart — the gap that let a gate
 * item with a still-running verify session get re-dispatched a second time.
 */
export function hasLiveVerifySessionForGateItem(itemId: string): boolean {
  const taskId = `${GATE_ITEM_TASK_PREFIX}${itemId}`;
  const row = db
    .prepare<{ taskId: string }, { c: number }>(
      `SELECT COUNT(*) as c FROM sessions
       WHERE task_id = @taskId
         AND status NOT IN ('done', 'error', 'killed', 'superseded')`,
    )
    .get({ taskId });
  return (row?.c ?? 0) > 0;
}

export interface GateItemPendingCapabilitySession {
  itemId: string;
  sessionId: string;
}

/**
 * Non-terminal gate-item verify sessions (task_id `gate-item:<id>`) that
 * currently have an outstanding `session.requestCapability` intent —
 * exactly the sessions a boot restart would otherwise silently abandon,
 * since the in-memory `awaitDisposition` listener that would have resumed
 * them died with the old process. Boot reconciliation uses this to
 * re-attach a fresh listener per item (see gateReconciler's
 * reattachOutstandingGateVerifications).
 */
export function getGateItemsWithPendingCapabilityRequest(): GateItemPendingCapabilitySession[] {
  const rows = db
    .prepare(
      `SELECT s.session_id AS session_id, s.task_id AS task_id
       FROM sessions s
       WHERE s.task_id LIKE '${GATE_ITEM_TASK_PREFIX}%'
         AND s.status NOT IN ('done', 'error', 'killed', 'superseded')
         AND EXISTS (
           SELECT 1 FROM staged_intent si
           WHERE si.session_id = s.session_id
             AND si.kind = 'session.requestCapability'
             AND si.state IN ('staged', 'approved')
         )`,
    )
    .all() as { session_id: string; task_id: string }[];
  return rows.map((r) => ({
    itemId: r.task_id.slice(GATE_ITEM_TASK_PREFIX.length),
    sessionId: r.session_id,
  }));
}

/**
 * True if this task has a non-terminal planning (groom/design/ops) session —
 * including one parked idle awaiting operator disposition. Per the no-timeout
 * decision for planning sessions, an idle groom/design/ops session is never
 * an orphan: OrphanedTaskSweeper must skip revert/nudge for such a task.
 * Excludes archived sessions: archiving is only reachable via
 * archiveAndEndSession, which reaps any live subprocess first, so an
 * archived row is never a running one — it's the operator's explicit
 * "this session is done" signal, and must not keep suppressing dispatch.
 */
export function hasNonTerminalPlanningSessionForTask(taskId: string): boolean {
  const norm = normalizeBoardId(taskId);
  const rows = db
    .prepare<[], { task_id: string | null }>(
      `
    SELECT task_id FROM sessions
    WHERE status NOT IN (${TERMINAL_STATUS_SQL_LIST})
      AND session_type IN ('groom', 'design', 'ops')
      AND archived = 0
  `,
    )
    .all();
  return rows.some((row) => normalizeBoardId(row.task_id ?? '') === norm);
}

/** A planning flow whose dispatch-eligibility predicate needs its own re-dispatch dedup — see planningCandidates.ts. */
export type DedupedPlanningFlow = 'groom' | 'design' | 'ops';

/**
 * True if this task has a non-terminal (running OR parked idle) session of
 * the given planning flow. The flow-parameterised counterpart to
 * hasActiveSessionForTask, which is standard-session-only and left
 * unchanged — this is additive so the three planning candidate predicates
 * (isGroomCandidate/isOpsCandidate/isDesignCandidate) can each dedup against
 * their own flow's sessions instead of being blind to all of them.
 */
export function hasActivePlanningSessionForTask(
  taskId: string,
  flow: DedupedPlanningFlow,
): boolean {
  const norm = normalizeBoardId(taskId);
  const rows = db
    .prepare<{ flow: string }, { task_id: string | null }>(
      `
    SELECT task_id FROM sessions
    WHERE status NOT IN (${TERMINAL_STATUS_SQL_LIST})
      AND session_type = @flow
      AND archived = 0
  `,
    )
    .all({ flow });
  return rows.some((row) => normalizeBoardId(row.task_id ?? '') === norm);
}

export function hasActiveSessionForTask(taskId: string): boolean {
  const norm = taskId.replace(/-/g, '');
  const row = db
    .prepare<{ task_id: string }>(
      `
    SELECT 1 FROM sessions
    WHERE REPLACE(COALESCE(task_id, ''), '-', '') = @task_id
      AND status NOT IN (${TERMINAL_STATUS_SQL_LIST})
      AND (session_type = 'standard' OR session_type IS NULL)
      AND archived = 0
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
      s.granted_capabilities,
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

/**
 * Archives concluded sessions only (status derived from TERMINAL_SESSION_STATUSES).
 * A session parked idle is still alive and resumable — never terminal — and
 * must never be swept up by this basis alone.
 */
export function archiveFinishedSessions(): number {
  const result = db
    .prepare(
      `UPDATE sessions SET archived = 1 WHERE status IN (${BASE_TERMINAL_STATUS_SQL_LIST})`,
    )
    .run();
  return result.changes;
}

/**
 * Archive concluded sessions (status derived from TERMINAL_SESSION_STATUSES, archived=0)
 * whose ended_at is older than the given cutoff timestamp (ms).
 * Idle sessions are excluded — the CLI subprocess is still alive and resumable.
 * Returns the session_ids of archived sessions.
 */
export function archiveConcludedSessionsOlderThan(cutoffMs: number): string[] {
  const rows = db
    .prepare(
      `SELECT session_id FROM sessions
       WHERE status IN (${BASE_TERMINAL_STATUS_SQL_LIST})
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

/**
 * Read the durable per-session granted-capabilities set — operator-approved
 * grants (a Bash command prefix or named MCP write verb) sticky for the
 * session's life. Rehydrated on boot so a restart mid-session doesn't lose
 * them.
 */
export function getGrantedCapabilities(sessionId: string): string[] {
  const row = db
    .prepare('SELECT granted_capabilities FROM sessions WHERE session_id = ?')
    .get(sessionId) as { granted_capabilities: string | null } | undefined;
  if (!row?.granted_capabilities) return [];
  try {
    const parsed = JSON.parse(row.granted_capabilities);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Add a capability to the session's durable granted set (idempotent — a
 * capability already granted is not duplicated). Scoped to this one session;
 * discarded at session end (the row persists but is no longer read).
 */
export function addGrantedCapability(
  sessionId: string,
  capability: string,
): string[] {
  const existing = getGrantedCapabilities(sessionId);
  const next = existing.includes(capability)
    ? existing
    : [...existing, capability];
  db.prepare(
    'UPDATE sessions SET granted_capabilities = ? WHERE session_id = ?',
  ).run(JSON.stringify(next), sessionId);
  return next;
}

/**
 * Remove a capability from the session's durable granted set (idempotent —
 * a no-op if the capability isn't present). Mirrors addGrantedCapability.
 */
export function removeGrantedCapability(
  sessionId: string,
  capability: string,
): string[] {
  const existing = getGrantedCapabilities(sessionId);
  const next = existing.filter((c) => c !== capability);
  db.prepare(
    'UPDATE sessions SET granted_capabilities = ? WHERE session_id = ?',
  ).run(JSON.stringify(next), sessionId);
  return next;
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

/**
 * Epoch ms of the most recent session_events row for the session, or null
 * when it has none (pruned or never emitted — callers must treat null as
 * "unknown", never as "inert").
 */
export function getSessionLastActivityMs(sessionId: string): number | null {
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

export function deleteTaskCacheRow(taskId: string): void {
  db.prepare(`DELETE FROM task_cache WHERE task_id = ?`).run(taskId);
}

const stmtGetBoardCacheRows = db.prepare(
  `SELECT task_id, fetched_at, raw_json FROM task_cache WHERE task_id LIKE 'board:%'`,
);

/**
 * Write-through for a status change: patches the `status` field of the
 * given task in place inside every cached `board:*` blob that contains it
 * (a task can appear in several board rows at once — per-milestone,
 * hyphenless-id, and project-prefixed keys all coexist). Does not delete
 * rows or trigger a project re-warm, so it stays off the Notion API; the
 * periodic TaskCacheRefresher remains the source of truth and will later
 * overwrite these rows with authoritative data.
 *
 * Ids are matched via normalizeTaskId, which canonicalizes both the
 * `notion:` source prefix and hyphenation — board blobs carry bare ids
 * while callers may pass any prefixed/hyphenless variant. Best-effort and
 * non-fatal throughout: a missing, empty, or unparseable board row is
 * skipped rather than allowed to fail the status write.
 */
export function updateTaskStatusInBoardCaches(
  taskId: string,
  status: string,
): void {
  const normalized = normalizeTaskId(taskId);
  let rows: Array<{ task_id: string; fetched_at: number; raw_json: string }>;
  try {
    rows = stmtGetBoardCacheRows.all() as Array<{
      task_id: string;
      fetched_at: number;
      raw_json: string;
    }>;
  } catch {
    return;
  }
  for (const row of rows) {
    let tasks: unknown;
    try {
      tasks = JSON.parse(row.raw_json);
    } catch {
      continue;
    }
    if (!Array.isArray(tasks)) continue;
    let changed = false;
    for (const entry of tasks) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { id?: unknown }).id === 'string' &&
        normalizeTaskId((entry as { id: string }).id) === normalized
      ) {
        (entry as { status: string }).status = status;
        changed = true;
      }
    }
    if (!changed) continue;
    try {
      stmtUpsertTaskCache.run({
        task_id: row.task_id,
        fetched_at: row.fetched_at,
        raw_json: JSON.stringify(tasks),
      });
    } catch {
      // Non-fatal: leave the row as-is rather than failing the status write.
    }
  }
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
    | 'stalled_pr_retry_count'
    | 'session_initiated_close_at'
    | 'reviewer_requested_at'
    | 'flake_recovery_attempts'
    | 'human_merge_only'
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
  const repoConfigured = listProjectRows().some((row) => {
    const raw = row.github_repo;
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return (parsed as string[]).includes(pr.repo);
    } catch {
      // bare string
    }
    return raw === pr.repo;
  });
  if (!repoConfigured) {
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
    SET head_sha = @head_sha, stalled_pr_retry_count = 0
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({ pr_number: prNumber, repo, head_sha: sha });
}

export function incrementStalledPRRetryCount(
  prNumber: number,
  repo: string,
): number {
  db.prepare<{ pr_number: number; repo: string }>(
    `UPDATE pull_requests SET stalled_pr_retry_count = stalled_pr_retry_count + 1 WHERE pr_number = @pr_number AND repo = @repo`,
  ).run({ pr_number: prNumber, repo });
  return getPRByNumber(prNumber, repo)?.stalled_pr_retry_count ?? 0;
}

export function clearReviewSessionId(prNumber: number, repo: string): void {
  db.prepare<{ pr_number: number; repo: string }>(
    `UPDATE pull_requests SET review_session_id = NULL WHERE pr_number = @pr_number AND repo = @repo`,
  ).run({ pr_number: prNumber, repo });
}

export function setHeadBranch(
  prNumber: number,
  repo: string,
  branch: string | null,
): void {
  db.prepare<{ pr_number: number; repo: string; head_branch: string | null }>(
    `
    UPDATE pull_requests
    SET head_branch = @head_branch
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({ pr_number: prNumber, repo, head_branch: branch });
}

/**
 * Marks a PR as having a pending session-initiated close/reopen cycle,
 * live-detected from a `gh pr close`/`gh pr reopen` Bash command run by the
 * session itself. PRMergeWatcher uses this to defer terminalization of a
 * closed PR while the coding session is still non-terminal.
 */
export function markSessionInitiatedPRClose(
  prNumber: number,
  repo: string,
): void {
  db.prepare<{
    pr_number: number;
    repo: string;
    session_initiated_close_at: number;
  }>(
    `
    UPDATE pull_requests
    SET session_initiated_close_at = @session_initiated_close_at
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({
    pr_number: prNumber,
    repo,
    session_initiated_close_at: Date.now(),
  });
}

/** Clears the session-initiated close/reopen marker — called on reconcile and on terminalize. */
export function clearSessionInitiatedPRClose(
  prNumber: number,
  repo: string,
): void {
  db.prepare<{ pr_number: number; repo: string }>(
    `UPDATE pull_requests SET session_initiated_close_at = NULL WHERE pr_number = @pr_number AND repo = @repo`,
  ).run({ pr_number: prNumber, repo });
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

/**
 * Link a previously-orphaned PR row (task_id/session_id null) to a task and
 * session re-derived from its head_branch. Used by StalledPRReconciler to
 * recover PRs that PRBootSweep inserted with no session match.
 */
export function linkPRTaskAndSession(
  prNumber: number,
  repo: string,
  taskId: string,
  sessionId: string | null,
): void {
  db.prepare<{
    task_id: string;
    session_id: string | null;
    pr_number: number;
    repo: string;
  }>(
    `UPDATE pull_requests SET task_id = @task_id, session_id = COALESCE(@session_id, session_id)
     WHERE pr_number = @pr_number AND repo = @repo`,
  ).run({ task_id: taskId, session_id: sessionId, pr_number: prNumber, repo });
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

export function incrementFlakeRecoveryAttempts(
  prNumber: number,
  repo: string,
): void {
  db.prepare(
    `UPDATE pull_requests SET flake_recovery_attempts = flake_recovery_attempts + 1 WHERE pr_number = ? AND repo = ?`,
  ).run(prNumber, repo);
}

export function resetFlakeRecoveryAttempts(
  prNumber: number,
  repo: string,
): void {
  db.prepare(
    `UPDATE pull_requests SET flake_recovery_attempts = 0 WHERE pr_number = ? AND repo = ?`,
  ).run(prNumber, repo);
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

/**
 * Set-once marker for corporate-mode reviewer auto-assignment: stamped after
 * requestReviewers fires (success or failure) so the ~5s merge poll never
 * re-requests reviewers for the same PR. COALESCE preserves the first-set
 * timestamp on repeat calls.
 */
export function markReviewerRequested(prNumber: number, repo: string): void {
  db.prepare<{ pr_number: number; repo: string; now: number }>(
    `UPDATE pull_requests SET reviewer_requested_at = COALESCE(reviewer_requested_at, @now) WHERE pr_number = @pr_number AND repo = @repo`,
  ).run({ pr_number: prNumber, repo, now: Date.now() });
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
 * Signals that may trigger clearTerminalPRFlags. Only a subset of these are
 * trusted to clear a 'stalled_reconcile_cap' escalation — see
 * CAP_CLEAR_ALLOWED_TRIGGERS below.
 */
export type ClearTerminalPRFlagsTrigger =
  | 'merged'
  | 'closed'
  | 'head_sha_advance'
  | 'human_unpark'
  | 'review_verdict'
  | 'session_reconciled';

/**
 * Triggers that are allowed to clear a 'stalled_reconcile_cap' escalation:
 * a genuine terminal transition (merged/closed), a head_sha advance (a fix
 * was actually pushed — the load-bearing signal), an explicit human
 * unpark/recovery action, or a session-initiated-close reconcile (the PR was
 * never really abandoned — the close was the session's own churn). A bare
 * automated 'review_verdict' is deliberately excluded: an approved verdict
 * does not guarantee the PR is mergeable, and clearing the cap on verdict
 * alone re-creates the open+no-pause+no-session limbo the cap escalation
 * exists to prevent.
 */
const CAP_CLEAR_ALLOWED_TRIGGERS: ReadonlySet<ClearTerminalPRFlagsTrigger> =
  new Set([
    'merged',
    'closed',
    'head_sha_advance',
    'human_unpark',
    'session_reconciled',
  ]);

/**
 * Clear both pause_reason and pre_review_stage on terminal PR transitions
 * (merged, closed, or approved verdict). Composes the existing setters so that
 * pause_reason_set_at is also nulled correctly. Re-nulling already-null fields
 * is a no-op in SQLite and is safe.
 *
 * When the PR is currently escalated to 'stalled_reconcile_cap', clearing is
 * gated on `trigger` — see CAP_CLEAR_ALLOWED_TRIGGERS.
 */
export function clearTerminalPRFlags(
  prNumber: number,
  repo: string,
  trigger: ClearTerminalPRFlagsTrigger,
): void {
  const pr = getPRByNumber(prNumber, repo);
  const pauseStruct = parsePauseReason(pr?.pause_reason ?? null);
  if (
    pauseStruct?.reason === 'stalled_reconcile_cap' &&
    !CAP_CLEAR_ALLOWED_TRIGGERS.has(trigger)
  ) {
    logger.info(
      `[clearTerminalPRFlags] PR #${prNumber} (${repo}): refusing to clear stalled_reconcile_cap — trigger '${trigger}' is not a trusted escalation-clearing signal`,
    );
    return;
  }
  setPauseReason(prNumber, repo, null);
  setPreReviewStage(prNumber, repo, null);
  recordEvent({
    event_type: 'pr_terminal_flags_cleared',
    actor_type: 'system',
    actor_id: null,
    task_id: null,
    payload: { pr_number: prNumber, repo, trigger },
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
 * Every task-level pause reason currently on record — the milestone-attention
 * blocked/stalled detector's raw input. Task ids aren't pre-joined to a
 * milestone here (the table has no milestone column), so callers resolve
 * that via resolveMilestoneForTaskId per row, same as the staged_intent
 * milestone backfill does.
 */
export function listTaskPauseReasons(): {
  task_id: string;
  pause_reason: string;
}[] {
  return db
    .prepare(`SELECT task_id, pause_reason FROM task_pause_reasons`)
    .all() as { task_id: string; pause_reason: string }[];
}

/**
 * Clear the pause_reason on all PRs associated with a task (used when the task
 * transitions back to Ready so the next launch attempt is not blocked by a
 * stale PR-level pause such as stuck_timeout).
 */
export function clearPausedPrReasonForTask(taskId: string): void {
  db.prepare<{ task_id: string }>(
    `UPDATE pull_requests
     SET pause_reason = NULL, pause_reason_set_at = NULL
     WHERE task_id = @task_id AND pause_reason IS NOT NULL`,
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
      AND (human_merge_only IS NULL OR human_merge_only = 0)
  `,
    )
    .all() as PullRequestRow[];
}

/**
 * Sets the docs execution flow's never-auto-merged output gate at PR-open
 * time. Idempotent — a repeat call with the same value is a no-op.
 */
export function setHumanMergeOnly(
  prNumber: number,
  repo: string,
  value: boolean,
): void {
  db.prepare<{ pr_number: number; repo: string; human_merge_only: number }>(
    `
    UPDATE pull_requests
    SET human_merge_only = @human_merge_only
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({ pr_number: prNumber, repo, human_merge_only: value ? 1 : 0 });
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

export interface DeadSessionAtBoot {
  session_id: string;
  status: string;
}

/**
 * Returns all sessions at a non-terminal, non-idle status (starting or running)
 * that exist at boot time. After a server restart the entire process tree is gone,
 * so these sessions are dead by definition and must be driven to a terminal state.
 */
export function getDeadSessionsAtBoot(): DeadSessionAtBoot[] {
  return db
    .prepare(
      `
    SELECT session_id, status FROM sessions
    WHERE status IN ('starting', 'running')
  `,
    )
    .all() as DeadSessionAtBoot[];
}

export interface IdleSessionWithResolvedPR {
  session_id: string;
  task_id: string | null;
  project_id: string | null;
  pr_state: string;
  pr_number: number;
  repo: string;
  pr_url: string | null;
  review_session_id: string | null;
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
           pr.state AS pr_state, pr.pr_number, pr.repo, pr.pr_url,
           pr.review_session_id
    FROM sessions s
    JOIN pull_requests pr ON pr.session_id = s.session_id
    WHERE s.status = 'idle'
      AND pr.state IN ('merged', 'closed')
  `,
    )
    .all() as IdleSessionWithResolvedPR[];
}

export interface IdleReviewSessionWithTerminalCodingOrPR {
  session_id: string;
  task_id: string | null;
  project_id: string | null;
  pr_url: string | null;
  pr_state: string;
  coding_session_status: string | null;
}

/**
 * Returns idle review sessions whose linked PR is already terminal (merged/closed)
 * or whose paired coding session is already terminal (done/error/killed).
 * Used by the boot-time reconciliation pass to conclude review sessions that were
 * orphaned while the server was offline or that the closed-PR path left non-terminal.
 */
export function getIdleReviewSessionsWithTerminalCodingOrPR(): IdleReviewSessionWithTerminalCodingOrPR[] {
  return db
    .prepare(
      `
    SELECT s.session_id, s.task_id, s.project_id,
           pr.pr_url, pr.state AS pr_state,
           cs.status AS coding_session_status
    FROM sessions s
    JOIN pull_requests pr ON pr.review_session_id = s.session_id
    LEFT JOIN sessions cs ON cs.session_id = pr.session_id
    WHERE s.session_type = 'review'
      AND s.status = 'idle'
      AND (
        cs.status IN ('done', 'error', 'killed')
        OR pr.state IN ('merged', 'closed')
      )
  `,
    )
    .all() as IdleReviewSessionWithTerminalCodingOrPR[];
}

/**
 * Returns eligible PRs for the bulk-merge button: open, approved verdict,
 * not paused, and mergeable=1, scoped to the given project's milestone.
 */
export function getMergeReadyPRs(
  projectId: string,
  milestoneId: string,
): PullRequestRow[] {
  const milestone = db
    .prepare<{
      id: string;
      project_id: string;
    }>(`SELECT id FROM milestones WHERE id = @id AND project_id = @project_id`)
    .get({ id: milestoneId, project_id: projectId }) as
    | { id: string }
    | undefined;

  if (!milestone) return [];

  // Board cache is keyed on the DB milestone UUID, matching every backend's write side.
  const cacheKey = `board:${milestoneId}`;

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
  // planning session (session_type IN ('groom', 'design', 'ops'))
  planning_session_id: string | null;
  planning_session_status: string | null;
  planning_session_started_at: number | null;
  planning_session_ended_at: number | null;
  planning_session_input_tokens: number | null;
  planning_session_output_tokens: number | null;
  planning_session_type: string | null;
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
      ranked_planning AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY task_id
            ORDER BY started_at DESC
          ) AS rn
        FROM sessions
        WHERE session_type IN ('groom', 'design', 'ops')
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
      ps.session_id           AS planning_session_id,
      ps.status               AS planning_session_status,
      ps.started_at           AS planning_session_started_at,
      ps.ended_at             AS planning_session_ended_at,
      ps.total_input_tokens   AS planning_session_input_tokens,
      ps.total_output_tokens  AS planning_session_output_tokens,
      ps.session_type         AS planning_session_type,
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
    LEFT JOIN ranked_planning ps ON ps.task_id = tc.task_id AND ps.rn = 1
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
  arch_store_adopted?: number;
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
    arch_store_adopted: number;
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
        arch_store_adopted = @arch_store_adopted,
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
    arch_store_adopted:
      patch.arch_store_adopted !== undefined
        ? patch.arch_store_adopted
        : (existing.arch_store_adopted ?? 0),
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

/**
 * Thrown when an insert/update would give a project two milestones with the
 * same canonical_short_id — surfaced from the idx_milestones_project_canonical_short_id
 * partial unique index (case-insensitive), since resolveMilestoneForProject's
 * first-match lookup would otherwise silently pick one of the collision.
 */
export class MilestoneCanonicalShortIdCollisionError extends Error {
  constructor(canonicalShortId: string) {
    super(
      `canonical_short_id "${canonicalShortId}" is already used by another milestone in this project`,
    );
    this.name = 'MilestoneCanonicalShortIdCollisionError';
  }
}

function isCanonicalShortIdCollision(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes('idx_milestones_project_canonical_short_id')
  );
}

export function insertMilestone(m: NewMilestoneRow): MilestoneRow {
  const now = Date.now();
  try {
    db.prepare<NewMilestoneRow>(
      `
    INSERT INTO milestones
      (id, project_id, name, source_id, canonical_short_id, display_order, wrapped_at, created_at, updated_at)
    VALUES
      (@id, @project_id, @name, @source_id, @canonical_short_id, @display_order, @wrapped_at, @created_at, @updated_at)
  `,
    ).run({
      ...m,
      display_order: m.display_order ?? 0,
      wrapped_at: m.wrapped_at ?? null,
      created_at: m.created_at ?? now,
      updated_at: m.updated_at ?? now,
    });
  } catch (err) {
    if (isCanonicalShortIdCollision(err)) {
      throw new MilestoneCanonicalShortIdCollisionError(
        m.canonical_short_id ?? '',
      );
    }
    throw err;
  }
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
  canonical_short_id?: string | null;
  display_order?: number;
  wrapped_at?: number | null;
}

export function updateMilestone(
  id: string,
  patch: MilestonePatch,
): MilestoneRow | undefined {
  const existing = getMilestoneById(id);
  if (!existing) return undefined;
  const now = Date.now();
  const nextCanonicalShortId =
    patch.canonical_short_id !== undefined
      ? patch.canonical_short_id
      : existing.canonical_short_id;
  try {
    db.prepare<{
      id: string;
      name: string;
      source_id: string | null;
      canonical_short_id: string | null;
      display_order: number;
      wrapped_at: number | null;
      updated_at: number;
    }>(
      `
    UPDATE milestones
    SET name = @name,
        source_id = @source_id,
        canonical_short_id = @canonical_short_id,
        display_order = @display_order,
        wrapped_at = @wrapped_at,
        updated_at = @updated_at
    WHERE id = @id
  `,
    ).run({
      id,
      name: patch.name ?? existing.name,
      source_id:
        patch.source_id !== undefined ? patch.source_id : existing.source_id,
      canonical_short_id: nextCanonicalShortId,
      display_order: patch.display_order ?? existing.display_order,
      wrapped_at:
        patch.wrapped_at !== undefined ? patch.wrapped_at : existing.wrapped_at,
      updated_at: now,
    });
  } catch (err) {
    if (isCanonicalShortIdCollision(err)) {
      throw new MilestoneCanonicalShortIdCollisionError(
        nextCanonicalShortId ?? '',
      );
    }
    throw err;
  }
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

/**
 * Most recently merged local branch for a source task, joined via the
 * session that carried it. Undefined when the task has no merged session
 * (backfill callers treat that as "unmerged" -> null min_deployed_commit).
 */
export function getMergedLocalBranchForTaskId(
  taskId: string,
): LocalBranchRow | undefined {
  return db
    .prepare<{ task_id: string }>(
      `
    SELECT lb.* FROM local_branches lb
    JOIN sessions s ON s.session_id = lb.session_id
    WHERE s.task_id = @task_id AND lb.status = 'merged'
    ORDER BY lb.updated_at DESC
    LIMIT 1
  `,
    )
    .get({ task_id: taskId }) as LocalBranchRow | undefined;
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

/**
 * Persist a resolved merge commit uniformly for a session, regardless of
 * whether that session already has a local_branches row. GitHub PR sessions
 * never get one from sessionRecovery (only git_mode='local-only' sessions
 * do), so PRMergeWatcher.handleMerged creates it here on first merge —
 * making local_branches.merge_commit_sha the single merge-commit source
 * across both the local-only and GitHub-PR flows.
 */
export function recordMergeCommitForSession(params: {
  sessionId: string;
  projectId: string;
  branchName: string;
  baseBranch: string;
  commitSha: string | null;
}): void {
  const existing = getLocalBranchBySession(params.sessionId);
  if (existing) {
    markLocalBranchMerged(existing.id, params.commitSha);
    return;
  }
  const now = new Date().toISOString();
  const inserted = insertLocalBranch({
    project_id: params.projectId,
    session_id: params.sessionId,
    branch_name: params.branchName,
    base_branch: params.baseBranch,
    status: 'open',
    review_result: null,
    created_at: now,
    updated_at: now,
  });
  markLocalBranchMerged(inserted.id, params.commitSha);
}

/**
 * Latest merge_commit_sha for a task's merged local branch (joined via
 * sessions.task_id, since local_branches has no task_id column of its own).
 * Null when the task has no merged branch.
 */
export function getMergeCommitFromLocalBranches(taskId: string): string | null {
  const row = db
    .prepare<{ task_id: string }>(
      `
    SELECT lb.merge_commit_sha AS merge_commit_sha
    FROM local_branches lb
    JOIN sessions s ON s.session_id = lb.session_id
    WHERE s.task_id = @task_id
      AND lb.status = 'merged'
      AND lb.merge_commit_sha IS NOT NULL
    ORDER BY lb.updated_at DESC
    LIMIT 1
  `,
    )
    .get({ task_id: normalizeTaskId(taskId) }) as
    | { merge_commit_sha: string }
    | undefined;
  return row?.merge_commit_sha ?? null;
}

/**
 * The gate/seed backfill tools' min_deployed_commit source: local_branches
 * first, falling back to the task's merged GitHub PR when local_branches has
 * no covering row (e.g. sessions that predate local_branches tracking). That
 * fallback needs a live lookup: pull_requests only ever persists head_sha,
 * the pre-merge feature-branch tip, never the actual commit landed on the
 * base branch (GitHub's squash/merge/rebase all produce a distinct commit) —
 * substituting head_sha would silently break the deploy-ancestry check. The
 * PR's true merge commit is fetched from GitHub, which retains it
 * indefinitely regardless of how long ago the PR merged.
 */
export async function getMergeCommitForTask(
  taskId: string,
): Promise<string | null> {
  const normalized = normalizeTaskId(taskId);
  const fromLocalBranches = getMergeCommitFromLocalBranches(normalized);
  if (fromLocalBranches) return fromLocalBranches;

  const pr = db
    .prepare<{ task_id: string }>(
      `
    SELECT pr_number, repo
    FROM pull_requests
    WHERE task_id = @task_id
      AND state = 'merged'
    ORDER BY pr_number DESC
    LIMIT 1
  `,
    )
    .get({ task_id: normalized }) as
    | { pr_number: number; repo: string }
    | undefined;
  if (!pr) return null;

  const { GitHubClient } = await import('../github/GitHubClient');
  try {
    return await new GitHubClient().getMergeCommitSha(pr.pr_number, pr.repo);
  } catch (err) {
    logger.warn(
      `[getMergeCommitForTask] GitHub merge-commit lookup failed for PR #${pr.pr_number} in ${pr.repo}:`,
      (err as Error).message,
    );
    return null;
  }
}

// ─── pr_review_comments_routed ────────────────────────────────────────────────

/**
 * Returns comment IDs that should not be re-delivered: those fully
 * acknowledged (routed_state='acked'), plus 'pending' comments whose owning
 * session is still alive (not done/error/killed). A pending comment is
 * excluded from redelivery while the session might still ack it — otherwise
 * it gets re-buffered and re-flushed every quiescence window, triggering a
 * fresh (duplicate) disposition from an alive-but-idle session. Pending
 * comments owned by a crashed/terminal session (or with no resolvable
 * session) are NOT included, preserving at-least-once delivery for a session
 * that died before acking.
 */
export function getRoutedCommentIds(
  prNumber: number,
  repo: string,
): Set<string> {
  const rows = db
    .prepare<{
      pr_number: number;
      repo: string;
    }>(
      `
    SELECT r.comment_id
    FROM pr_review_comments_routed r
    WHERE r.pr_number = @pr_number AND r.repo = @repo
      AND (
        r.routed_state = 'acked'
        OR (
          r.routed_state = 'pending'
          AND EXISTS (
            SELECT 1 FROM pull_requests pr
            JOIN sessions s ON s.session_id = pr.session_id
            WHERE pr.pr_number = r.pr_number AND pr.repo = r.repo
              AND s.status NOT IN ('done', 'error', 'killed')
          )
        )
      )
  `,
    )
    .all({ pr_number: prNumber, repo }) as { comment_id: string }[];
  return new Set(rows.map((r) => r.comment_id));
}

/**
 * Insert comment IDs as pending (at-least-once delivery record). Must be
 * called BEFORE sendOrResume so the record survives a crash between marking
 * and delivery. INSERT OR IGNORE preserves any existing pending row and never
 * flips an already-acked row back to pending.
 */
export function markCommentsPending(
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
    `INSERT OR IGNORE INTO pr_review_comments_routed (pr_number, repo, comment_id, routed_at, routed_state)
     VALUES (@pr_number, @repo, @comment_id, @routed_at, 'pending')`,
  );
  for (const comment_id of commentIds) {
    stmt.run({ pr_number: prNumber, repo, comment_id, routed_at: now });
  }
}

// ─── pr_review_comment_disposition_replies ─────────────────────────────────

/**
 * Returns true if a GitHub reply has already been posted for this exact
 * (comment_id, disposition) pair. Used by ReviewOrchestrator.handleDispositions
 * to guard against re-posting a duplicate reply when a 'pending' comment is
 * redelivered and re-dispositioned by the session.
 */
export function hasDispositionReplyBeenPosted(
  prNumber: number,
  repo: string,
  commentId: string,
  disposition: string,
): boolean {
  const row = db
    .prepare<{
      pr_number: number;
      repo: string;
      comment_id: string;
      disposition: string;
    }>(
      `SELECT 1 FROM pr_review_comment_disposition_replies
       WHERE pr_number = @pr_number AND repo = @repo AND comment_id = @comment_id AND disposition = @disposition`,
    )
    .get({ pr_number: prNumber, repo, comment_id: commentId, disposition });
  return row !== undefined;
}

/** Records that a GitHub reply has been posted for this (comment_id, disposition) pair. */
export function recordDispositionReply(
  prNumber: number,
  repo: string,
  commentId: string,
  disposition: string,
): void {
  db.prepare<{
    pr_number: number;
    repo: string;
    comment_id: string;
    disposition: string;
    replied_at: number;
  }>(
    `INSERT OR IGNORE INTO pr_review_comment_disposition_replies
       (pr_number, repo, comment_id, disposition, replied_at)
     VALUES (@pr_number, @repo, @comment_id, @disposition, @replied_at)`,
  ).run({
    pr_number: prNumber,
    repo,
    comment_id: commentId,
    disposition,
    replied_at: Date.now(),
  });
}

/**
 * Flip all pending comment rows for a PR to acked. Called on successful
 * turn completion in AgentSession to signal that the consuming session has
 * processed the feedback.
 */
export function ackPendingComments(prNumber: number, repo: string): void {
  db.prepare<{ pr_number: number; repo: string }>(
    `UPDATE pr_review_comments_routed SET routed_state = 'acked' WHERE pr_number = @pr_number AND repo = @repo AND routed_state = 'pending'`,
  ).run({ pr_number: prNumber, repo });
}

/**
 * Count routed comments still awaiting acknowledgement for a PR. Used as a
 * quiescence check by AutoMerger's reviewer auto-assignment: reviewers are
 * only requested once all routed feedback has been acked, so the human
 * reviewer isn't pinged while the AI is still mid-conversation on a thread.
 */
export function getPendingRoutedCommentCount(
  prNumber: number,
  repo: string,
): number {
  const row = db
    .prepare<{
      pr_number: number;
      repo: string;
    }>(
      `SELECT COUNT(*) AS count FROM pr_review_comments_routed WHERE pr_number = @pr_number AND repo = @repo AND routed_state = 'pending'`,
    )
    .get({ pr_number: prNumber, repo }) as { count: number };
  return row.count;
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

// ─── project_deployed_sha ──────────────────────────────────────────────────────

/**
 * Records the SHA a project reported as deployed — reported in by the deploy
 * flow (skill→orchestrator direction), one row per project, latest write wins.
 */
export function recordProjectDeployedSha(projectId: string, sha: string): void {
  db.prepare(
    `INSERT INTO project_deployed_sha (project_id, sha, recorded_at)
     VALUES (?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET sha = excluded.sha, recorded_at = excluded.recorded_at`,
  ).run(projectId, sha, new Date().toISOString());
}

export function getProjectDeployedShaRow(
  projectId: string,
): { sha: string; recordedAt: string } | null {
  const row = db
    .prepare(
      `SELECT sha, recorded_at as recordedAt FROM project_deployed_sha WHERE project_id = ?`,
    )
    .get(projectId) as { sha: string; recordedAt: string } | undefined;
  return row ?? null;
}

// ─── deploy_run ───────────────────────────────────────────────────────────
// Statements are cached lazily (prepared on first use, not at module load) so
// importing this module doesn't fail on a not-yet-migrated db handle.

let _stmtGetDeployRun: Database.Statement | null = null;
let _stmtGetActiveDeployRunForProject: Database.Statement | null = null;
let _stmtGetLatestDeployRunForProject: Database.Statement | null = null;
let _stmtInsertDeployRun: Database.Statement | null = null;
let _stmtUpdateDeployRunStep: Database.Statement | null = null;
let _stmtUpdateDeployRunStatus: Database.Statement | null = null;
let _stmtListDeployRunEvents: Database.Statement | null = null;
let _stmtInsertDeployRunEvent: Database.Statement | null = null;

export function getDeployRun(runId: string): DeployRunRow | undefined {
  _stmtGetDeployRun ??= db.prepare<{ run_id: string }>(
    `SELECT * FROM deploy_run WHERE run_id = @run_id`,
  );
  return _stmtGetDeployRun.get({ run_id: runId }) as DeployRunRow | undefined;
}

/** The project's in-flight run, if any — relies on the at-most-one-active-run-per-project index. */
export function getActiveDeployRunForProject(
  project: string,
): DeployRunRow | undefined {
  _stmtGetActiveDeployRunForProject ??= db.prepare<{ project: string }>(
    `SELECT * FROM deploy_run WHERE project = @project AND status = 'running'`,
  );
  return _stmtGetActiveDeployRunForProject.get({ project }) as
    | DeployRunRow
    | undefined;
}

/** The project's most recently started run (running or terminal), if any. */
export function getLatestDeployRunForProject(
  project: string,
): DeployRunRow | undefined {
  _stmtGetLatestDeployRunForProject ??= db.prepare<{ project: string }>(
    `SELECT * FROM deploy_run WHERE project = @project ORDER BY started_at DESC LIMIT 1`,
  );
  return _stmtGetLatestDeployRunForProject.get({ project }) as
    | DeployRunRow
    | undefined;
}

/**
 * Inserts a new deploy_run row. Throws (SQLITE_CONSTRAINT_UNIQUE) if the
 * project already has a run with status = 'running' — enforced by
 * idx_deploy_run_active_per_project rather than a read-then-write check.
 */
export function insertDeployRun(row: DeployRunRow): void {
  _stmtInsertDeployRun ??= db.prepare<DeployRunRow>(`
    INSERT INTO deploy_run
      (run_id, project, target_sha, current_step, status, started_at, completed_at)
    VALUES
      (@run_id, @project, @target_sha, @current_step, @status, @started_at, @completed_at)
  `);
  _stmtInsertDeployRun.run(row);
}

export function updateDeployRunStep(runId: string, step: string): void {
  _stmtUpdateDeployRunStep ??= db.prepare<{ run_id: string; step: string }>(
    `UPDATE deploy_run SET current_step = @step WHERE run_id = @run_id`,
  );
  _stmtUpdateDeployRunStep.run({ run_id: runId, step });
}

export function updateDeployRunStatus(
  runId: string,
  status: string,
  completedAt: string | null,
): void {
  _stmtUpdateDeployRunStatus ??= db.prepare<{
    run_id: string;
    status: string;
    completed_at: string | null;
  }>(
    `UPDATE deploy_run SET status = @status, completed_at = @completed_at WHERE run_id = @run_id`,
  );
  _stmtUpdateDeployRunStatus.run({
    run_id: runId,
    status,
    completed_at: completedAt,
  });
}

export function listDeployRunEvents(runId: string): DeployRunEventRow[] {
  _stmtListDeployRunEvents ??= db.prepare<{ run_id: string }>(
    `SELECT * FROM deploy_run_event WHERE run_id = @run_id ORDER BY id ASC`,
  );
  return _stmtListDeployRunEvents.all({ run_id: runId }) as DeployRunEventRow[];
}

export function insertDeployRunEvent(row: NewDeployRunEventRow): void {
  _stmtInsertDeployRunEvent ??= db.prepare<NewDeployRunEventRow>(`
    INSERT INTO deploy_run_event
      (run_id, step, event_type, disposition, detail, at)
    VALUES
      (@run_id, @step, @event_type, @disposition, @detail, @at)
  `);
  _stmtInsertDeployRunEvent.run(row);
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
  if (!stmtGetSession.get({ session_id: sessionId })) {
    // Parent row is gone — inserting would violate the FK on session_pause_intervals.
    logger.warn(
      `[insertPauseInterval] skipped — session ${sessionId} no longer exists`,
    );
    return;
  }
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

/**
 * Invalidate the permanent per-(pr,repo,sha) F2 test result row so a
 * verified-flaky disposition can trigger a same-SHA re-run. Callers must
 * audit this via recordEvent — deletion alone is silent.
 */
export function deleteTestResult(
  prNumber: number,
  repo: string,
  sha: string,
): void {
  db.prepare<{
    pr_number: number;
    repo: string;
    sha: string;
  }>(
    `DELETE FROM orchestrator_test_results WHERE pr_number = @pr_number AND repo = @repo AND sha = @sha`,
  ).run({ pr_number: prNumber, repo, sha });
}

// ─── orchestrator_analyze_results ───────────────────────────────────────────

export interface AnalyzeResultRow {
  pr_number: number;
  repo: string;
  sha: string;
  passed: number;
  output: string;
  ran_at: string;
  is_transient: number;
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
  isTransient = false,
): void {
  db.prepare<{
    pr_number: number;
    repo: string;
    sha: string;
    passed: number;
    output: string;
    ran_at: string;
    is_transient: number;
  }>(
    `INSERT OR REPLACE INTO orchestrator_analyze_results (pr_number, repo, sha, passed, output, ran_at, is_transient)
     VALUES (@pr_number, @repo, @sha, @passed, @output, @ran_at, @is_transient)`,
  ).run({
    pr_number: prNumber,
    repo,
    sha,
    passed: passed ? 1 : 0,
    output,
    ran_at: new Date().toISOString(),
    is_transient: isTransient ? 1 : 0,
  });
}

export function deleteAnalyzeResult(
  prNumber: number,
  repo: string,
  sha: string,
): void {
  db.prepare<{ pr_number: number; repo: string; sha: string }>(
    `DELETE FROM orchestrator_analyze_results WHERE pr_number = @pr_number AND repo = @repo AND sha = @sha`,
  ).run({ pr_number: prNumber, repo, sha });
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

// ─── convergence_snapshot ───────────────────────────────────────────────────

let _stmtInsertConvergenceSnapshot: Database.Statement | null = null;
let _stmtGetLatestConvergenceSnapshot: Database.Statement | null = null;
let _stmtListConvergenceSnapshotHistory: Database.Statement | null = null;

export function insertConvergenceSnapshot(
  row: NewConvergenceSnapshotRow,
): void {
  _stmtInsertConvergenceSnapshot ??= db.prepare<ConvergenceSnapshotRow>(`
    INSERT INTO convergence_snapshot
      (id, project, milestone, ts, tasks_open, tasks_closed, gate_open, gate_closed,
       seed_open, seed_closed, ops_open, ops_closed, total_scope, distance_to_green, status)
    VALUES
      (@id, @project, @milestone, @ts, @tasks_open, @tasks_closed, @gate_open, @gate_closed,
       @seed_open, @seed_closed, @ops_open, @ops_closed, @total_scope, @distance_to_green, @status)
  `);
  _stmtInsertConvergenceSnapshot.run({
    id: randomUUID(),
    ...row,
  });
}

/** Latest stored snapshot for a milestone — the dedup baseline for ConvergenceSnapshotJob. */
export function getLatestConvergenceSnapshot(
  project: string,
  milestone: string,
): ConvergenceSnapshotRow | undefined {
  _stmtGetLatestConvergenceSnapshot ??= db.prepare<{
    project: string;
    milestone: string;
  }>(
    `SELECT * FROM convergence_snapshot
     WHERE project = @project AND milestone = @milestone
     ORDER BY ts DESC LIMIT 1`,
  );
  return _stmtGetLatestConvergenceSnapshot.get({ project, milestone }) as
    | ConvergenceSnapshotRow
    | undefined;
}

export interface ConvergenceSnapshotHistoryWindow {
  /** Cap on rows returned — the most recent N, still ordered oldest first. */
  limit?: number;
  /** Only rows with ts >= this ISO-8601 timestamp. */
  sinceTs?: string;
}

/**
 * Series for a milestone, oldest first — feeds the burndown viz's history
 * route. With no window, returns the full retained (never-pruned) series, so
 * existing callers keep their current unbounded meaning. A window bounds the
 * query itself rather than relying on the caller to slice a full fetch.
 */
export function listConvergenceSnapshotHistory(
  project: string,
  milestone: string,
  window?: ConvergenceSnapshotHistoryWindow,
): ConvergenceSnapshotRow[] {
  if (!window?.limit && !window?.sinceTs) {
    _stmtListConvergenceSnapshotHistory ??= db.prepare<{
      project: string;
      milestone: string;
    }>(
      `SELECT * FROM convergence_snapshot
       WHERE project = @project AND milestone = @milestone
       ORDER BY ts ASC`,
    );
    return _stmtListConvergenceSnapshotHistory.all({
      project,
      milestone,
    }) as ConvergenceSnapshotRow[];
  }

  const conditions = ['project = @project', 'milestone = @milestone'];
  const params: Record<string, string | number> = { project, milestone };
  if (window.sinceTs) {
    conditions.push('ts >= @sinceTs');
    params.sinceTs = window.sinceTs;
  }

  const whereClause = conditions.join(' AND ');
  if (!window.limit) {
    return db
      .prepare(
        `SELECT * FROM convergence_snapshot WHERE ${whereClause} ORDER BY ts ASC`,
      )
      .all(params) as ConvergenceSnapshotRow[];
  }

  params.limit = window.limit;
  return db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM convergence_snapshot WHERE ${whereClause}
         ORDER BY ts DESC LIMIT @limit
       ) recent
       ORDER BY recent.ts ASC`,
    )
    .all(params) as ConvergenceSnapshotRow[];
}

export interface SchedulerAuditStats {
  job: string;
  lastDurationMs: number | null;
  runCount24h: number;
  errorCount24h: number;
}

const stmtSchedulerAuditStats = db.prepare(`
  WITH ranked AS (
    SELECT
      job,
      status,
      duration_ms,
      started_at,
      ROW_NUMBER() OVER (PARTITION BY job ORDER BY started_at DESC) AS rn
    FROM scheduler_audit
  )
  SELECT
    job,
    MAX(CASE WHEN rn = 1 THEN duration_ms END) AS last_duration_ms,
    SUM(CASE WHEN status IN ('ok', 'failed') AND started_at > datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS run_count_24h,
    SUM(CASE WHEN status = 'failed' AND started_at > datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS error_count_24h
  FROM ranked
  GROUP BY job
`);

export function getSchedulerAuditStats(): SchedulerAuditStats[] {
  const rows = stmtSchedulerAuditStats.all() as Array<{
    job: string;
    last_duration_ms: number | null;
    run_count_24h: number;
    error_count_24h: number;
  }>;
  return rows.map((r) => ({
    job: r.job,
    lastDurationMs: r.last_duration_ms,
    runCount24h: r.run_count_24h,
    errorCount24h: r.error_count_24h,
  }));
}

// ─── task_repo_assignments ─────────────────────────────────────────────────────

/**
 * Write a repo assignment for a task. The `allowedRepos` list is the project's
 * getProjectRepos() result — callers are responsible for passing the correct set.
 * Throws if `repo` is not in `allowedRepos`.
 */
export function setTaskRepoAssignment(
  taskId: string,
  projectId: string,
  repo: string,
  assignedBy: string,
  allowedRepos: string[],
): void {
  if (!allowedRepos.includes(repo)) {
    throw new Error(
      `Repo "${repo}" is not in the project's repo set: [${allowedRepos.join(', ')}]`,
    );
  }
  db.prepare(
    `INSERT OR REPLACE INTO task_repo_assignments (task_id, project_id, repo, assigned_by, assigned_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(taskId, projectId, repo, assignedBy, Date.now());
}

export function getTaskRepoAssignment(
  taskId: string,
): TaskRepoAssignmentRow | undefined {
  return db
    .prepare<{ task_id: string }>(
      `SELECT task_id, project_id, repo, assigned_by, assigned_at
       FROM task_repo_assignments WHERE task_id = @task_id`,
    )
    .get({ task_id: taskId }) as TaskRepoAssignmentRow | undefined;
}

export function deleteTaskRepoAssignment(taskId: string): void {
  db.prepare(`DELETE FROM task_repo_assignments WHERE task_id = ?`).run(taskId);
}

// ─── ops_journal ─────────────────────────────────────────────────────────────
// Statements are cached lazily (prepared on first use, not at module load) so
// importing this module doesn't fail on a not-yet-migrated db handle.

let _stmtGetOpsJournalEntry: Database.Statement | null = null;
let _stmtListOpsJournalEntries: Database.Statement | null = null;
let _stmtUpsertOpsJournalEntry: Database.Statement | null = null;
let _stmtDeleteOpsJournalEntry: Database.Statement | null = null;

export function getOpsJournalEntry(taskId: string): OpsJournalRow | undefined {
  _stmtGetOpsJournalEntry ??= db.prepare<{ task_id: string }>(
    `SELECT * FROM ops_journal WHERE task_id = @task_id`,
  );
  return _stmtGetOpsJournalEntry.get({ task_id: taskId }) as
    | OpsJournalRow
    | undefined;
}

export function listOpsJournalEntries(): OpsJournalRow[] {
  _stmtListOpsJournalEntries ??= db.prepare(`SELECT * FROM ops_journal`);
  return _stmtListOpsJournalEntries.all() as OpsJournalRow[];
}

export function upsertOpsJournalEntry(row: OpsJournalRow): void {
  _stmtUpsertOpsJournalEntry ??= db.prepare<OpsJournalRow>(`
    INSERT INTO ops_journal
      (task_id, project, milestone, state, disposition, worked_in, evidence,
       finding_or_proposal, falsification, filed_followons, needs_from_operator,
       resolution, updated_at)
    VALUES
      (@task_id, @project, @milestone, @state, @disposition, @worked_in, @evidence,
       @finding_or_proposal, @falsification, @filed_followons, @needs_from_operator,
       @resolution, @updated_at)
    ON CONFLICT(task_id) DO UPDATE SET
      project = @project,
      milestone = @milestone,
      state = @state,
      disposition = @disposition,
      worked_in = @worked_in,
      evidence = @evidence,
      finding_or_proposal = @finding_or_proposal,
      falsification = @falsification,
      filed_followons = @filed_followons,
      needs_from_operator = @needs_from_operator,
      resolution = @resolution,
      updated_at = @updated_at
  `);
  _stmtUpsertOpsJournalEntry.run(row);
}

export function deleteOpsJournalEntry(taskId: string): void {
  _stmtDeleteOpsJournalEntry ??= db.prepare<{ task_id: string }>(
    `DELETE FROM ops_journal WHERE task_id = @task_id`,
  );
  _stmtDeleteOpsJournalEntry.run({ task_id: taskId });
}

// ─── gate_item ────────────────────────────────────────────────────────────
// Statements are cached lazily (prepared on first use, not at module load) so
// importing this module doesn't fail on a not-yet-migrated db handle.

let _stmtGetGateItem: Database.Statement | null = null;
let _stmtListGateItemsByMilestone: Database.Statement | null = null;
let _stmtInsertGateItem: Database.Statement | null = null;
let _stmtUpdateGateItem: Database.Statement | null = null;
let _stmtListGateItemSources: Database.Statement | null = null;
let _stmtInsertGateItemSource: Database.Statement | null = null;
let _stmtListGateItemEvents: Database.Statement | null = null;
let _stmtInsertGateItemEvent: Database.Statement | null = null;

export function getGateItem(id: string): GateItemRow | undefined {
  _stmtGetGateItem ??= db.prepare<{ id: string }>(
    `SELECT * FROM gate_item WHERE id = @id`,
  );
  return _stmtGetGateItem.get({ id }) as GateItemRow | undefined;
}

export function listGateItemsByMilestone(
  project: string,
  milestone: string,
): GateItemRow[] {
  _stmtListGateItemsByMilestone ??= db.prepare<{
    project: string;
    milestone: string;
  }>(
    `SELECT * FROM gate_item WHERE project = @project AND milestone = @milestone`,
  );
  return _stmtListGateItemsByMilestone.all({
    project,
    milestone,
  }) as GateItemRow[];
}

export function insertGateItem(row: GateItemRow): void {
  _stmtInsertGateItem ??= db.prepare<GateItemRow>(`
    INSERT INTO gate_item
      (id, project, milestone, text, classification, min_deployed_commit,
       state, current_disposition, updated_at)
    VALUES
      (@id, @project, @milestone, @text, @classification, @min_deployed_commit,
       @state, @current_disposition, @updated_at)
  `);
  _stmtInsertGateItem.run(row);
}

export function updateGateItem(row: GateItemRow): void {
  _stmtUpdateGateItem ??= db.prepare<GateItemRow>(`
    UPDATE gate_item SET
      project = @project,
      milestone = @milestone,
      text = @text,
      classification = @classification,
      min_deployed_commit = @min_deployed_commit,
      state = @state,
      current_disposition = @current_disposition,
      updated_at = @updated_at
    WHERE id = @id
  `);
  _stmtUpdateGateItem.run(row);
}

export function listGateItemSources(gateItemId: string): GateItemSourceRow[] {
  _stmtListGateItemSources ??= db.prepare<{ gate_item_id: string }>(
    `SELECT * FROM gate_item_source WHERE gate_item_id = @gate_item_id ORDER BY id ASC`,
  );
  return _stmtListGateItemSources.all({
    gate_item_id: gateItemId,
  }) as GateItemSourceRow[];
}

export function insertGateItemSource(row: NewGateItemSourceRow): void {
  _stmtInsertGateItemSource ??= db.prepare<NewGateItemSourceRow>(`
    INSERT INTO gate_item_source
      (gate_item_id, source_task_id, source_task_title, merge_commit, added_at)
    VALUES
      (@gate_item_id, @source_task_id, @source_task_title, @merge_commit, @added_at)
  `);
  _stmtInsertGateItemSource.run({
    ...row,
    source_task_id: normalizeTaskId(row.source_task_id),
  });
}

let _stmtUpdateGateItemSourceMergeCommit: Database.Statement | null = null;

export function updateGateItemSourceMergeCommit(
  gateItemId: string,
  sourceTaskId: string,
  mergeCommit: string,
): void {
  _stmtUpdateGateItemSourceMergeCommit ??= db.prepare<{
    gate_item_id: string;
    source_task_id: string;
    merge_commit: string;
  }>(`
    UPDATE gate_item_source SET merge_commit = @merge_commit
    WHERE gate_item_id = @gate_item_id AND source_task_id = @source_task_id
  `);
  _stmtUpdateGateItemSourceMergeCommit.run({
    gate_item_id: gateItemId,
    source_task_id: normalizeTaskId(sourceTaskId),
    merge_commit: mergeCommit,
  });
}

/**
 * Every gate_item id sourced (via gate_item_source) from a task, across every
 * project — the merge-completion consumer's fan-out from `notion_task_id` to
 * the gate_item rows it needs to fill/recompute.
 */
export function listGateItemIdsBySourceTask(sourceTaskId: string): string[] {
  return (
    db
      .prepare<{
        source_task_id: string;
      }>(
        `SELECT DISTINCT gate_item_id AS id FROM gate_item_source WHERE source_task_id = @source_task_id`,
      )
      .all({ source_task_id: normalizeTaskId(sourceTaskId) }) as {
      id: string;
    }[]
  ).map((row) => row.id);
}

/**
 * Every distinct source_task_id still missing gate_item_source.merge_commit —
 * the reconciler catch-up net's candidate set. Callers cross-check each
 * against local_branches (getMergeCommitForTask) to find the ones that are
 * actually merged already; a merge_completed event dropped mid-emit (e.g. a
 * restart) otherwise leaves the fill permanently missing.
 */
export function listUnfilledGateItemSourceTaskIds(): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT source_task_id AS id FROM gate_item_source WHERE merge_commit IS NULL`,
      )
      .all() as { id: string }[]
  ).map((row) => row.id);
}

export function listGateItemEvents(gateItemId: string): GateItemEventRow[] {
  _stmtListGateItemEvents ??= db.prepare<{ gate_item_id: string }>(
    `SELECT * FROM gate_item_event WHERE gate_item_id = @gate_item_id ORDER BY id ASC`,
  );
  return _stmtListGateItemEvents.all({
    gate_item_id: gateItemId,
  }) as GateItemEventRow[];
}

export function insertGateItemEvent(row: NewGateItemEventRow): void {
  _stmtInsertGateItemEvent ??= db.prepare<NewGateItemEventRow>(`
    INSERT INTO gate_item_event
      (gate_item_id, disposition, evidence, filed_followon, deploy_sha, operator, unattended, at)
    VALUES
      (@gate_item_id, @disposition, @evidence, @filed_followon, @deploy_sha, @operator, @unattended, @at)
  `);
  _stmtInsertGateItemEvent.run(row);
}

let _stmtListAllGateItems: Database.Statement | null = null;
let _stmtUpdateGateItemMinDeployedCommit: Database.Statement | null = null;

/** Every gate item across all projects/milestones — the reconciler's working set. */
export function listAllGateItems(): GateItemRow[] {
  _stmtListAllGateItems ??= db.prepare(`SELECT * FROM gate_item`);
  return _stmtListAllGateItems.all() as GateItemRow[];
}

export function updateGateItemMinDeployedCommit(
  id: string,
  minDeployedCommit: string,
  updatedAt: string,
): void {
  _stmtUpdateGateItemMinDeployedCommit ??= db.prepare<{
    id: string;
    min_deployed_commit: string;
    updated_at: string;
  }>(
    `UPDATE gate_item SET min_deployed_commit = @min_deployed_commit, updated_at = @updated_at WHERE id = @id`,
  );
  _stmtUpdateGateItemMinDeployedCommit.run({
    id,
    min_deployed_commit: minDeployedCommit,
    updated_at: updatedAt,
  });
}

let _stmtTouchGateItemUpdatedAt: Database.Statement | null = null;

/** Stamps updated_at only — never touches state/current_disposition. For non-resolving events (e.g. needs-setup). */
export function touchGateItemUpdatedAt(id: string, updatedAt: string): void {
  _stmtTouchGateItemUpdatedAt ??= db.prepare<{
    id: string;
    updated_at: string;
  }>(`UPDATE gate_item SET updated_at = @updated_at WHERE id = @id`);
  _stmtTouchGateItemUpdatedAt.run({
    id,
    updated_at: updatedAt,
  });
}

let _stmtRehomeGateItemsBySourceTask: Database.Statement | null = null;

/**
 * Re-homes every gate_item sourced (via gate_item_source) from a moved task
 * by UPDATE-ing its milestone — the gate accretion carry for a cross-milestone
 * move. min_deployed_commit is untouched: it's commit-based and project-scoped,
 * not milestone-scoped, so a move never invalidates it. Returns the ids
 * touched, for the audit payload.
 */
export function rehomeGateItemsBySourceTask(
  project: string,
  sourceTaskId: string,
  milestone: string,
  updatedAt: string,
): string[] {
  const ids = (
    db
      .prepare<{ project: string; source_task_id: string }>(
        `SELECT DISTINCT gi.id AS id
         FROM gate_item gi
         JOIN gate_item_source gis ON gis.gate_item_id = gi.id
         WHERE gi.project = @project AND gis.source_task_id = @source_task_id`,
      )
      .all({
        project,
        source_task_id: normalizeTaskId(sourceTaskId),
      }) as { id: string }[]
  ).map((row) => row.id);
  if (ids.length === 0) return ids;

  _stmtRehomeGateItemsBySourceTask ??= db.prepare<{
    id: string;
    milestone: string;
    updated_at: string;
  }>(
    `UPDATE gate_item SET milestone = @milestone, updated_at = @updated_at WHERE id = @id`,
  );
  for (const id of ids) {
    _stmtRehomeGateItemsBySourceTask.run({
      id,
      milestone,
      updated_at: updatedAt,
    });
  }
  return ids;
}

/** All gate items for a project, regardless of milestone — the readiness rollup's per-project lookup. */
export function listGateItemsByProject(project: string): GateItemRow[] {
  const stmt = db.prepare<{ project: string }>(
    `SELECT * FROM gate_item WHERE project = @project`,
  );
  return stmt.all({ project }) as GateItemRow[];
}

export interface GateItemFilter {
  project?: string;
  milestone?: string;
  state?: string;
  classification?: GateItemClassification;
  runnable?: boolean;
}

function buildGateItemWhereClause(filter: GateItemFilter): {
  clause: string;
  params: Record<string, string>;
} {
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  if (filter.project) {
    conditions.push('project = @project');
    params.project = filter.project;
  }
  if (filter.milestone) {
    conditions.push('milestone = @milestone');
    params.milestone = filter.milestone;
  }
  if (filter.classification) {
    conditions.push('classification = @classification');
    params.classification = filter.classification;
  }
  if (filter.state) {
    conditions.push('state = @state');
    params.state = filter.state;
  }
  if (filter.runnable !== undefined) {
    conditions.push(
      filter.runnable ? "state = 'runnable'" : "state != 'runnable'",
    );
  }
  return {
    clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/** List-ordering options for listGateItemsFiltered: 'default' is recency; 'not-done-first' surfaces unresolved items first. */
export type GateItemListOrder = 'default' | 'not-done-first';

/** Paginated, filtered read of gate_item — never an unbounded load; caller supplies limit/offset. */
export function listGateItemsFiltered(
  filter: GateItemFilter,
  limit: number,
  offset: number,
  order: GateItemListOrder = 'default',
): GateItemRow[] {
  const { clause, params } = buildGateItemWhereClause(filter);
  const orderClause =
    order === 'not-done-first'
      ? `CASE WHEN state IN ('pass', 'deferred', 'discarded') THEN 1 ELSE 0 END ASC, updated_at DESC, id ASC`
      : `updated_at DESC, id ASC`;
  const stmt = db.prepare(
    `SELECT * FROM gate_item ${clause} ORDER BY ${orderClause} LIMIT @limit OFFSET @offset`,
  );
  return stmt.all({ ...params, limit, offset }) as GateItemRow[];
}

/** Total count matching the same filter as listGateItemsFiltered — powers the `total` in a paginated response. */
export function countGateItemsFiltered(filter: GateItemFilter): number {
  const { clause, params } = buildGateItemWhereClause(filter);
  const stmt = db.prepare(`SELECT COUNT(*) AS count FROM gate_item ${clause}`);
  const row = stmt.get(params) as { count: number };
  return row.count;
}

// ─── gate_accretion ───────────────────────────────────────────────────────

let _stmtGetGateAccretion: Database.Statement | null = null;
let _stmtUpsertGateAccretion: Database.Statement | null = null;

export function getGateAccretion(
  sourceTaskId: string,
): GateAccretionRow | undefined {
  _stmtGetGateAccretion ??= db.prepare<{ source_task_id: string }>(
    `SELECT * FROM gate_accretion WHERE source_task_id = @source_task_id`,
  );
  return _stmtGetGateAccretion.get({
    source_task_id: normalizeTaskId(sourceTaskId),
  }) as GateAccretionRow | undefined;
}

export function upsertGateAccretion(row: GateAccretionRow): void {
  _stmtUpsertGateAccretion ??= db.prepare<GateAccretionRow>(`
    INSERT INTO gate_accretion (source_task_id, project, milestone, decision, reason, accreted_at)
    VALUES (@source_task_id, @project, @milestone, @decision, @reason, @accreted_at)
    ON CONFLICT(source_task_id) DO UPDATE SET
      project = excluded.project,
      milestone = excluded.milestone,
      decision = excluded.decision,
      reason = excluded.reason,
      accreted_at = excluded.accreted_at
  `);
  _stmtUpsertGateAccretion.run({
    ...row,
    source_task_id: normalizeTaskId(row.source_task_id),
  });
}

let _stmtDeleteGateItem: Database.Statement | null = null;
let _stmtDeleteGateAccretion: Database.Statement | null = null;

/**
 * Rolls back a gate accretion: deletes the given gate_item rows (cascades to
 * their gate_item_source/gate_item_event rows) and the source task's
 * gate_accretion marker. Used by the atomic Ready-flip transaction
 * (TaskWriteCommands.flipToReady) to undo a completed accretion when a later
 * step in the flip fails, so no orphan gate_item survives a failed flip.
 */
export function deleteGateContribution(
  itemIds: string[],
  sourceTaskId: string,
): void {
  _stmtDeleteGateItem ??= db.prepare<{ id: string }>(
    `DELETE FROM gate_item WHERE id = @id`,
  );
  _stmtDeleteGateAccretion ??= db.prepare<{ source_task_id: string }>(
    `DELETE FROM gate_accretion WHERE source_task_id = @source_task_id`,
  );
  const tx = db.transaction((ids: string[], normalizedSourceTaskId: string) => {
    for (const id of ids) _stmtDeleteGateItem!.run({ id });
    _stmtDeleteGateAccretion!.run({
      source_task_id: normalizedSourceTaskId,
    });
  });
  tx(itemIds, normalizeTaskId(sourceTaskId));
}

// ─── seed_item ────────────────────────────────────────────────────────────

let _stmtGetSeedItem: Database.Statement | null = null;
let _stmtListSeedItemsByMilestone: Database.Statement | null = null;
let _stmtListAllSeedItems: Database.Statement | null = null;
let _stmtListSeedItemsByProject: Database.Statement | null = null;
let _stmtInsertSeedItem: Database.Statement | null = null;
let _stmtUpdateSeedItem: Database.Statement | null = null;
let _stmtUpdateSeedItemMinDeployedCommit: Database.Statement | null = null;
let _stmtListSeedItemSources: Database.Statement | null = null;
let _stmtInsertSeedItemSource: Database.Statement | null = null;
let _stmtUpdateSeedItemSourceMergeCommit: Database.Statement | null = null;
let _stmtListSeedItemEvents: Database.Statement | null = null;
let _stmtInsertSeedItemEvent: Database.Statement | null = null;

export function getSeedItem(id: string): SeedItemRow | undefined {
  _stmtGetSeedItem ??= db.prepare<{ id: string }>(
    `SELECT * FROM seed_item WHERE id = @id`,
  );
  return _stmtGetSeedItem.get({ id }) as SeedItemRow | undefined;
}

export function listSeedItemsByMilestone(
  project: string,
  milestone: string,
): SeedItemRow[] {
  _stmtListSeedItemsByMilestone ??= db.prepare<{
    project: string;
    milestone: string;
  }>(
    `SELECT * FROM seed_item WHERE project = @project AND milestone = @milestone`,
  );
  return _stmtListSeedItemsByMilestone.all({
    project,
    milestone,
  }) as SeedItemRow[];
}

/** Every seed item across all projects/milestones — the readiness rollup's working set. */
export function listAllSeedItems(): SeedItemRow[] {
  _stmtListAllSeedItems ??= db.prepare(`SELECT * FROM seed_item`);
  return _stmtListAllSeedItems.all() as SeedItemRow[];
}

/** All seed items for a project, regardless of milestone — the readiness rollup's per-project lookup. */
export function listSeedItemsByProject(project: string): SeedItemRow[] {
  _stmtListSeedItemsByProject ??= db.prepare<{ project: string }>(
    `SELECT * FROM seed_item WHERE project = @project`,
  );
  return _stmtListSeedItemsByProject.all({ project }) as SeedItemRow[];
}

export interface SeedItemFilter {
  project?: string;
  milestone?: string;
  state?: string;
}

function buildSeedItemWhereClause(filter: SeedItemFilter): {
  clause: string;
  params: Record<string, string>;
} {
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  if (filter.project) {
    conditions.push('project = @project');
    params.project = filter.project;
  }
  if (filter.milestone) {
    conditions.push('milestone = @milestone');
    params.milestone = filter.milestone;
  }
  if (filter.state) {
    conditions.push('state = @state');
    params.state = filter.state;
  }
  return {
    clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/** List-ordering options for listSeedItemsFiltered: 'default' is recency; 'not-done-first' surfaces unconfirmed items first. */
export type SeedItemListOrder = 'default' | 'not-done-first';

/** Paginated, filtered read of seed_item — never an unbounded load; caller supplies limit/offset. */
export function listSeedItemsFiltered(
  filter: SeedItemFilter,
  limit: number,
  offset: number,
  order: SeedItemListOrder = 'default',
): SeedItemRow[] {
  const { clause, params } = buildSeedItemWhereClause(filter);
  const orderClause =
    order === 'not-done-first'
      ? `CASE WHEN state = 'confirmed' THEN 1 ELSE 0 END ASC, updated_at DESC, id ASC`
      : `updated_at DESC, id ASC`;
  const stmt = db.prepare(
    `SELECT * FROM seed_item ${clause} ORDER BY ${orderClause} LIMIT @limit OFFSET @offset`,
  );
  return stmt.all({ ...params, limit, offset }) as SeedItemRow[];
}

/** Total count matching the same filter as listSeedItemsFiltered — powers the `total` in a paginated response. */
export function countSeedItemsFiltered(filter: SeedItemFilter): number {
  const { clause, params } = buildSeedItemWhereClause(filter);
  const stmt = db.prepare(`SELECT COUNT(*) AS count FROM seed_item ${clause}`);
  const row = stmt.get(params) as { count: number };
  return row.count;
}

export function insertSeedItem(row: SeedItemRow): void {
  _stmtInsertSeedItem ??= db.prepare<SeedItemRow>(`
    INSERT INTO seed_item
      (id, project, milestone, spec, min_deployed_commit, state, updated_at)
    VALUES
      (@id, @project, @milestone, @spec, @min_deployed_commit, @state, @updated_at)
  `);
  _stmtInsertSeedItem.run(row);
}

export function updateSeedItem(row: SeedItemRow): void {
  _stmtUpdateSeedItem ??= db.prepare<SeedItemRow>(`
    UPDATE seed_item SET
      project = @project,
      milestone = @milestone,
      spec = @spec,
      min_deployed_commit = @min_deployed_commit,
      state = @state,
      updated_at = @updated_at
    WHERE id = @id
  `);
  _stmtUpdateSeedItem.run(row);
}

export function updateSeedItemMinDeployedCommit(
  id: string,
  minDeployedCommit: string,
  updatedAt: string,
): void {
  _stmtUpdateSeedItemMinDeployedCommit ??= db.prepare<{
    id: string;
    min_deployed_commit: string;
    updated_at: string;
  }>(
    `UPDATE seed_item SET min_deployed_commit = @min_deployed_commit, updated_at = @updated_at WHERE id = @id`,
  );
  _stmtUpdateSeedItemMinDeployedCommit.run({
    id,
    min_deployed_commit: minDeployedCommit,
    updated_at: updatedAt,
  });
}

let _stmtRehomeSeedItemsBySourceTask: Database.Statement | null = null;

/**
 * Re-homes every seed_item sourced (via seed_item_source) from a moved task
 * by UPDATE-ing its milestone — the seed accretion carry for a cross-milestone
 * move. min_deployed_commit is untouched: it's commit-based and project-scoped,
 * not milestone-scoped, so a move never invalidates it. Returns the ids
 * touched, for the audit payload.
 */
export function rehomeSeedItemsBySourceTask(
  project: string,
  sourceTaskId: string,
  milestone: string,
  updatedAt: string,
): string[] {
  const ids = (
    db
      .prepare<{ project: string; source_task_id: string }>(
        `SELECT DISTINCT si.id AS id
         FROM seed_item si
         JOIN seed_item_source sis ON sis.seed_item_id = si.id
         WHERE si.project = @project AND sis.source_task_id = @source_task_id`,
      )
      .all({ project, source_task_id: normalizeTaskId(sourceTaskId) }) as {
      id: string;
    }[]
  ).map((row) => row.id);
  if (ids.length === 0) return ids;

  _stmtRehomeSeedItemsBySourceTask ??= db.prepare<{
    id: string;
    milestone: string;
    updated_at: string;
  }>(
    `UPDATE seed_item SET milestone = @milestone, updated_at = @updated_at WHERE id = @id`,
  );
  for (const id of ids) {
    _stmtRehomeSeedItemsBySourceTask.run({
      id,
      milestone,
      updated_at: updatedAt,
    });
  }
  return ids;
}

export function listSeedItemSources(seedItemId: string): SeedItemSourceRow[] {
  _stmtListSeedItemSources ??= db.prepare<{ seed_item_id: string }>(
    `SELECT * FROM seed_item_source WHERE seed_item_id = @seed_item_id ORDER BY id ASC`,
  );
  return _stmtListSeedItemSources.all({
    seed_item_id: seedItemId,
  }) as SeedItemSourceRow[];
}

export function insertSeedItemSource(row: NewSeedItemSourceRow): void {
  _stmtInsertSeedItemSource ??= db.prepare<NewSeedItemSourceRow>(`
    INSERT INTO seed_item_source
      (seed_item_id, source_task_id, source_task_title, merge_commit, added_at)
    VALUES
      (@seed_item_id, @source_task_id, @source_task_title, @merge_commit, @added_at)
  `);
  _stmtInsertSeedItemSource.run({
    ...row,
    source_task_id: normalizeTaskId(row.source_task_id),
  });
}

export function updateSeedItemSourceMergeCommit(
  seedItemId: string,
  sourceTaskId: string,
  mergeCommit: string,
): void {
  _stmtUpdateSeedItemSourceMergeCommit ??= db.prepare<{
    seed_item_id: string;
    source_task_id: string;
    merge_commit: string;
  }>(`
    UPDATE seed_item_source SET merge_commit = @merge_commit
    WHERE seed_item_id = @seed_item_id AND source_task_id = @source_task_id
  `);
  _stmtUpdateSeedItemSourceMergeCommit.run({
    seed_item_id: seedItemId,
    source_task_id: sourceTaskId,
    merge_commit: mergeCommit,
  });
}

export function listSeedItemEvents(seedItemId: string): SeedItemEventRow[] {
  _stmtListSeedItemEvents ??= db.prepare<{ seed_item_id: string }>(
    `SELECT * FROM seed_item_event WHERE seed_item_id = @seed_item_id ORDER BY id ASC`,
  );
  return _stmtListSeedItemEvents.all({
    seed_item_id: seedItemId,
  }) as SeedItemEventRow[];
}

export function insertSeedItemEvent(row: NewSeedItemEventRow): void {
  _stmtInsertSeedItemEvent ??= db.prepare<NewSeedItemEventRow>(`
    INSERT INTO seed_item_event
      (seed_item_id, outcome, evidence, filed_followon, operator, at)
    VALUES
      (@seed_item_id, @outcome, @evidence, @filed_followon, @operator, @at)
  `);
  _stmtInsertSeedItemEvent.run(row);
}

// ─── seed_accretion ─────────────────────────────────────────────────────────

let _stmtGetSeedAccretion: Database.Statement | null = null;
let _stmtUpsertSeedAccretion: Database.Statement | null = null;

export function getSeedAccretion(
  sourceTaskId: string,
): SeedAccretionRow | undefined {
  _stmtGetSeedAccretion ??= db.prepare<{ source_task_id: string }>(
    `SELECT * FROM seed_accretion WHERE source_task_id = @source_task_id`,
  );
  return _stmtGetSeedAccretion.get({
    source_task_id: normalizeTaskId(sourceTaskId),
  }) as SeedAccretionRow | undefined;
}

export function upsertSeedAccretion(row: SeedAccretionRow): void {
  _stmtUpsertSeedAccretion ??= db.prepare<SeedAccretionRow>(`
    INSERT INTO seed_accretion (source_task_id, project, milestone, decision, accreted_at)
    VALUES (@source_task_id, @project, @milestone, @decision, @accreted_at)
    ON CONFLICT(source_task_id) DO UPDATE SET
      project = excluded.project,
      milestone = excluded.milestone,
      decision = excluded.decision,
      accreted_at = excluded.accreted_at
  `);
  _stmtUpsertSeedAccretion.run({
    ...row,
    source_task_id: normalizeTaskId(row.source_task_id),
  });
}

let _stmtDeleteSeedItem: Database.Statement | null = null;
let _stmtDeleteSeedAccretion: Database.Statement | null = null;

/**
 * Rolls back a seed accretion: deletes the given seed_item rows (cascades to
 * their seed_item_source/seed_item_event rows) and the source task's
 * seed_accretion marker. Used by the atomic Ready-flip transaction
 * (TaskWriteCommands.flipToReady) to undo a completed accretion when a later
 * step in the flip fails, so no orphan seed_item survives a failed flip.
 */
export function deleteSeedContribution(
  itemIds: string[],
  sourceTaskId: string,
): void {
  _stmtDeleteSeedItem ??= db.prepare<{ id: string }>(
    `DELETE FROM seed_item WHERE id = @id`,
  );
  _stmtDeleteSeedAccretion ??= db.prepare<{ source_task_id: string }>(
    `DELETE FROM seed_accretion WHERE source_task_id = @source_task_id`,
  );
  const tx = db.transaction((ids: string[], normalizedSourceTaskId: string) => {
    for (const id of ids) _stmtDeleteSeedItem!.run({ id });
    _stmtDeleteSeedAccretion!.run({
      source_task_id: normalizedSourceTaskId,
    });
  });
  tx(itemIds, normalizeTaskId(sourceTaskId));
}

// ─── session_feedback_inbox ─────────────────────────────────────────────────

export function enqueueFeedbackItem(
  sessionId: string,
  source: string,
  payload: string,
): void {
  db.prepare(
    `INSERT INTO session_feedback_inbox (session_id, source, payload, enqueued_at)
     VALUES (?, ?, ?, ?)`,
  ).run(sessionId, source, payload, Date.now());
}

export function listUndeliveredInboxItems(
  sessionId: string,
): FeedbackInboxRow[] {
  return db
    .prepare(
      `SELECT id, session_id, source, payload, enqueued_at, delivered_at
       FROM session_feedback_inbox
       WHERE session_id = ? AND delivered_at IS NULL
       ORDER BY enqueued_at ASC`,
    )
    .all(sessionId) as FeedbackInboxRow[];
}

export function markInboxItemsDelivered(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(
    `UPDATE session_feedback_inbox SET delivered_at = ? WHERE id IN (${placeholders})`,
  ).run(Date.now(), ...ids);
}

export function listSessionsWithUndeliveredInboxItems(): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT session_id FROM session_feedback_inbox WHERE delivered_at IS NULL`,
    )
    .all() as { session_id: string }[];
  return rows.map((r) => r.session_id);
}

export function countUndeliveredInboxItems(sessionId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM session_feedback_inbox WHERE session_id = ? AND delivered_at IS NULL`,
    )
    .get(sessionId) as { count: number };
  return row.count;
}

// ─── completeness_disposition ───────────────────────────────────────────────

let _stmtInsertCompletenessDisposition: Database.Statement | null = null;
let _stmtListCompletenessDispositions: Database.Statement | null = null;

/** Durable write-through for a /design completeness-critic run — symmetric with the gate/seed accretion markers. */
export function insertCompletenessDisposition(
  row: NewCompletenessDispositionRow,
): CompletenessDispositionRow {
  _stmtInsertCompletenessDisposition ??=
    db.prepare<NewCompletenessDispositionRow>(`
    INSERT INTO completeness_disposition
      (source_task_id, project, milestone, questions, run_at)
    VALUES
      (@source_task_id, @project, @milestone, @questions, @run_at)
  `);
  const result = _stmtInsertCompletenessDisposition.run({
    ...row,
    source_task_id: normalizeTaskId(row.source_task_id),
  });
  return {
    id: Number(result.lastInsertRowid),
    ...row,
    source_task_id: normalizeTaskId(row.source_task_id),
  };
}

/** Audit read of every completeness-disposition run recorded for a source design task, newest first. */
export function listCompletenessDispositions(
  sourceTaskId: string,
): CompletenessDispositionRow[] {
  _stmtListCompletenessDispositions ??= db.prepare<{
    source_task_id: string;
  }>(`
    SELECT * FROM completeness_disposition
    WHERE source_task_id = @source_task_id
    ORDER BY run_at DESC, id DESC
  `);
  return _stmtListCompletenessDispositions.all({
    source_task_id: normalizeTaskId(sourceTaskId),
  }) as CompletenessDispositionRow[];
}

let _stmtGetCompletenessDisposition: Database.Statement | null = null;
let _stmtUpdateCompletenessDispositionApproval: Database.Statement | null =
  null;
let _stmtDeleteCompletenessDisposition: Database.Statement | null = null;

/** Point read of one completeness-disposition run by id — the row a staged `completeness.disposition` intent's payload names. */
function getCompletenessDisposition(
  id: number,
): CompletenessDispositionRow | undefined {
  _stmtGetCompletenessDisposition ??= db.prepare<{ id: number }>(`
    SELECT * FROM completeness_disposition WHERE id = @id
  `);
  return _stmtGetCompletenessDisposition.get({ id }) as
    | CompletenessDispositionRow
    | undefined;
}

/**
 * Advances every question in one completeness-disposition run's record off
 * `proposed` to `approved`, once the operator approves the run's staged
 * intent. The durable write-through at critic time (`proposed`) happens
 * immediately, before this ever runs, so a session dying mid-pass never
 * loses the findings; this only resolves the lifecycle once the operator has
 * actually approved them. A rejection instead deletes the row outright — see
 * deleteCompletenessDisposition — so there is no `rejected` terminal state
 * to advance to here.
 */
export function updateCompletenessDispositionApproval(
  id: number,
  approvalStatus: 'approved',
): CompletenessDispositionRow | undefined {
  const row = getCompletenessDisposition(id);
  if (!row) return undefined;
  const record = JSON.parse(row.questions) as CompletenessDispositionRecord;
  const updatedRecord: CompletenessDispositionRecord = {
    probed: record.probed,
    questions: record.questions.map((q) => ({ ...q, approvalStatus })),
  };
  const updatedQuestions = JSON.stringify(updatedRecord);
  _stmtUpdateCompletenessDispositionApproval ??= db.prepare<{
    id: number;
    questions: string;
  }>(`
    UPDATE completeness_disposition SET questions = @questions WHERE id = @id
  `);
  _stmtUpdateCompletenessDispositionApproval.run({
    id,
    questions: updatedQuestions,
  });
  return { ...row, questions: updatedQuestions };
}

/**
 * Removes a completeness-disposition run outright — the reject-time
 * counterpart to insertCompletenessDisposition's stage-time durable write.
 * Rejecting the run's staged `completeness.disposition` intent calls this
 * (routes/stagedIntents.ts) so the store never carries an orphaned row for
 * a run the operator explicitly declined; a session is still free to re-run
 * the critic and stage a fresh disposition afterward.
 */
export function deleteCompletenessDisposition(id: number): void {
  _stmtDeleteCompletenessDisposition ??= db.prepare<{ id: number }>(`
    DELETE FROM completeness_disposition WHERE id = @id
  `);
  _stmtDeleteCompletenessDisposition.run({ id });
}

/**
 * Shared row-shape builder for the completeness-disposition durable write —
 * used identically by the completeness.disposition MCP tool
 * (mcp/tools/completenessTools.ts) and the device-authed HTTP route
 * (routes/design.ts), so the two writers can never diverge on defaulting.
 * `probed` is stored verbatim (the caller has already validated it is
 * non-empty). Every question defaults to `approvalStatus: 'proposed'`
 * (recorded is not approved), and `runAt` is normalized to a full ISO
 * timestamp — a bare date-only string (or any other Date-parseable value)
 * round-trips to one via `toISOString()`; the caller is expected to have
 * already rejected a value Date cannot parse.
 */
export function buildCompletenessDispositionRow(input: {
  taskId: string;
  project: string | null;
  milestone: string | null;
  probed: CompletenessProbedGapClass[];
  questions: CompletenessDispositionQuestion[];
  runAt: string;
}): NewCompletenessDispositionRow {
  const parsedRunAt = new Date(input.runAt);
  const runAt = Number.isNaN(parsedRunAt.getTime())
    ? input.runAt
    : parsedRunAt.toISOString();
  const record: CompletenessDispositionRecord = {
    probed: input.probed,
    questions: input.questions.map((q) => ({
      approvalStatus: 'proposed' as const,
      ...q,
    })),
  };
  return {
    source_task_id: input.taskId,
    project: input.project,
    milestone: input.milestone,
    questions: JSON.stringify(record),
    run_at: runAt,
  };
}

// ─── staged_intent ────────────────────────────────────────────────────────
// The durable per-intent lifecycle store: staged -> approved -> committed |
// rejected | superseded. Content-idempotent dedup keys on (project_id, kind,
// task_id, payload_hash) — see findActiveStagedIntentForTask / stageOrDedup
// callers in routes/stagedIntents.ts.

/** Canonical (key-sorted) JSON stringify so structurally-equal payloads hash equal regardless of key order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function hashIntentPayload(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload ?? null)))
    .digest('hex');
}

// staged -> committed is legal directly (not only via approved): apply today
// is a single human-gated action with no separate approve step yet (that's
// the M12 decision-surface task) — apply implicitly approves-then-commits.
const STAGED_INTENT_TRANSITIONS: Record<
  StagedIntentState,
  StagedIntentState[]
> = {
  staged: [
    'pending_verification',
    'approved',
    'committed',
    'rejected',
    'needs_revision',
    'superseded',
    'withdrawn',
  ],
  pending_verification: ['staged', 'needs_revision'],
  // 'staged' is reachable here only via the operator-initiated wedged-group
  // recovery route (POST /staged-intents/group/:groupId/recover) — it
  // re-surfaces an intent onto the normal staged/approved surface so the
  // usual commit or per-item disposition routes can act on it again.
  needs_revision: ['staged', 'rejected', 'superseded'],
  approved: [
    'staged',
    'committed',
    'rejected',
    'needs_revision',
    'superseded',
    'withdrawn',
  ],
  committed: [],
  rejected: [],
  superseded: [],
  withdrawn: [],
};

export class IllegalStagedIntentTransitionError extends Error {
  constructor(id: string, from: StagedIntentState, to: StagedIntentState) {
    super(`[staged_intent] illegal transition for "${id}": ${from} -> ${to}`);
    this.name = 'IllegalStagedIntentTransitionError';
  }
}

let _stmtInsertStagedIntent: Database.Statement | null = null;
let _stmtGetStagedIntent: Database.Statement | null = null;
let _stmtListStagedIntentsByProject: Database.Statement | null = null;
let _stmtListStagedIntentsByGroup: Database.Statement | null = null;
let _stmtFindActiveStagedIntentForTask: Database.Statement | null = null;
let _stmtUpdateStagedIntentState: Database.Statement | null = null;
let _stmtHasStagedIntentForTask: Database.Statement | null = null;
let _stmtHasActiveCapabilityRequestForSession: Database.Statement | null = null;

export function insertStagedIntent(row: StagedIntentRow): void {
  _stmtInsertStagedIntent ??= db.prepare<StagedIntentRow>(`
    INSERT INTO staged_intent
      (id, kind, payload, payload_hash, task_id, project_id, session_id,
       group_id, milestone, state, supersedes, annotation, decision_proposal, groom_proposal,
       advisory, disposition_reason, answer, created_at, updated_at)
    VALUES
      (@id, @kind, @payload, @payload_hash, @task_id, @project_id, @session_id,
       @group_id, @milestone, @state, @supersedes, @annotation, @decision_proposal, @groom_proposal,
       @advisory, @disposition_reason, @answer, @created_at, @updated_at)
  `);
  _stmtInsertStagedIntent.run(row);
}

export function getStagedIntent(id: string): StagedIntentRow | undefined {
  _stmtGetStagedIntent ??= db.prepare<{ id: string }>(
    `SELECT * FROM staged_intent WHERE id = @id`,
  );
  return _stmtGetStagedIntent.get({ id }) as StagedIntentRow | undefined;
}

/**
 * True if ANY planning-session attempt for this task has ever staged at
 * least one intent (any lifecycle state), across the task's full crash/retry
 * history — not just the current session. Used to distinguish a genuinely
 * decision-less planning task (backstop: planning_terminal_no_decision) from
 * one where a decision was staged on an earlier attempt before it crashed.
 */
export function hasStagedIntentForTask(taskId: string): boolean {
  _stmtHasStagedIntentForTask ??= db.prepare<{ task_id: string }>(
    `SELECT 1 FROM staged_intent WHERE task_id = @task_id LIMIT 1`,
  );
  return _stmtHasStagedIntentForTask.get({ task_id: taskId }) !== undefined;
}

let _stmtGetLatestNoOpForTask: Database.Statement | null = null;

/**
 * The task's most recent planning.noOp staged intent (by creation order),
 * in whatever state it currently holds. isGroomNoOpSuppressed reads its
 * state/updated_at to decide whether the deliberate "leave it at Backlog"
 * decision it recorded still stands.
 */
export function getLatestNoOpForTask(
  taskId: string,
): StagedIntentRow | undefined {
  _stmtGetLatestNoOpForTask ??= db.prepare<{ task_id: string }>(
    `SELECT * FROM staged_intent
     WHERE task_id = @task_id AND kind = 'planning.noOp'
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  return _stmtGetLatestNoOpForTask.get({ task_id: taskId }) as
    | StagedIntentRow
    | undefined;
}

/**
 * True while a task's most recent planning.noOp still suppresses
 * auto-grooming candidacy. Only a no-op that reached `committed` represents
 * an accepted operator decision — staged, rejected and superseded carry no
 * acceptance and never suppress. Suppression is derived from the committed
 * intent itself, not from the staging session's status, so it holds after
 * that session reaches a terminal state (see isGroomCandidate). It retires
 * the moment a task_body_updated or task_deps_updated audit event lands for
 * the task after the no-op's commit timestamp (its `updated_at`) — the
 * conditions the no-op was reasoned against changing reopens candidacy with
 * no operator action required.
 */
export function isGroomNoOpSuppressed(taskId: string): boolean {
  const noOp = getLatestNoOpForTask(taskId);
  if (!noOp || noOp.state !== 'committed') return false;
  return !hasTaskEditSinceTimestamp(taskId, noOp.updated_at);
}

/**
 * True if this session has an unresolved `session.requestCapability` intent
 * (state `staged` or `approved`) awaiting an operator decision — the sanctioned
 * ask-permission path a dispatched verify/ops session uses instead of being
 * silently blocked or fabricating a result. A gate-verify (one-shot) session
 * with an outstanding request must park idle for grant-on-re-dispatch rather
 * than being concluded done (see AgentSession.handleCleanExit).
 */
export function hasActiveCapabilityRequestForSession(
  sessionId: string,
): boolean {
  _stmtHasActiveCapabilityRequestForSession ??= db.prepare<{
    session_id: string;
  }>(
    `SELECT 1 FROM staged_intent
     WHERE session_id = @session_id
       AND kind = 'session.requestCapability'
       AND state IN ('staged', 'approved')
     LIMIT 1`,
  );
  return (
    _stmtHasActiveCapabilityRequestForSession.get({ session_id: sessionId }) !==
    undefined
  );
}

/**
 * True when an `idle` session is idling specifically because it is parked
 * awaiting a capability disposition — a named, expected state distinct from
 * a generic idle. This is always a legitimate park: the session asked for a
 * capability and is waiting for an answer only the operator can give, never
 * a stalled or abandoned session. Consumers that treat generic idle as a
 * candidate for staleness handling (orphan sweep, nudge, revert-to-Ready,
 * crash-budget accounting) must check this first and skip if true, rather
 * than re-deriving "awaiting a capability" from intent state themselves.
 */
export function isSessionAwaitingCapabilityDisposition(
  session: Pick<Session, 'status' | 'session_id'>,
): boolean {
  return (
    session.status === 'idle' &&
    hasActiveCapabilityRequestForSession(session.session_id)
  );
}

/** Active (non-terminal-tombstone) intents for a project — superseded rows are always hidden. */
export function listStagedIntentsByProject(
  projectId: string,
): StagedIntentRow[] {
  _stmtListStagedIntentsByProject ??= db.prepare<{ project_id: string }>(
    `SELECT * FROM staged_intent
     WHERE project_id = @project_id AND state IN ('staged', 'approved')
     ORDER BY created_at ASC`,
  );
  return _stmtListStagedIntentsByProject.all({
    project_id: projectId,
  }) as StagedIntentRow[];
}

export function listAllActiveStagedIntents(): StagedIntentRow[] {
  return db
    .prepare(
      `SELECT * FROM staged_intent WHERE state IN ('staged', 'approved') ORDER BY created_at ASC`,
    )
    .all() as StagedIntentRow[];
}

/** The milestone key the ?milestone list lens uses to bucket legacy/unattributable rows — never a real milestone's canonical_short_id. */
export const UNATTRIBUTED_MILESTONE_BUCKET = 'unattributed';

let _stmtListStagedIntentsByMilestone: Database.Statement | null = null;
let _stmtListStagedIntentsUnattributed: Database.Statement | null = null;

/**
 * Active (staged/approved) *plus* blocked (needs_revision/pending_verification)
 * intents for a project scoped to one milestone — the decision-inbox's
 * ?milestone list lens. Blocked states are included, not just active ones,
 * so a group with a blocked member still surfaces as a card the operator can
 * act on (decline the member, or reject the group) instead of silently
 * vanishing from the inbox the moment a member falls out of staged/approved —
 * exactly the state that used to leave a wedged group with no operator-usable
 * surface at all. `UNATTRIBUTED_MILESTONE_BUCKET` resolves to every row with
 * milestone IS NULL (legacy rows, or a stage-time attribution that couldn't
 * be resolved) instead of an exact-match filter — these rows are never
 * dropped from the surface, just bucketed separately.
 */
export function listStagedIntentsByMilestone(
  projectId: string,
  milestone: string,
): StagedIntentRow[] {
  if (milestone === UNATTRIBUTED_MILESTONE_BUCKET) {
    _stmtListStagedIntentsUnattributed ??= db.prepare<{
      project_id: string;
    }>(
      `SELECT * FROM staged_intent
       WHERE project_id = @project_id AND milestone IS NULL
         AND state IN ('staged', 'approved', 'needs_revision', 'pending_verification')
       ORDER BY created_at ASC`,
    );
    return _stmtListStagedIntentsUnattributed.all({
      project_id: projectId,
    }) as StagedIntentRow[];
  }
  _stmtListStagedIntentsByMilestone ??= db.prepare<{
    project_id: string;
    milestone: string;
  }>(
    `SELECT * FROM staged_intent
     WHERE project_id = @project_id AND milestone = @milestone
       AND state IN ('staged', 'approved', 'needs_revision', 'pending_verification')
     ORDER BY created_at ASC`,
  );
  return _stmtListStagedIntentsByMilestone.all({
    project_id: projectId,
    milestone,
  }) as StagedIntentRow[];
}

/**
 * Best-effort, run-once-at-boot backfill for rows staged before the
 * milestone column existed: for every staged_intent with milestone IS NULL
 * and a task_id, attempts to resolve the owning milestone via
 * resolveMilestoneForTaskId and, if found, persists it. Rows that can't be
 * resolved (no cached board membership, non-milestone task, etc.) are left
 * NULL — they stay visible in the "unattributed" bucket rather than being
 * dropped. Never throws; a resolution failure for one row just skips it.
 */
export function backfillStagedIntentMilestones(
  resolve: (projectId: string, taskId: string) => string | null,
): number {
  const rows = db
    .prepare(
      `SELECT id, project_id, task_id FROM staged_intent WHERE milestone IS NULL AND task_id IS NOT NULL`,
    )
    .all() as { id: string; project_id: string; task_id: string }[];
  if (rows.length === 0) return 0;

  const update = db.prepare<{ id: string; milestone: string }>(
    `UPDATE staged_intent SET milestone = @milestone WHERE id = @id`,
  );
  let updated = 0;
  for (const row of rows) {
    let milestone: string | null;
    try {
      milestone = resolve(row.project_id, row.task_id);
    } catch {
      milestone = null;
    }
    if (milestone) {
      update.run({ id: row.id, milestone });
      updated += 1;
    }
  }
  return updated;
}

/** All intents (any state, including tombstones) for a group — used by group-scoped invariant checks. */
export function listStagedIntentsByGroup(groupId: string): StagedIntentRow[] {
  _stmtListStagedIntentsByGroup ??= db.prepare<{ group_id: string }>(
    `SELECT * FROM staged_intent WHERE group_id = @group_id ORDER BY created_at ASC`,
  );
  return _stmtListStagedIntentsByGroup.all({
    group_id: groupId,
  }) as StagedIntentRow[];
}

let _stmtListStagedIntentsBySession: Database.Statement | null = null;

/**
 * All intents (any state, including tombstones) originated by a session —
 * used by PlanningOrchestrator to correlate operator dispositions back to
 * the parked planning session and to detect end-of-turn terminal state.
 */
export function listStagedIntentsBySession(
  sessionId: string,
): StagedIntentRow[] {
  _stmtListStagedIntentsBySession ??= db.prepare<{ session_id: string }>(
    `SELECT * FROM staged_intent WHERE session_id = @session_id ORDER BY created_at ASC`,
  );
  return _stmtListStagedIntentsBySession.all({
    session_id: sessionId,
  }) as StagedIntentRow[];
}

let _stmtHasActiveStagedIntentForSession: Database.Statement | null = null;

/**
 * Derived "is this session's proposal set complete" signal — never a
 * persisted flag. True exactly when the session's turn is not in flight AND
 * it has at least one currently-active (staged/approved) staged intent.
 * Turn-in-flight lives only on the live AgentSession instance and is never
 * persisted (see AgentSession.hasActiveTurn()/_turnInFlight) — callers must
 * supply it; a session with no live instance in this process (parked across
 * a restart, or never spawned here) has no turn in flight by construction.
 * A wake (AgentSession.sendMessage) flips turn-in-flight back to true, so a
 * previously-complete session's staged intents refuse disposition again
 * until the resumed turn ends — no extra bookkeeping needed.
 */
export function isSessionComplete(
  sessionId: string,
  turnInFlight: boolean,
): boolean {
  if (turnInFlight) return false;
  _stmtHasActiveStagedIntentForSession ??= db.prepare<{
    session_id: string;
  }>(
    `SELECT 1 FROM staged_intent
     WHERE session_id = @session_id AND state IN ('staged', 'approved')
     LIMIT 1`,
  );
  return (
    _stmtHasActiveStagedIntentForSession.get({ session_id: sessionId }) !==
    undefined
  );
}

/** The standing staged/approved intent (if any) for this project+kind+task — the dedup slot. */
export function findActiveStagedIntentForTask(
  projectId: string,
  kind: string,
  taskId: string,
): StagedIntentRow | undefined {
  _stmtFindActiveStagedIntentForTask ??= db.prepare<{
    project_id: string;
    kind: string;
    task_id: string;
  }>(
    `SELECT * FROM staged_intent
     WHERE project_id = @project_id AND kind = @kind AND task_id = @task_id
       AND state IN ('staged', 'approved')
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  return _stmtFindActiveStagedIntentForTask.get({
    project_id: projectId,
    kind,
    task_id: taskId,
  }) as StagedIntentRow | undefined;
}

let _stmtFindActiveStagedIntentByTitleForSession: Database.Statement | null =
  null;

/**
 * The standing staged/approved intent (if any) for this project+kind+session
 * whose payload title normalizes to the same value — the dedup slot for
 * kinds with no pre-existing task to key on (task.create, arch.createUnit).
 * Scoped to session_id, not just project_id: two different sessions
 * proposing similarly-titled tasks are not duplicates (see
 * findActiveStagedIntentForTask for the task-scoped counterpart).
 */
export function findActiveStagedIntentByTitleForSession(
  projectId: string,
  kind: string,
  sessionId: string,
  normalizedTitle: string,
): StagedIntentRow | undefined {
  _stmtFindActiveStagedIntentByTitleForSession ??= db.prepare<{
    project_id: string;
    kind: string;
    session_id: string;
    normalized_title: string;
  }>(
    `SELECT * FROM staged_intent
     WHERE project_id = @project_id AND kind = @kind AND session_id = @session_id
       AND state IN ('staged', 'approved')
       AND lower(trim(json_extract(payload, '$.title'))) = @normalized_title
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  return _stmtFindActiveStagedIntentByTitleForSession.get({
    project_id: projectId,
    kind,
    session_id: sessionId,
    normalized_title: normalizedTitle,
  }) as StagedIntentRow | undefined;
}

let _stmtFindActiveDecisionPickOneForSession: Database.Statement | null = null;

/**
 * The standing staged/approved decision.pickOne (if any) for this session
 * whose payload prompt normalizes to the same value — the dedup slot for
 * question-intents, which carry no taskId to dedup on. Keyed on
 * (sessionId, normalized prompt) rather than session alone, mirroring
 * findActiveStagedIntentByTitleForSession's title-keying for task.create:
 * a session staging several independent open questions must keep them all
 * live, while re-staging the same question still retires its own prior
 * draft (see findActiveStagedIntentForTask for the task-scoped counterpart).
 */
export function findActiveDecisionPickOneForSession(
  sessionId: string,
  normalizedPrompt: string,
): StagedIntentRow | undefined {
  _stmtFindActiveDecisionPickOneForSession ??= db.prepare<{
    session_id: string;
    normalized_prompt: string;
  }>(
    `SELECT * FROM staged_intent
     WHERE session_id = @session_id AND kind = 'decision.pickOne'
       AND state IN ('staged', 'approved')
       AND lower(trim(json_extract(payload, '$.prompt'))) = @normalized_prompt
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  return _stmtFindActiveDecisionPickOneForSession.get({
    session_id: sessionId,
    normalized_prompt: normalizedPrompt,
  }) as StagedIntentRow | undefined;
}

/**
 * Enforces the per-intent lifecycle state machine. `committed` is a terminal,
 * immutable state — no outgoing transition is legal. Throws
 * IllegalStagedIntentTransitionError on any other disallowed edge.
 */
export function transitionStagedIntent(
  id: string,
  toState: StagedIntentState,
  opts?: {
    annotation?: string | null;
    updatedAt?: number;
    /** Operator rationale for a reject disposition — set on the rejected transition, left untouched otherwise. */
    dispositionReason?: string | null;
    /** JSON-serialized StagedIntentAnswer — set on a decision.pickOne's answered (committed) transition, left untouched otherwise. */
    answer?: string | null;
  },
): StagedIntentRow {
  const current = getStagedIntent(id);
  if (!current) {
    throw new Error(`[staged_intent] "${id}" not found`);
  }
  const allowed = STAGED_INTENT_TRANSITIONS[current.state] ?? [];
  if (!allowed.includes(toState)) {
    throw new IllegalStagedIntentTransitionError(id, current.state, toState);
  }
  _stmtUpdateStagedIntentState ??= db.prepare<{
    id: string;
    state: StagedIntentState;
    annotation: string | null;
    disposition_reason: string | null;
    answer: string | null;
    updated_at: number;
  }>(
    `UPDATE staged_intent SET state = @state, annotation = @annotation, disposition_reason = @disposition_reason, answer = @answer, updated_at = @updated_at WHERE id = @id`,
  );
  const updatedAt = opts?.updatedAt ?? Date.now();
  const annotation =
    opts && 'annotation' in opts
      ? (opts.annotation ?? null)
      : current.annotation;
  const dispositionReason =
    opts && 'dispositionReason' in opts
      ? (opts.dispositionReason ?? null)
      : current.disposition_reason;
  const answer =
    opts && 'answer' in opts ? (opts.answer ?? null) : current.answer;
  _stmtUpdateStagedIntentState.run({
    id,
    state: toState,
    annotation,
    disposition_reason: dispositionReason,
    answer,
    updated_at: updatedAt,
  });
  return {
    ...current,
    state: toState,
    annotation,
    disposition_reason: dispositionReason,
    answer,
    updated_at: updatedAt,
  };
}

let _stmtExpireStagedIntentsForSession: Database.Statement | null = null;

/**
 * Reap a session's uncommitted staged intents when the session terminates
 * (see SessionManager's terminal-status hook): bulk-transitions its
 * `staged`/`approved` rows to `superseded` with a disposition reason,
 * preserving the audit trail. Committed, rejected, already-superseded, and
 * in-flight-verification (`pending_verification`/`needs_revision`) rows are
 * left untouched — the latter resolve through their own verify loop.
 * Returns the number of rows reaped.
 */
export function expireStagedIntentsForSession(
  sessionId: string,
  reason: string,
  now: number,
): number {
  _stmtExpireStagedIntentsForSession ??= db.prepare<{
    session_id: string;
    reason: string;
    now: number;
  }>(`
    UPDATE staged_intent
    SET state = 'superseded', disposition_reason = @reason, updated_at = @now
    WHERE session_id = @session_id AND state IN ('staged', 'approved')
  `);
  const result = _stmtExpireStagedIntentsForSession.run({
    session_id: sessionId,
    reason,
    now,
  });
  return result.changes;
}

let _stmtSweepStagedIntentsForTerminalSessions: Database.Statement | null =
  null;

/**
 * Backstop sweep for expireStagedIntentsForSession: reaps `staged`/`approved`
 * intents whose owning session already sits at a terminal DB status
 * (done/error/killed) but never went through the terminal-transition hook —
 * e.g. a process crash, or a write path that predates this reaper. Safe to
 * run repeatedly (idempotent: nothing left to reap after the first pass).
 * Returns the number of rows reaped.
 */
export function sweepStagedIntentsForTerminalSessions(
  reason: string,
  now: number,
): number {
  _stmtSweepStagedIntentsForTerminalSessions ??= db.prepare<{
    reason: string;
    now: number;
  }>(`
    UPDATE staged_intent
    SET state = 'superseded', disposition_reason = @reason, updated_at = @now
    WHERE state IN ('staged', 'approved')
      AND session_id IN (
        SELECT session_id FROM sessions WHERE status IN ('done', 'error', 'killed')
      )
  `);
  const result = _stmtSweepStagedIntentsForTerminalSessions.run({
    reason,
    now,
  });
  return result.changes;
}

/**
 * Supersedes `oldId` (tombstones it, retained for audit, hidden from the
 * active surface) and inserts `newRow` pointing back at it via `supersedes`.
 * Per-intent: only this one row transitions, a sibling's approval in the
 * same group is untouched.
 */
export function supersedeStagedIntent(
  oldId: string,
  newRow: StagedIntentRow,
): StagedIntentRow {
  const tx = db.transaction(() => {
    transitionStagedIntent(oldId, 'superseded');
    insertStagedIntent({ ...newRow, supersedes: oldId });
  });
  tx();
  return getStagedIntent(newRow.id) as StagedIntentRow;
}

let _stmtSetStagedIntentAnnotation: Database.Statement | null = null;

/** Sets the blocked-apply annotation without moving the intent off its current state. */
export function setStagedIntentAnnotation(
  id: string,
  annotation: string | null,
): void {
  _stmtSetStagedIntentAnnotation ??= db.prepare<{
    id: string;
    annotation: string | null;
    updated_at: number;
  }>(
    `UPDATE staged_intent SET annotation = @annotation, updated_at = @updated_at WHERE id = @id`,
  );
  _stmtSetStagedIntentAnnotation.run({
    id,
    annotation,
    updated_at: Date.now(),
  });
}

let _stmtSetStagedIntentGroup: Database.Statement | null = null;

/**
 * Sets group_id on a matched re-stage without moving the intent off its
 * current state or minting a new row — group_id is settable grouping
 * metadata, not part of the content-idempotent (task_id, payload_hash)
 * identity a re-stage dedups on. See stageIntent (routes/stagedIntents.ts).
 */
export function setStagedIntentGroup(
  id: string,
  groupId: string,
): StagedIntentRow {
  _stmtSetStagedIntentGroup ??= db.prepare<{
    id: string;
    group_id: string;
    updated_at: number;
  }>(
    `UPDATE staged_intent SET group_id = @group_id, updated_at = @updated_at WHERE id = @id`,
  );
  _stmtSetStagedIntentGroup.run({
    id,
    group_id: groupId,
    updated_at: Date.now(),
  });
  return getStagedIntent(id) as StagedIntentRow;
}

let _stmtClearStagedIntentGroup: Database.Statement | null = null;

/**
 * Strips group_id back to null — the wedged-group recovery counterpart to
 * setStagedIntentGroup. Used when recovering a needs_revision intent that
 * should never have carried a groupId (e.g. session.requestCapability),
 * so re-surfacing it to `staged` cannot route it back into the same
 * group-commit apply path that wedged it in the first place.
 */
export function clearStagedIntentGroup(id: string): StagedIntentRow {
  _stmtClearStagedIntentGroup ??= db.prepare<{
    id: string;
    updated_at: number;
  }>(
    `UPDATE staged_intent SET group_id = NULL, updated_at = @updated_at WHERE id = @id`,
  );
  _stmtClearStagedIntentGroup.run({
    id,
    updated_at: Date.now(),
  });
  return getStagedIntent(id) as StagedIntentRow;
}

let _stmtSetStagedIntentAdvisory: Database.Statement | null = null;

/**
 * Sets the Tier-3 semantic readiness advisory without moving the intent off
 * its current state or touching `annotation` — the two channels are
 * independent (advisory-only, never gates a transition).
 */
export function setStagedIntentAdvisory(
  id: string,
  advisory: string | null,
): void {
  _stmtSetStagedIntentAdvisory ??= db.prepare<{
    id: string;
    advisory: string | null;
    updated_at: number;
  }>(
    `UPDATE staged_intent SET advisory = @advisory, updated_at = @updated_at WHERE id = @id`,
  );
  _stmtSetStagedIntentAdvisory.run({
    id,
    advisory,
    updated_at: Date.now(),
  });
}

let _stmtGetStagedIntentGroup: Database.Statement | null = null;
let _stmtUpsertStagedIntentGroup: Database.Statement | null = null;

export function getStagedIntentGroup(
  groupId: string,
): StagedIntentGroupRow | undefined {
  _stmtGetStagedIntentGroup ??= db.prepare<{ group_id: string }>(
    `SELECT * FROM staged_intent_group WHERE group_id = @group_id`,
  );
  return _stmtGetStagedIntentGroup.get({
    group_id: groupId,
  }) as StagedIntentGroupRow | undefined;
}

const DEFAULT_ROUTE_BACK_CAP = 3;

/**
 * Increments a group's automatic Tier-3 route-back counter. Once the count
 * reaches `cap` (default 3, mirroring max_review_iterations), the group is
 * marked escalated and further automatic route-backs should stop — callers
 * check `.escalated` and surface the group to the operator instead.
 */
export function incrementRouteBackCount(
  groupId: string,
  cap = DEFAULT_ROUTE_BACK_CAP,
): StagedIntentGroupRow {
  const existing = getStagedIntentGroup(groupId);
  const nextCount = (existing?.route_back_count ?? 0) + 1;
  const escalated = nextCount >= cap ? 1 : (existing?.escalated ?? 0);
  const updatedAt = Date.now();
  _stmtUpsertStagedIntentGroup ??= db.prepare<{
    group_id: string;
    route_back_count: number;
    escalated: number;
    updated_at: number;
  }>(`
    INSERT INTO staged_intent_group (group_id, route_back_count, escalated, updated_at)
    VALUES (@group_id, @route_back_count, @escalated, @updated_at)
    ON CONFLICT(group_id) DO UPDATE SET
      route_back_count = excluded.route_back_count,
      escalated = excluded.escalated,
      updated_at = excluded.updated_at
  `);
  _stmtUpsertStagedIntentGroup.run({
    group_id: groupId,
    route_back_count: nextCount,
    escalated,
    updated_at: updatedAt,
  });
  return {
    group_id: groupId,
    route_back_count: nextCount,
    escalated,
    updated_at: updatedAt,
  };
}

// ─── trust-precision signals ───────────────────────────────────────────────

/** The auto-dispatch flows the trust-precision rejection/abstain-rate signal covers. */
export type TrustPrecisionFlow = 'groom' | 'design' | 'ops' | 'gate-verify';

const STAGED_INTENT_FLOWS: ReadonlySet<TrustPrecisionFlow> = new Set([
  'groom',
  'design',
  'ops',
]);

/** A staged intent an operator sent back for revision or outright declined, vs one they approved through. */
const STAGED_INTENT_REJECTED_STATES: StagedIntentState[] = [
  'needs_revision',
  'rejected',
];
/** Terminal-or-dispositioned states — the denominator for the staging-flow rejection rate; excludes still-pending states (staged, pending_verification, superseded, withdrawn). */
const STAGED_INTENT_DISPOSITIONED_STATES: StagedIntentState[] = [
  ...STAGED_INTENT_REJECTED_STATES,
  'approved',
  'committed',
];

export interface FlowRejectionRateResult {
  flow: TrustPrecisionFlow;
  project: string;
  milestone: string;
  /** Dispositioned items this rate was computed over (rejected + approved for staging flows; pass + fail + needs-setup for gate-verify). */
  total: number;
  /** Rejected/abstained items within `total`. */
  rejected: number;
  /** `rejected / total`, or null when there's no denominator yet. */
  rate: number | null;
}

/**
 * Per-flow rejection/abstain rate — the Milestone panel's trust-precision
 * read on auto-dispatch output (Technical Architecture § "Auto-dispatch
 * trust gates"). Flow-family-specific:
 *  - groom/design/ops: the rate at which a staged intent from that flow's
 *    sessions was rejected by the operator — pushback (-> needs_revision) or
 *    decline (-> rejected) — rather than approved (-> approved/committed).
 *    staged_intent carries no milestone column, so these three flows are
 *    scoped by project only; `milestone` is accepted for a uniform signature
 *    across all four flows but not filterable here.
 *  - gate-verify: auto-disposes on pass, so there is no operator
 *    "rejection" — the signal instead is the abstain rate, needs-setup
 *    dispositions read off gate_item_event, scoped to the given
 *    project+milestone via gate_item.
 * Informative only — no auto-disarm; the operator reads this and disarms
 * auto-dispatch manually via the arm toggle if it looks untrustworthy.
 */
export function getFlowRejectionRate(
  project: string,
  milestone: string,
  flow: TrustPrecisionFlow,
): FlowRejectionRateResult {
  if (!STAGED_INTENT_FLOWS.has(flow)) {
    const row = db
      .prepare(
        `
        SELECT
          SUM(CASE WHEN e.disposition = 'needs-setup' THEN 1 ELSE 0 END) AS rejected,
          COUNT(*) AS total
        FROM gate_item_event e
        JOIN gate_item i ON i.id = e.gate_item_id
        WHERE i.project = ? AND i.milestone = ?
          AND e.disposition IN ('pass', 'fail', 'needs-setup')
      `,
      )
      .get(project, milestone) as {
      rejected: number | null;
      total: number | null;
    };
    const total = row.total ?? 0;
    const rejected = row.rejected ?? 0;
    return {
      flow,
      project,
      milestone,
      total,
      rejected,
      rate: total > 0 ? rejected / total : null,
    };
  }

  const rejectedPlaceholders = STAGED_INTENT_REJECTED_STATES.map(
    () => '?',
  ).join(', ');
  const dispositionedPlaceholders = STAGED_INTENT_DISPOSITIONED_STATES.map(
    () => '?',
  ).join(', ');
  const row = db
    .prepare(
      `
      SELECT
        SUM(CASE WHEN si.state IN (${rejectedPlaceholders}) THEN 1 ELSE 0 END) AS rejected,
        COUNT(*) AS total
      FROM staged_intent si
      JOIN sessions s ON s.session_id = si.session_id
      WHERE s.project_id = ? AND s.session_type = ?
        AND si.state IN (${dispositionedPlaceholders})
    `,
    )
    .get(
      ...STAGED_INTENT_REJECTED_STATES,
      project,
      flow,
      ...STAGED_INTENT_DISPOSITIONED_STATES,
    ) as { rejected: number | null; total: number | null };
  const total = row.total ?? 0;
  const rejected = row.rejected ?? 0;
  return {
    flow,
    project,
    milestone,
    total,
    rejected,
    rate: total > 0 ? rejected / total : null,
  };
}

// ─── arch_unit ────────────────────────────────────────────────────────────
// Statements are cached lazily (prepared on first use, not at module load) so
// importing this module doesn't fail on a not-yet-migrated db handle.

let _stmtGetArchUnit: Database.Statement | null = null;
let _stmtInsertArchUnit: Database.Statement | null = null;
let _stmtUpdateArchUnit: Database.Statement | null = null;
let _stmtListArchUnitEvents: Database.Statement | null = null;
let _stmtInsertArchUnitEvent: Database.Statement | null = null;

export function getArchUnit(id: string): ArchUnitRow | undefined {
  _stmtGetArchUnit ??= db.prepare<{ id: string }>(
    `SELECT * FROM arch_unit WHERE id = @id`,
  );
  return _stmtGetArchUnit.get({ id }) as ArchUnitRow | undefined;
}

export function insertArchUnit(row: NewArchUnitRow): void {
  _stmtInsertArchUnit ??= db.prepare<ArchUnitRow>(`
    INSERT INTO arch_unit
      (id, title, kind, topic, regions, status, body, supersedes, superseded_by, version, created_at, updated_at)
    VALUES
      (@id, @title, @kind, @topic, @regions, @status, @body, @supersedes, @superseded_by, @version, @created_at, @updated_at)
  `);
  _stmtInsertArchUnit.run({
    ...row,
    superseded_by: row.superseded_by ?? null,
  });
}

export function updateArchUnit(row: ArchUnitRow): void {
  _stmtUpdateArchUnit ??= db.prepare<ArchUnitRow>(`
    UPDATE arch_unit SET
      title = @title,
      kind = @kind,
      topic = @topic,
      regions = @regions,
      status = @status,
      body = @body,
      supersedes = @supersedes,
      superseded_by = @superseded_by,
      version = @version,
      updated_at = @updated_at
    WHERE id = @id
  `);
  _stmtUpdateArchUnit.run(row);
}

export function listArchUnitEvents(archUnitId: string): ArchUnitEventRow[] {
  _stmtListArchUnitEvents ??= db.prepare<{ arch_unit_id: string }>(
    `SELECT * FROM arch_unit_event WHERE arch_unit_id = @arch_unit_id ORDER BY id ASC`,
  );
  return _stmtListArchUnitEvents.all({
    arch_unit_id: archUnitId,
  }) as ArchUnitEventRow[];
}

export function insertArchUnitEvent(row: NewArchUnitEventRow): void {
  _stmtInsertArchUnitEvent ??= db.prepare<NewArchUnitEventRow>(`
    INSERT INTO arch_unit_event
      (arch_unit_id, event_type, payload, at)
    VALUES
      (@arch_unit_id, @event_type, @payload, @at)
  `);
  _stmtInsertArchUnitEvent.run(row);
}

/**
 * Query the arch_unit table by topic/kind/region/status. Active-set by
 * default (superseded excluded) unless includeSuperseded is set or status
 * explicitly requests 'superseded'.
 */
export function queryArchUnits(query: ArchUnitQuery = {}): ArchUnitRow[] {
  const clauses: string[] = [];
  const params: Record<string, string> = {};

  if (query.topic) {
    clauses.push('topic = @topic');
    params.topic = query.topic;
  }
  if (query.kind) {
    clauses.push('kind = @kind');
    params.kind = query.kind;
  }
  if (query.region) {
    clauses.push('regions LIKE @region');
    params.region = `%${query.region}%`;
  }
  if (query.status) {
    clauses.push('status = @status');
    params.status = query.status;
  } else if (!query.includeSuperseded) {
    clauses.push(`status != 'superseded'`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM arch_unit ${where} ORDER BY updated_at DESC`)
    .all(params) as ArchUnitRow[];
}

// ─── flow_arm ──────────────────────────────────────────────────────────────

let _stmtGetFlowArm: Database.Statement | undefined;
let _stmtUpsertFlowArm: Database.Statement | undefined;

/** flow_arm row for (milestoneId, flow), or null if absent (caller applies DEFAULT_ARM). */
function getFlowArmRow(milestoneId: string, flow: FlowId): FlowArmRow | null {
  _stmtGetFlowArm ??= db.prepare<{ milestone_id: string; flow: string }>(
    `SELECT * FROM flow_arm WHERE milestone_id = @milestone_id AND flow = @flow`,
  );
  return (
    (_stmtGetFlowArm.get({
      milestone_id: milestoneId,
      flow,
    }) as FlowArmRow | undefined) ?? null
  );
}

/** Effective arm state: the flow_arm row's value if present, else DEFAULT_ARM[flow]. */
export function getArm(milestoneId: string, flow: FlowId): boolean {
  const row = getFlowArmRow(milestoneId, flow);
  return row ? row.armed === 1 : DEFAULT_ARM[flow];
}

/** Effective per-flow arm state for a milestone, with the source of each value. */
export function listArm(
  milestoneId: string,
): Record<FlowId, { armed: boolean; source: 'row' | 'default' }> {
  const result = {} as Record<
    FlowId,
    { armed: boolean; source: 'row' | 'default' }
  >;
  for (const flow of FLOW_IDS) {
    const row = getFlowArmRow(milestoneId, flow);
    result[flow] = row
      ? { armed: row.armed === 1, source: 'row' }
      : { armed: DEFAULT_ARM[flow], source: 'default' };
  }
  return result;
}

/**
 * Upsert the arm state for (milestoneId, flow). Returns the previous
 * effective value (row value if present, else DEFAULT_ARM[flow]) so the
 * caller can audit the transition.
 */
export function upsertArm(
  milestoneId: string,
  flow: FlowId,
  armed: boolean,
  updatedAt: number,
): { previous: boolean } {
  const previous = getArm(milestoneId, flow);
  _stmtUpsertFlowArm ??= db.prepare<{
    milestone_id: string;
    flow: string;
    armed: number;
    updated_at: number;
  }>(`
    INSERT INTO flow_arm (milestone_id, flow, armed, updated_at)
    VALUES (@milestone_id, @flow, @armed, @updated_at)
    ON CONFLICT (milestone_id, flow) DO UPDATE SET
      armed = excluded.armed,
      updated_at = excluded.updated_at
  `);
  _stmtUpsertFlowArm.run({
    milestone_id: milestoneId,
    flow,
    armed: armed ? 1 : 0,
    updated_at: updatedAt,
  });
  return { previous };
}

// ─── usage_deferral ─────────────────────────────────────────────────────────
// Global (account-wide) admission-gate state for the plan-usage five_hour /
// seven_day windows. A row's presence with deferred_until in the future means
// "do not launch/resume/dispatch a session until then" — persisted so the
// gate survives a backend restart.

export type UsageDeferralWindow = 'five_hour' | 'seven_day';

let _stmtGetUsageDeferral: Database.Statement | null = null;
let _stmtUpsertUsageDeferral: Database.Statement | null = null;
let _stmtDeleteUsageDeferral: Database.Statement | null = null;

/**
 * Returns the recorded deferred-until timestamp (ms) for `window`, or null
 * if no deferral is recorded or the recorded instant has already passed —
 * in the latter case the stale row is deleted so it doesn't linger.
 */
export function getUsageDeferral(window: UsageDeferralWindow): number | null {
  _stmtGetUsageDeferral ??= db.prepare(
    `SELECT deferred_until FROM usage_deferral WHERE window = ?`,
  );
  const row = _stmtGetUsageDeferral.get(window) as
    | { deferred_until: number }
    | undefined;
  if (!row) return null;
  if (row.deferred_until <= Date.now()) {
    clearUsageDeferral(window);
    return null;
  }
  return row.deferred_until;
}

export function setUsageDeferral(
  window: UsageDeferralWindow,
  deferredUntil: number,
): void {
  _stmtUpsertUsageDeferral ??= db.prepare<{
    window: string;
    deferred_until: number;
    recorded_at: number;
  }>(`
    INSERT INTO usage_deferral (window, deferred_until, recorded_at)
    VALUES (@window, @deferred_until, @recorded_at)
    ON CONFLICT (window) DO UPDATE SET
      deferred_until = excluded.deferred_until,
      recorded_at = excluded.recorded_at
  `);
  _stmtUpsertUsageDeferral.run({
    window,
    deferred_until: deferredUntil,
    recorded_at: Date.now(),
  });
}

export function clearUsageDeferral(window: UsageDeferralWindow): void {
  _stmtDeleteUsageDeferral ??= db.prepare(
    `DELETE FROM usage_deferral WHERE window = ?`,
  );
  _stmtDeleteUsageDeferral.run(window);
}
