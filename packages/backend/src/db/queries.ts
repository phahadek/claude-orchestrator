import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { db } from './db';
import { logger } from '../logger';
import { recordEvent, hasTaskEditSinceTimestamp } from '../audit/AuditLog';
import {
  normalizeTaskId,
  normalizeBoardId,
  toExternalId,
} from '../tasks/taskId';
import {
  isCodeSession,
  isPlanningSession,
  PLANNING_SESSION_TYPES,
  type SessionType,
} from '../session/sessionPredicates';
import {
  pauseReasonFromCanonical,
  serializePauseReason,
  parsePauseReason,
} from './pauseReason';
import type {
  Session,
  SessionStatus,
  NewSession,
  SessionEvent,
  NewSessionEvent,
  PermissionDenialRow,
  NewPermissionDenialRow,
  TaskCache,
  PullRequestRow,
  DepthReviewVerdictRow,
  NewDepthReviewVerdictRow,
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
  TestRequestRunRow,
  TestRequestRunState,
  TestRequestFailureReason,
  DependencyCacheEntryRow,
  DependencyCacheEntryStatus,
  TestRunResultRow,
  NewTestRunResultRow,
  TestPerfBaselineRow,
  NewTestPerfBaselineRow,
  OpsJournalRow,
  CapabilityDisqualificationRow,
  NewCapabilityDisqualificationRow,
  FlakyRemediationTrackingRow,
  BaseHealthRemediationTrackingRow,
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
  CompletingSignalLedgerRow,
  NewCompletingSignalLedgerRow,
  FlowArmRow,
  ConvergenceSnapshotRow,
  NewConvergenceSnapshotRow,
  OpsJournalState,
} from './types';
import { FLOW_IDS, DEFAULT_ARM, type FlowId } from '../orchestration/flowArm';

// ─── asOf reconstruction ────────────────────────────────────────────────────
// Point-in-time reads for the gate-verify read path (see gate/gateItemVerifier.ts
// and the mcp/tools/*ReadTools.ts it drives): "was X true at T" must never
// silently fall back to whatever the row says right now. A field with no
// historical record yet (sessions.status, pull_requests.*, deploy_run.status,
// gate_item.min_deployed_commit/next_attempt_at/pending_attempt_count — all
// pending the sibling point-in-time instrumentation task) is replaced with an
// explicit Unreconstructable marker rather than the live value.

/** Explicit "we don't know" marker for an asOf field with no history yet. */
export interface Unreconstructable {
  readonly __unreconstructable: true;
  readonly reason: string;
}

function unreconstructable(reason: string): Unreconstructable {
  return { __unreconstructable: true, reason };
}

export function isUnreconstructable(
  value: unknown,
): value is Unreconstructable {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<Unreconstructable>).__unreconstructable === true
  );
}

// ─── sessions ──────────────────────────────────────────────────────────────

let _stmtInsertSession: Database.Statement | null = null;
let _stmtUpdateSessionStatus: Database.Statement | null = null;
let _stmtUpdateSessionWorktreePath: Database.Statement | null = null;
let _stmtGetSession: Database.Statement | null = null;
let _stmtGetAllSessionIds: Database.Statement | null = null;
let _stmtDeleteSession: Database.Statement | null = null;
let _stmtInsertSessionOrIgnore: Database.Statement | null = null;

/** Lazily-prepared `sessions` row lookup by id — shared across many functions below. */
function getStmtGetSession(): Database.Statement {
  _stmtGetSession ??= db.prepare<{ session_id: string }>(`
    SELECT * FROM sessions WHERE session_id = @session_id
  `);
  return _stmtGetSession;
}

export function insertSession(s: NewSession): void {
  _stmtInsertSession ??= db.prepare<NewSession>(`
    INSERT INTO sessions
      (session_id, task_id, task_url, project_context_url,
       project_id, status, started_at, ended_at, pr_url, worktree_path, session_type, task_name)
    VALUES
      (@session_id, @task_id, @task_url, @project_context_url,
       @project_id, @status, @started_at, @ended_at, @pr_url, @worktree_path, @session_type, @task_name)
  `);
  _stmtInsertSession.run({
    ended_at: null,
    pr_url: null,
    worktree_path: null,
    project_id: null,
    session_type: 'standard',
    ...s,
    task_name: s.task_name ?? null,
  });
}

/**
 * Mirrors a legacy sessions.status/archived write into completing_signal_ledger
 * as a 'legacy_status_write' signal — the dual-write bridge landed by the
 * shared-primitives migration task, ahead of any read-side cutover onto
 * session/sessionStatusDeriver.ts. Purely additive: never gates, alters, or
 * is awaited by the legacy write it mirrors, so it can never change that
 * write's observable behavior.
 */
function recordLegacyStatusSignal(
  sessionId: string,
  taskId: string | null,
  sessionType: SessionType,
  signalValue: string,
  recordedAt: number,
): void {
  insertCompletingSignal({
    session_id: sessionId,
    task_id: taskId,
    session_type: sessionType,
    signal_class: 'legacy_status_write',
    signal_value: signalValue,
    recorded_at: recordedAt,
  });
}

/** Session types whose terminal status is decided by a PR merge/close outcome — see completingSignalRegistry.ts. */
const PR_ANCHORED_SESSION_TYPES: ReadonlySet<SessionType> = new Set([
  'standard',
  'review',
]);

/**
 * Dual-write bridge for the PR-anchored session types (standard/code and
 * review — see completingSignalRegistry.ts's registry comment; depth_review
 * has no PR of its own to anchor to and is excluded here). Mirrors a PR
 * merge/close outcome into completing_signal_ledger as an 'external_pr_event'
 * signal, alongside the legacy markSessionDone/updateSessionStatus write it
 * accompanies at the call site (PRMergeWatcher/AutoMerger/
 * bootIdleReconciliation). Purely additive — never gates, alters, or is
 * awaited by the legacy write it accompanies, so it can never change that
 * write's observable behavior. No-ops for any other session type (docs/ops
 * PR outcomes are the planning-family sibling migration task's scope).
 */
export function recordPrAnchoredCompletingSignal(
  sessionId: string,
  reason: 'pr_merged' | 'pr_closed_without_merge',
  recordedAt: number,
): void {
  const current = getStmtGetSession().get({ session_id: sessionId }) as
    | { task_id: string | null; session_type: SessionType }
    | undefined;
  if (!current || !PR_ANCHORED_SESSION_TYPES.has(current.session_type)) {
    return;
  }
  insertCompletingSignal({
    session_id: sessionId,
    task_id: current.task_id ?? null,
    session_type: current.session_type,
    signal_class: 'external_pr_event',
    signal_value: reason,
    recorded_at: recordedAt,
  });
}

export function updateSessionStatus(
  sessionId: string,
  status: string,
  endedAt?: number,
): void {
  const current = getStmtGetSession().get({ session_id: sessionId }) as
    | { status: string; task_id: string | null; session_type: SessionType }
    | undefined;
  _stmtUpdateSessionStatus ??= db.prepare<{
    session_id: string;
    status: string;
    ended_at: number | null;
    terminalized_at: number | null;
  }>(`
    UPDATE sessions
    SET status = @status, ended_at = @ended_at,
        terminalized_at = COALESCE(terminalized_at, @terminalized_at)
    WHERE session_id = @session_id
  `);
  _stmtUpdateSessionStatus.run({
    session_id: sessionId,
    status,
    ended_at: endedAt ?? null,
    terminalized_at: TERMINAL_SESSION_STATUSES.has(status)
      ? (endedAt ?? Date.now())
      : null,
  });
  if (current && current.status !== status) {
    recordEvent({
      event_type: 'session_status_changed',
      actor_type: 'system',
      actor_id: sessionId,
      task_id: current.task_id ?? null,
      payload: { from: current.status, to: status },
    });
    recordLegacyStatusSignal(
      sessionId,
      current.task_id ?? null,
      current.session_type,
      status,
      endedAt ?? Date.now(),
    );
  }
}

export function updateSessionWorktreePath(
  sessionId: string,
  worktreePath: string,
): void {
  _stmtUpdateSessionWorktreePath ??= db.prepare<{
    session_id: string;
    worktree_path: string;
  }>(`
    UPDATE sessions
    SET worktree_path = @worktree_path
    WHERE session_id = @session_id
  `);
  _stmtUpdateSessionWorktreePath.run({
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

let _stmtMarkSessionDone: Database.Statement | null = null;

/** Lazily-prepared done-transition write — shared by markSessionDone and applyPendingDone. */
function getStmtMarkSessionDone(): Database.Statement {
  _stmtMarkSessionDone ??= db.prepare<{
    session_id: string;
    ended_at: number;
    pr_url: string | null;
    terminalized_at: number;
  }>(`
    UPDATE sessions
    SET status = 'done', ended_at = @ended_at, pr_url = COALESCE(@pr_url, pr_url),
        terminalized_at = COALESCE(terminalized_at, @terminalized_at)
    WHERE session_id = @session_id
  `);
  return _stmtMarkSessionDone;
}

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
 * Durable record of *why* a session went terminal — written by
 * PlanningOrchestrator.markTerminal alongside its markSessionDone call, so
 * the reason survives past the session's own lifetime. Read by the
 * ops-journal route's deferred close: the operator-confirmed
 * applied-pending-confirm -> resolved journal transition typically settles
 * well after the session has gone terminal, so it needs a durable place to
 * ask "did this session's terminal reason justify closing the task?"
 * instead of relying on a log line or an in-memory value.
 */
export function setSessionTerminalCompletionReason(
  sessionId: string,
  reason: string,
): void {
  db.prepare<{ session_id: string; terminal_completion_reason: string }>(
    `UPDATE sessions
     SET terminal_completion_reason = @terminal_completion_reason
     WHERE session_id = @session_id`,
  ).run({ session_id: sessionId, terminal_completion_reason: reason });
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

let _stmtMarkSessionIdle: Database.Statement | null = null;
let _stmtMarkSessionSuperseded: Database.Statement | null = null;

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
  const current = getStmtGetSession().get({ session_id: sessionId }) as
    | { status: string; task_id: string | null; session_type: SessionType }
    | undefined;
  _stmtMarkSessionSuperseded ??= db.prepare<{
    session_id: string;
    ended_at: number;
  }>(`
    UPDATE sessions
    SET status = 'superseded', ended_at = @ended_at
    WHERE session_id = @session_id
  `);
  _stmtMarkSessionSuperseded.run({ session_id: sessionId, ended_at: endedAt });
  if (current && current.status !== 'superseded') {
    recordEvent({
      event_type: 'session_status_changed',
      actor_type: 'system',
      actor_id: sessionId,
      task_id: current.task_id ?? null,
      payload: { from: current.status, to: 'superseded' },
    });
    recordLegacyStatusSignal(
      sessionId,
      current.task_id ?? null,
      current.session_type,
      'superseded',
      endedAt,
    );
  }
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
 * audit event is recorded. The deferred transition is applied once the
 * turn's boundary is reached — see applyPendingDone, primarily drained on
 * the turn-boundary result event (fires whether the session then parks
 * alive, the normal resting state, or exits), with SessionManager's
 * run()-settle handler and its boot-time sweep as backstops — so it is
 * never silently lost.
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
  const current = getStmtGetSession().get({ session_id: sessionId }) as
    | { status: string; task_id: string | null; session_type: SessionType }
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
  getStmtMarkSessionDone().run({
    session_id: sessionId,
    ended_at: endedAt,
    pr_url: prUrl ?? null,
    terminalized_at: endedAt,
  });
  if (current && current.status !== 'done') {
    recordEvent({
      event_type: 'session_status_changed',
      actor_type: 'system',
      actor_id: sessionId,
      task_id: current.task_id ?? null,
      payload: {
        from: current.status,
        to: 'done',
        call_site: callSite ?? 'unknown',
      },
    });
    recordLegacyStatusSignal(
      sessionId,
      current.task_id ?? null,
      current.session_type,
      'done',
      endedAt,
    );
  }
}

/**
 * Applies a done-transition previously deferred by markSessionDone, once the
 * session's turn has reached its boundary — the turn-boundary result event
 * fires the instant a turn's result is processed, whether the session then
 * parks alive (the normal resting state — status stays 'running' with no
 * process exit) or exits. Process exit is NOT a precondition: a parked
 * session may never exit on its own, so waiting for exit would strand the
 * deferred transition forever. The caller is only responsible for invoking
 * this once the in-flight turn that justified the deferral has ended (the
 * result event, or an actual process exit as a backstop), never while that
 * turn might still be in flight. No-op if nothing is pending. If the session
 * already reached a terminal status via another path in the meantime, the
 * stale pending mark is dropped rather than applied (that other terminal
 * status wins — it reflects something more recent).
 * Returns true if a deferred done-transition was applied.
 */
export function applyPendingDone(sessionId: string): boolean {
  const current = getStmtGetSession().get({ session_id: sessionId }) as
    | {
        status: string;
        task_id: string | null;
        session_type: SessionType;
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
  const terminalizedAt = Date.now();
  getStmtMarkSessionDone().run({
    session_id: sessionId,
    ended_at: current.pending_done_ended_at,
    pr_url: current.pending_done_pr_url,
    // The genuine terminal instant is now (the drain), not the original
    // deferral time preserved in ended_at for backwards compatibility.
    terminalized_at: terminalizedAt,
  });
  clearPendingDone(sessionId);
  recordEvent({
    event_type: 'session_done_deferred_applied',
    actor_type: 'system',
    actor_id: sessionId,
    task_id: current.task_id ?? null,
    payload: { call_site: current.pending_done_call_site ?? 'unknown' },
  });
  recordEvent({
    event_type: 'session_status_changed',
    actor_type: 'system',
    actor_id: sessionId,
    task_id: current.task_id ?? null,
    payload: {
      from: current.status,
      to: 'done',
      call_site: current.pending_done_call_site ?? 'unknown',
    },
  });
  recordLegacyStatusSignal(
    sessionId,
    current.task_id ?? null,
    current.session_type,
    'done',
    terminalizedAt,
  );
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
export const TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED = new Set([
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

/**
 * SQL `IN (...)`-ready literal list derived from PLANNING_SESSION_TYPES —
 * the single source of truth for which session_type values count as
 * "planning" (see session/sessionPredicates.ts's isPlanningSession).
 * Interpolated rather than parameterized so query plans still use
 * idx_sessions_notion_task_id_session_type.
 */
const PLANNING_SESSION_TYPE_SQL_LIST = PLANNING_SESSION_TYPES.map(
  (t) => `'${t}'`,
).join(', ');

let _stmtBackfillPrUrlIfNull: Database.Statement | null = null;

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
 *
 * Returns the row's effective status after the call — 'idle' when the write
 * landed, 'done' when a deferred pending_done was drained instead (see
 * below), or the pre-existing terminal status when the terminal guard fired
 * — so callers can broadcast what's actually in the database instead of
 * assuming the write always lands.
 *
 * Pending-done drain: reaching a non-running status is exactly the boundary
 * markSessionDone's docstring promises the deferred transition drains on
 * (see applyPendingDone) — a session that parks alive between turns never
 * exits and never settles a run() promise again, so without this drain
 * point a pending_done written after a session's last turn boundary is
 * never applied. Skipped when the session holds an undispositioned staged
 * intent (staged/approved) — see hasUndispositionedStagedIntentsForSession
 * — so a planning session parked awaiting operator disposition stays idle,
 * not done, per boot orphan recovery's same invariant.
 */
export function markSessionIdle(
  sessionId: string,
  endedAt: number,
  prUrl?: string | null,
  callSite?: string,
): SessionStatus {
  const current = getStmtGetSession().get({ session_id: sessionId }) as
    | {
        status: SessionStatus;
        task_id: string | null;
        session_type: SessionType;
        pending_done_ended_at: number | null;
      }
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
      _stmtBackfillPrUrlIfNull ??= db.prepare<{
        session_id: string;
        pr_url: string | null;
      }>(`
        UPDATE sessions
        SET pr_url = COALESCE(pr_url, @pr_url)
        WHERE session_id = @session_id
      `);
      _stmtBackfillPrUrlIfNull.run({ session_id: sessionId, pr_url: prUrl });
    }
    return current.status;
  }
  if (
    current?.pending_done_ended_at != null &&
    !hasUndispositionedStagedIntentsForSession(sessionId)
  ) {
    applyPendingDone(sessionId);
    return 'done';
  }
  _stmtMarkSessionIdle ??= db.prepare<{
    session_id: string;
    ended_at: number;
    pr_url: string | null;
  }>(`
    UPDATE sessions
    SET status = 'idle', ended_at = @ended_at, pr_url = COALESCE(@pr_url, pr_url)
    WHERE session_id = @session_id
  `);
  _stmtMarkSessionIdle.run({
    session_id: sessionId,
    ended_at: endedAt,
    pr_url: prUrl ?? null,
  });
  if (current && current.status !== 'idle') {
    recordEvent({
      event_type: 'session_status_changed',
      actor_type: 'system',
      actor_id: sessionId,
      task_id: current.task_id ?? null,
      payload: {
        from: current.status,
        to: 'idle',
        call_site: callSite ?? 'unknown',
      },
    });
    recordLegacyStatusSignal(
      sessionId,
      current.task_id ?? null,
      current.session_type,
      'idle',
      endedAt,
    );
  }
  return 'idle';
}

/**
 * Records the skip audit event for a would-be error/killed write onto an
 * already-terminal session row — the markSessionErrored counterpart to
 * markSessionIdle's session_idle_write_skipped_terminal event above.
 * SessionManager.markSessionErrored is the one deciding to skip (it reads
 * the persisted status via getSession, never the in-memory hasEnded flag —
 * that flag is exactly what's stale when sessionLivenessReconciler reaps an
 * orphaned process's OS-level SIGTERM outside the AgentSession object); this
 * only emits the audit trail for that decision.
 */
export function recordSessionErroredWriteSkipped(
  sessionId: string,
  taskId: string | null,
  statusBefore: string,
  attemptedStatus: string,
): void {
  recordEvent({
    event_type: 'session_errored_write_skipped_terminal',
    actor_type: 'system',
    actor_id: sessionId,
    task_id: taskId,
    payload: { status_before: statusBefore, attempted_status: attemptedStatus },
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
  return getStmtGetSession().get({ session_id: sessionId }) as
    | Session
    | undefined;
}

const SESSION_STATUS_UNRECONSTRUCTABLE_REASON =
  'sessions.status has no historical record until the point-in-time instrumentation task lands — cannot answer "what was this session\'s status at T", only "what is it now"';

export type SessionAsOf = Omit<Session, 'status'> & {
  status: Unreconstructable;
};

/**
 * Point-in-time read of a session row for the given `asOf` cutoff. `status`
 * is not reconstructable yet (see module header) and always comes back as an
 * Unreconstructable marker rather than the live value. Returns undefined both
 * when the session doesn't exist and when it wasn't started yet as of `asOf`.
 */
export function getSessionAsOf(
  sessionId: string,
  asOf: string,
): SessionAsOf | undefined {
  const current = getSession(sessionId);
  if (!current) return undefined;
  const asOfMs = Date.parse(asOf);
  if (current.started_at > asOfMs) return undefined;
  return {
    ...current,
    status: unreconstructable(SESSION_STATUS_UNRECONSTRUCTABLE_REASON),
  };
}

export function getAllSessionIds(): string[] {
  _stmtGetAllSessionIds ??= db.prepare(`
    SELECT session_id FROM sessions
  `);
  return (_stmtGetAllSessionIds.all() as { session_id: string }[]).map(
    (r) => r.session_id,
  );
}

/**
 * Session ids whose raw session_events have NOT been pruned — i.e. still
 * backfillable from their stored event payloads. Used by the one-off
 * cache-token backfill (scripts/backfill-cache-tokens.ts) to skip the
 * sessions it can no longer reconstruct.
 */
export function getUnprunedSessionIds(): string[] {
  return (
    db
      .prepare(`SELECT session_id FROM sessions WHERE events_pruned_at IS NULL`)
      .all() as { session_id: string }[]
  ).map((r) => r.session_id);
}

/**
 * Absolute (non-additive) overwrite of the session's cache-token totals.
 * Used only by the one-off cache-token backfill, which reconstructs the
 * full cumulative total from history in one pass — unlike incrementCacheTokens,
 * which is for the live per-turn accumulation path and must never be reused
 * here (re-running the backfill would double-count).
 */
export function setCacheTokensAbsolute(
  sessionId: string,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): void {
  db.prepare(
    `UPDATE sessions SET cache_read_tokens = ?, cache_creation_tokens = ? WHERE session_id = ?`,
  ).run(cacheReadTokens, cacheCreationTokens, sessionId);
}

export function insertSessionOrIgnore(s: NewSession): void {
  _stmtInsertSessionOrIgnore ??= db.prepare<NewSession>(`
    INSERT OR IGNORE INTO sessions
      (session_id, task_id, task_url, project_context_url,
       project_id, status, started_at, ended_at, pr_url, worktree_path, session_type, task_name)
    VALUES
      (@session_id, @task_id, @task_url, @project_context_url,
       @project_id, @status, @started_at, @ended_at, @pr_url, @worktree_path, @session_type, @task_name)
  `);
  _stmtInsertSessionOrIgnore.run({
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
  _stmtDeleteSession ??= db.prepare<{ session_id: string }>(`
    DELETE FROM sessions WHERE session_id = @session_id
  `);
  const result = _stmtDeleteSession.run({ session_id: sessionId });
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
         AND status NOT IN (${TERMINAL_STATUS_SQL_LIST})`,
    )
    .get({ taskId });
  return (row?.c ?? 0) > 0;
}

/**
 * Batched liveness over getVerifySessionsForGateItems: for each gate item,
 * whether its most recent verify session is still in flight. Reuses the
 * same terminal-status set as hasLiveVerifySessionForGateItem instead of
 * re-inlining it, and additionally honours endedAt so a session whose
 * status hasn't yet caught up to its end doesn't read as live. One query
 * for the whole id list — no per-item round trip.
 */
export function getLiveVerifySessionItemIds(itemIds: string[]): Set<string> {
  const live = new Set<string>();
  const seen = new Set<string>();
  for (const session of getVerifySessionsForGateItems(itemIds)) {
    if (seen.has(session.itemId)) continue;
    seen.add(session.itemId);
    if (
      session.endedAt === null &&
      !TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED.has(session.sessionStatus)
    ) {
      live.add(session.itemId);
    }
  }
  return live;
}

/**
 * Count of live (non-terminal) gate-verify sessions — task_id
 * `gate-item:<id>`, the same convention hasLiveVerifySessionForGateItem
 * keys on. Discriminates on task_id rather than session_type='ops' so an
 * ordinary ops session (also session_type='ops') is never counted against
 * the verify-specific cap (see isGateVerifySession).
 */
export function countLiveVerifySessions(): number {
  const row = db
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) as c FROM sessions
       WHERE task_id LIKE '${GATE_ITEM_TASK_PREFIX}%'
         AND status NOT IN ('done', 'error', 'killed', 'superseded')`,
    )
    .get();
  return row?.c ?? 0;
}

/**
 * Count of live (non-terminal, unarchived) sessions in the shared planning
 * pool (groom/design/ops/split/docs — see isPlanningSession), DB-backed so
 * the gate reconciler can budget against it without a SessionManager
 * instance.
 *
 * Rule: an unarchived `idle` session still counts. idle is deliberately not
 * a terminal status — a planning session parks idle between turns and is
 * routinely resumed from it, so it is holding a slot the same as a running
 * one. `archived` is the actual discriminator for "no longer live": it is
 * the operator's explicit signal that a session will never be resumed, and
 * archiving always accompanies ending the session's process (see
 * SessionManager.archiveAndEndSession) — so it is excluded here too. Without
 * this filter, a session archived days ago (and thus no longer holding any
 * real capacity) still counted, which pinned this budget at zero once
 * enough archived rows accumulated.
 *
 * This intentionally does not count the same population as
 * SessionManager.getLivePlanningSessionCount(), which tracks only sessions
 * with a live in-memory process (that map entry is removed the moment a
 * session goes idle, see cleanupWorktree) — a narrower, in-process
 * concurrency guard used by DispatchTriggerEvaluator to decide whether to
 * spawn another session right now. This DB-backed count instead answers
 * "how much of the planning pool's capacity is currently spoken for",
 * including sessions parked idle and awaiting resume, which is what the
 * gate reconciler needs to budget its own dispatches against.
 */
export function countLivePlanningSessions(): number {
  const rows = db
    .prepare(
      `SELECT session_type FROM sessions
       WHERE status NOT IN ('done', 'error', 'killed', 'superseded')
         AND archived = 0`,
    )
    .all() as { session_type: string | null }[];
  return rows.filter((r) => isPlanningSession(r.session_type ?? '')).length;
}

/**
 * Full rows behind countLivePlanningSessions' count — the candidate
 * population for the OS-process liveness reconciler
 * (session/sessionLivenessReconciler.ts), which cross-references each row
 * against real process liveness rather than the in-memory session map or
 * status/elapsed-time alone.
 */
export function listLivePlanningSessionRows(): Session[] {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE status NOT IN ('done', 'error', 'killed', 'superseded')
         AND archived = 0`,
    )
    .all() as Session[];
  return rows.filter((r) => isPlanningSession(r.session_type ?? ''));
}

/**
 * All non-terminal session rows regardless of session_type — the candidate
 * population for the non-planning half of the OS-process liveness
 * reconciler (session/sessionLivenessReconciler.ts). Unlike
 * listLivePlanningSessionRows above, this is not filtered to
 * isPlanningSession: it exists to catch standard/review/depth_review
 * sessions (code sessions and PR-review sessions), which have no other
 * periodic OS-process-liveness sweep — StuckSessionMonitor only matches
 * rows whose last event is 'result', so a session killed before it ever
 * emits a session_events row is invisible to it, and resumeOrphanSessions
 * only runs on backend boot.
 */
export function listLiveSessionRows(): Session[] {
  return db
    .prepare(
      `SELECT * FROM sessions
       WHERE status NOT IN ('done', 'error', 'killed', 'superseded')
         AND archived = 0`,
    )
    .all() as Session[];
}

/**
 * Idle planning-type sessions (groom/design/ops/split/docs — see
 * isPlanningSession) with ended_at set, unarchived, and older than the
 * given cutoff — the candidate population for
 * PlanningOrchestrator.sweepIdleTerminalSessions. Deliberately a separate
 * query from archiveConcludedSessionsOlderThan, which excludes idle on
 * purpose (its docstring: "the CLI subprocess is still alive and
 * resumable") — that guard stays correct and untouched. This query exists
 * because an idle session's subprocess has, in fact, already exited
 * (status='idle' with ended_at set is a parked-but-exited session — see
 * countLivePlanningSessions' docstring for why idle still holds a slot
 * either way), so it is eligible for a *different* sweep that first checks
 * whether the session is actually finished before ever archiving it.
 */
export function listIdlePlanningSessionsEligibleForTerminalSweep(
  cutoffMs: number,
): Session[] {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE status = 'idle'
         AND ended_at IS NOT NULL
         AND ended_at < @cutoff
         AND archived = 0`,
    )
    .all({ cutoff: cutoffMs }) as Session[];
  return rows.filter((r) => isPlanningSession(r.session_type ?? ''));
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
      AND session_type IN (${PLANNING_SESSION_TYPE_SQL_LIST})
      AND archived = 0
  `,
    )
    .all();
  return rows.some((row) => normalizeBoardId(row.task_id ?? '') === norm);
}

/** A planning flow whose dispatch-eligibility predicate needs its own re-dispatch dedup — see planningCandidates.ts. */
export type DedupedPlanningFlow = 'groom' | 'design' | 'ops' | 'docs';

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
  return getActivePlanningSessionForTask(taskId, flow) !== undefined;
}

/**
 * The row-returning counterpart to hasActivePlanningSessionForTask — used by
 * the abort route (routes/taskAbort.ts) to resolve the specific session id
 * to kill, rather than just a boolean. Same non-terminal (running OR parked
 * idle), flow-scoped, archived=0 filter.
 */
export function getActivePlanningSessionForTask(
  taskId: string,
  flow: DedupedPlanningFlow,
): Session | undefined {
  const norm = normalizeBoardId(taskId);
  const rows = db
    .prepare<{ flow: string }, Session>(
      `
    SELECT * FROM sessions
    WHERE status NOT IN (${TERMINAL_STATUS_SQL_LIST})
      AND session_type = @flow
      AND archived = 0
  `,
    )
    .all({ flow }) as Session[];
  return rows.find((row) => normalizeBoardId(row.task_id ?? '') === norm);
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
      s.total_input_tokens, s.total_output_tokens, s.model, s.effort, s.task_name,
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

/**
 * Default/maximum page size for getArchivedSessionsPage — bounds the
 * /api/sessions/archived response so it no longer returns every archived
 * row's full record on every dashboard load (measured at 8.7 MB / 6,571 rows
 * live). Also trims the column set to what the history list actually
 * renders, dropping heavy fields (metadata, note, tags) a list view never
 * needs.
 */
export const ARCHIVED_SESSIONS_MAX_PAGE_SIZE = 200;

export interface ArchivedSessionsPage {
  sessions: Session[];
  total: number;
  limit: number;
  offset: number;
}

/** Bounded, projected page of archived sessions for the /archived list route. */
export function getArchivedSessionsPage(
  limit: number,
  offset: number,
): ArchivedSessionsPage {
  const boundedLimit = Math.min(
    Math.max(1, Math.trunc(limit)),
    ARCHIVED_SESSIONS_MAX_PAGE_SIZE,
  );
  const boundedOffset = Math.max(0, Math.trunc(offset));

  const sessions = db
    .prepare(
      `
    SELECT
      session_id, task_id, task_url, project_context_url,
      project_id, status, started_at, ended_at, worktree_path,
      archived, favorited, session_type, note, tags,
      total_input_tokens, total_output_tokens, model, effort, task_name,
      pr_url
    FROM sessions
    WHERE archived = 1
    ORDER BY started_at DESC
    LIMIT @limit OFFSET @offset
  `,
    )
    .all({ limit: boundedLimit, offset: boundedOffset }) as Session[];

  const { count } = db
    .prepare('SELECT COUNT(*) AS count FROM sessions WHERE archived = 1')
    .get() as { count: number };

  return { sessions, total: count, limit: boundedLimit, offset: boundedOffset };
}

export function archiveSession(sessionId: string): boolean {
  const current = getStmtGetSession().get({ session_id: sessionId }) as
    | { task_id: string | null; session_type: SessionType; archived: number }
    | undefined;
  const result = db
    .prepare('UPDATE sessions SET archived = 1 WHERE session_id = ?')
    .run(sessionId);
  if (result.changes > 0 && current && current.archived !== 1) {
    recordLegacyStatusSignal(
      sessionId,
      current.task_id ?? null,
      current.session_type,
      'archived',
      Date.now(),
    );
  }
  return result.changes > 0;
}

export function unarchiveSession(sessionId: string): boolean {
  const current = getStmtGetSession().get({ session_id: sessionId }) as
    | { task_id: string | null; session_type: SessionType; archived: number }
    | undefined;
  const result = db
    .prepare('UPDATE sessions SET archived = 0 WHERE session_id = ?')
    .run(sessionId);
  if (result.changes > 0 && current && current.archived !== 0) {
    recordLegacyStatusSignal(
      sessionId,
      current.task_id ?? null,
      current.session_type,
      'unarchived',
      Date.now(),
    );
  }
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
  const rows = db
    .prepare(
      `SELECT session_id, task_id, session_type FROM sessions
       WHERE status IN (${BASE_TERMINAL_STATUS_SQL_LIST}) AND archived = 0`,
    )
    .all() as {
    session_id: string;
    task_id: string | null;
    session_type: SessionType;
  }[];

  const result = db
    .prepare(
      `UPDATE sessions SET archived = 1 WHERE status IN (${BASE_TERMINAL_STATUS_SQL_LIST})`,
    )
    .run();

  const recordedAt = Date.now();
  for (const row of rows) {
    recordLegacyStatusSignal(
      row.session_id,
      row.task_id ?? null,
      row.session_type,
      'archived',
      recordedAt,
    );
  }

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
      `SELECT session_id, task_id, session_type FROM sessions
       WHERE status IN (${BASE_TERMINAL_STATUS_SQL_LIST})
         AND archived = 0
         AND ended_at IS NOT NULL
         AND ended_at < @cutoff`,
    )
    .all({ cutoff: cutoffMs }) as {
    session_id: string;
    task_id: string | null;
    session_type: SessionType;
  }[];

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.session_id);
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(
    `UPDATE sessions SET archived = 1 WHERE session_id IN (${placeholders})`,
  ).run(...ids);

  const recordedAt = Date.now();
  for (const row of rows) {
    recordLegacyStatusSignal(
      row.session_id,
      row.task_id ?? null,
      row.session_type,
      'archived',
      recordedAt,
    );
  }

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

export function setSessionEffort(sessionId: string, effort: string): void {
  db.prepare('UPDATE sessions SET effort = ? WHERE session_id = ?').run(
    effort,
    sessionId,
  );
}

export function setSessionModelSettingKey(
  sessionId: string,
  key: string,
): void {
  db.prepare(
    'UPDATE sessions SET model_setting_key = ? WHERE session_id = ?',
  ).run(key, sessionId);
}

export function setSessionEffortSettingKey(
  sessionId: string,
  key: string,
): void {
  db.prepare(
    'UPDATE sessions SET effort_setting_key = ? WHERE session_id = ?',
  ).run(key, sessionId);
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

/**
 * Durable per-session capture of a task's declared-writes set (see
 * readinessGate.ts's DeclaredWriteEntry), written exactly once at
 * SessionManager.start() spawn time and read at capability-request time
 * (routes/stagedIntents.ts's maybeAutoApproveCapabilityRequest, via
 * getSessionDeclaredWrites below) — never re-derived from a live task-body
 * fetch, so a mid-session task-body edit cannot retroactively widen an
 * already-dispatched session's auto-approve eligibility. Backed by the
 * existing `sessions.metadata` JSON column (mirrors setDerivedTitle above)
 * rather than a dedicated column.
 */
export function setSessionDeclaredWrites(
  sessionId: string,
  declaredWrites: { capability: string; prodMutating: boolean }[],
): void {
  setSessionMetadata(sessionId, { declaredWrites });
}

/** Reads back the declared-writes set captured by setSessionDeclaredWrites. Empty when never captured (session dispatched before this feature, or a non-ops session). */
export function getSessionDeclaredWrites(
  sessionId: string,
): { capability: string; prodMutating: boolean }[] {
  const row = db
    .prepare('SELECT metadata FROM sessions WHERE session_id = ?')
    .get(sessionId) as { metadata: string | null } | undefined;
  if (!row?.metadata) return [];
  try {
    const parsed = JSON.parse(row.metadata) as {
      declaredWrites?: unknown;
    };
    return Array.isArray(parsed.declaredWrites)
      ? (parsed.declaredWrites as {
          capability: string;
          prodMutating: boolean;
        }[])
      : [];
  } catch {
    return [];
  }
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

let _stmtInsertEvent: Database.Statement | null = null;
let _stmtInsertEventOrIgnore: Database.Statement | null = null;
let _stmtUpdateEventPayload: Database.Statement | null = null;
let _stmtGetEventsBySession: Database.Statement | null = null;

/** Lazily-prepared session_events insert — shared by insertEvent and upsertSessionEvent. */
function getStmtInsertEvent(): Database.Statement {
  _stmtInsertEvent ??= db.prepare<
    NewSessionEvent & { message_id: string | null }
  >(`
    INSERT INTO session_events (session_id, event_type, payload, timestamp, message_id)
    VALUES (@session_id, @event_type, @payload, @timestamp, @message_id)
  `);
  return _stmtInsertEvent;
}

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

let _stmtGetLastActivityMsForArchivedSessions: Database.Statement | null = null;

/**
 * Bulk counterpart to getSessionLastActivityMs for the archived-sessions
 * route: one aggregate query for every archived session's last activity
 * instead of one query per row, so the route's cost no longer scales with
 * the number of archived sessions.
 */
export function getLastActivityMsForArchivedSessions(): Map<string, number> {
  _stmtGetLastActivityMsForArchivedSessions ??= db.prepare(`
    SELECT se.session_id AS session_id, MAX(se.timestamp) AS ts
    FROM session_events se
    JOIN sessions s ON s.session_id = se.session_id
    WHERE s.archived = 1
    GROUP BY se.session_id
  `);
  const rows = _stmtGetLastActivityMsForArchivedSessions.all() as {
    session_id: string;
    ts: number;
  }[];
  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.session_id, row.ts);
  }
  return result;
}

/**
 * Count of tool_use session_events with no matching tool_result yet,
 * derived from event ordering rather than an in-memory counter — every
 * tool_use row whose id is past the most recent tool_result row's id is
 * still "in flight". Used by callers (e.g. StalledPRReconciler) that only
 * see a session through periodic DB polls rather than the live message
 * stream StuckSessionMonitor's own pendingToolUseCount tracks.
 */
export function getPendingToolUseCount(sessionId: string): number {
  const row = db
    .prepare<[string, string], { count: number }>(
      `SELECT COUNT(*) AS count FROM session_events
       WHERE session_id = ? AND event_type = 'tool_use'
         AND id > COALESCE(
           (SELECT MAX(id) FROM session_events WHERE session_id = ? AND event_type = 'tool_result'),
           0
         )`,
    )
    .get(sessionId, sessionId);
  return row?.count ?? 0;
}

export function insertEvent(e: NewSessionEvent): void {
  getStmtInsertEvent().run({
    message_id: null,
    ...e,
    payload: capEventPayload(e.payload),
  });
}

export function insertEventOrIgnore(e: NewSessionEvent): void {
  _stmtInsertEventOrIgnore ??= db.prepare<
    NewSessionEvent & { message_id: string | null }
  >(`
    INSERT OR IGNORE INTO session_events (session_id, event_type, payload, timestamp, message_id)
    VALUES (@session_id, @event_type, @payload, @timestamp, @message_id)
  `);
  _stmtInsertEventOrIgnore.run({
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
    _stmtUpdateEventPayload ??= db.prepare<{
      id: number;
      payload: string;
      timestamp: number;
    }>(`
      UPDATE session_events SET payload = @payload, timestamp = @timestamp WHERE id = @id
    `);
    _stmtUpdateEventPayload.run({
      id: existingId,
      payload: cappedPayload,
      timestamp: e.timestamp,
    });
    return existingId;
  }
  const sessionRow = getStmtGetSession().get({ session_id: e.session_id });
  if (!sessionRow) {
    logger.error(
      `[upsertSessionEvent] no sessions row for ${e.session_id} — dropping event (type=${e.event_type})`,
    );
    return -1;
  }
  const result = getStmtInsertEvent().run({
    message_id: null,
    ...e,
    payload: cappedPayload,
  });
  return result.lastInsertRowid as number;
}

export function getEventsBySession(sessionId: string): SessionEvent[] {
  _stmtGetEventsBySession ??= db.prepare<{ session_id: string }>(`
    SELECT * FROM session_events WHERE session_id = @session_id ORDER BY id ASC
  `);
  return _stmtGetEventsBySession.all({
    session_id: sessionId,
  }) as SessionEvent[];
}

// ─── session_events (project-scoped aggregate read) ────────────────────────

/**
 * Filters accepted by the project-scoped session_events read
 * (`sessionEvents.query` MCP tool, see mcp/tools/sessionEventsReadTools.ts).
 * Mirrors AuditLogQueryFilters' `since`/`until` shape, but there is no
 * `eventType` filter — session_events only has four values (system, text,
 * user_message, rate_limit), which makes it a near-useless discriminator —
 * and `pattern` replaces it as the filter that actually matters: a
 * substring match against the (large, assistant-turn-JSON) `payload` column.
 */
export interface SessionEventsProjectQueryFilters {
  /** Substring match against `payload` (SQL LIKE, case-sensitive per SQLite's default). */
  pattern?: string;
  /** Inclusive lower bound on `timestamp` (epoch ms — session_events stores this as an integer, never ISO text). */
  since?: number;
  /** Inclusive upper bound on `timestamp` (epoch ms). */
  until?: number;
}

/** One session's aggregate slice of a project-scoped session_events query — the default, payload-free return shape. */
export interface SessionEventsAggregateRow {
  session_id: string;
  count: number;
  first_timestamp: number;
  last_timestamp: number;
}

/** Hard cap on rows returned when a caller opts into payload bodies — see querySessionEventsByProjectRows. */
export const SESSION_EVENTS_ROW_CAP = 200;

function buildSessionEventsFilterClauses(
  filters: SessionEventsProjectQueryFilters,
): { clauses: string[]; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filters.pattern !== undefined) {
    clauses.push('session_events.payload LIKE ?');
    params.push(`%${filters.pattern}%`);
  }
  if (filters.since !== undefined) {
    clauses.push('session_events.timestamp >= ?');
    params.push(filters.since);
  }
  if (filters.until !== undefined) {
    clauses.push('session_events.timestamp <= ?');
    params.push(filters.until);
  }
  return { clauses, params };
}

/**
 * Aggregate-first project-scoped read over session_events — grouped by
 * session_id, with counts and a first/last timestamp per session rather
 * than payload bodies (see SESSION_EVENTS_ROW_CAP's sibling,
 * querySessionEventsByProjectRows, for the explicit-opt-in raw read). This
 * is the default shape `sessionEvents.query` returns: it answers "did X
 * happen, across any session in this project" without ever risking the
 * tool-result size limit a naive `SELECT *` over every session's raw
 * assistant-turn JSON would blow.
 */
export function querySessionEventsByProjectAggregate(
  projectId: string,
  filters: SessionEventsProjectQueryFilters = {},
): SessionEventsAggregateRow[] {
  const { clauses, params } = buildSessionEventsFilterClauses(filters);
  const whereExtra = clauses.map((c) => `AND ${c}`).join(' ');
  return db
    .prepare<(string | number)[], SessionEventsAggregateRow>(
      `
      SELECT session_events.session_id AS session_id,
             COUNT(*) AS count,
             MIN(session_events.timestamp) AS first_timestamp,
             MAX(session_events.timestamp) AS last_timestamp
      FROM session_events
      JOIN sessions ON sessions.session_id = session_events.session_id
      WHERE sessions.project_id = ? ${whereExtra}
      GROUP BY session_events.session_id
      ORDER BY last_timestamp DESC
    `,
    )
    .all(projectId, ...params);
}

/**
 * Explicit-opt-in raw read over session_events, project-scoped and capped
 * at `limit` (never more than SESSION_EVENTS_ROW_CAP) rows — the only path
 * back to actual payload bodies, since those are large assistant-turn JSON
 * blobs and an unbounded project-wide read of them is exactly what blew the
 * tool-result size limit on the audit_log equivalent (see the task context:
 * a single unscoped auditLog.query returned 1.4M characters).
 */
export function querySessionEventsByProjectRows(
  projectId: string,
  filters: SessionEventsProjectQueryFilters = {},
  limit: number = SESSION_EVENTS_ROW_CAP,
): SessionEvent[] {
  const cappedLimit = Math.min(limit, SESSION_EVENTS_ROW_CAP);
  const { clauses, params } = buildSessionEventsFilterClauses(filters);
  const whereExtra = clauses.map((c) => `AND ${c}`).join(' ');
  return db
    .prepare<(string | number)[], SessionEvent>(
      `
      SELECT session_events.*
      FROM session_events
      JOIN sessions ON sessions.session_id = session_events.session_id
      WHERE sessions.project_id = ? ${whereExtra}
      ORDER BY session_events.timestamp DESC
      LIMIT ?
    `,
    )
    .all(projectId, ...params, cappedLimit);
}

let _stmtClearPermissionDenials: Database.Statement | null = null;

export function clearPermissionDenials(): void {
  _stmtClearPermissionDenials ??= db.prepare(`DELETE FROM permission_denials`);
  _stmtClearPermissionDenials.run();
}

// ─── permission_denials ─────────────────────────────────────────────────────

let _stmtInsertPermissionDenial: Database.Statement | null = null;
let _stmtGetDenialsBySession: Database.Statement | null = null;

export function insertPermissionDenial(d: NewPermissionDenialRow): void {
  _stmtInsertPermissionDenial ??= db.prepare<NewPermissionDenialRow>(`
    INSERT INTO permission_denials (session_id, tool_name, tool_use_id, tool_input, timestamp)
    VALUES (@session_id, @tool_name, @tool_use_id, @tool_input, @timestamp)
  `);
  _stmtInsertPermissionDenial.run(d);
}

export function getDenialsBySession(sessionId: string): PermissionDenialRow[] {
  _stmtGetDenialsBySession ??= db.prepare<{ session_id: string }>(`
    SELECT * FROM permission_denials WHERE session_id = @session_id ORDER BY id ASC
  `);
  return _stmtGetDenialsBySession.all({
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

let _stmtUpsertTaskCache: Database.Statement | null = null;
let _stmtGetTaskCache: Database.Statement | null = null;

/** Lazily-prepared task_cache upsert — shared by updateTaskCacheStatus, upsertTaskCache, and updateTaskStatusInBoardCaches. */
function getStmtUpsertTaskCache(): Database.Statement {
  _stmtUpsertTaskCache ??= db.prepare<{
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
  return _stmtUpsertTaskCache;
}

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
    getStmtUpsertTaskCache().run({
      task_id: row.task_id,
      fetched_at: row.fetched_at,
      raw_json: JSON.stringify(parsed),
    });
  } catch {
    // If parsing fails, leave cache as-is rather than deleting it
  }
}

export function upsertTaskCache(taskId: string, rawJson: string): void {
  getStmtUpsertTaskCache().run({
    task_id: taskId,
    fetched_at: Date.now(),
    raw_json: rawJson,
  });
}

export function getTaskCache(taskId: string): TaskCache | undefined {
  _stmtGetTaskCache ??= db.prepare<{ task_id: string }>(`
    SELECT * FROM task_cache WHERE task_id = @task_id
  `);
  return _stmtGetTaskCache.get({ task_id: taskId }) as TaskCache | undefined;
}

export function getCacheAge(taskId: string): number {
  const row = getTaskCache(taskId);
  if (!row) return Infinity;
  return Date.now() - row.fetched_at;
}

export function deleteTaskCacheRow(taskId: string): void {
  db.prepare(`DELETE FROM task_cache WHERE task_id = ?`).run(taskId);
}

let _stmtGetBoardCacheRows: Database.Statement | null = null;

/** Lazily-prepared board:* cache read — shared by updateTaskStatusInBoardCaches and getAllBoardCacheTasks. */
function getStmtGetBoardCacheRows(): Database.Statement {
  _stmtGetBoardCacheRows ??= db.prepare(
    `SELECT task_id, fetched_at, raw_json FROM task_cache WHERE task_id LIKE 'board:%'`,
  );
  return _stmtGetBoardCacheRows;
}

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
    rows = getStmtGetBoardCacheRows().all() as Array<{
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
      getStmtUpsertTaskCache().run({
        task_id: row.task_id,
        fetched_at: row.fetched_at,
        raw_json: JSON.stringify(tasks),
      });
    } catch {
      // Non-fatal: leave the row as-is rather than failing the status write.
    }
  }
}

let _stmtRecordTaskStatusWrite: Database.Statement | null = null;
let _stmtGetTaskStatusWrite: Database.Statement | null = null;

/**
 * Window a recorded status write stays authoritative over a bulk board
 * fetch. Bounded to comfortably exceed NotionClient's 60s board-cache TTL
 * (see CACHE_TTL_MS in notion/NotionClient.ts) — the race this guards
 * against is a bulk fetch started before the write and resolved after it, or
 * a cache-hit still inside that TTL window. Past this window, trust fetched
 * data fully rather than pinning a write indefinitely (e.g. a later
 * out-of-band Notion edit should eventually take effect).
 */
const STATUS_WRITE_RECONCILE_WINDOW_MS = 120_000;

/**
 * Record that a status write for `taskId` landed. Called from the write path
 * (AuditingTaskBackend.updateStatus) alongside updateTaskStatusInBoardCaches
 * so bulk board-fetch reconciliation has a ground-truth timestamp to compare
 * against.
 */
export function recordTaskStatusWrite(taskId: string, status: string): void {
  const normalized = normalizeTaskId(taskId);
  _stmtRecordTaskStatusWrite ??= db.prepare<{
    task_id: string;
    status: string;
    written_at: number;
  }>(`
    INSERT INTO task_status_writes (task_id, status, written_at)
    VALUES (@task_id, @status, @written_at)
    ON CONFLICT(task_id) DO UPDATE SET
      status     = excluded.status,
      written_at = excluded.written_at
  `);
  _stmtRecordTaskStatusWrite.run({
    task_id: normalized,
    status,
    written_at: Date.now(),
  });
}

/**
 * Returns the most recently written status for `taskId` if it was recorded
 * within STATUS_WRITE_RECONCILE_WINDOW_MS, else null. Used to reconcile a
 * bulk board fetch that may have raced a status write — see
 * recordTaskStatusWrite.
 */
export function getRecentTaskStatusWrite(taskId: string): string | null {
  const normalized = normalizeTaskId(taskId);
  _stmtGetTaskStatusWrite ??= db.prepare<{ task_id: string }>(`
    SELECT status, written_at FROM task_status_writes WHERE task_id = @task_id
  `);
  const row = _stmtGetTaskStatusWrite.get({ task_id: normalized }) as
    | { status: string; written_at: number }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.written_at > STATUS_WRITE_RECONCILE_WINDOW_MS) {
    return null;
  }
  return row.status;
}

/** Minimal shape read out of cached board blobs — just enough for reverse-dependency lookup. */
export interface CachedBoardTaskEntry {
  id: string;
  status: string;
  dependsOn: string[];
}

/**
 * Every task entry across all cached `board:*` blobs, deduped by normalized
 * id (last write wins). This is the same cache `updateTaskStatusInBoardCaches`
 * patches in place, so it reflects the latest known status/dependsOn without
 * a live Notion round-trip. Best-effort: an unparseable row is skipped rather
 * than failing the caller.
 */
export function getAllBoardCacheTasks(): CachedBoardTaskEntry[] {
  let rows: Array<{ task_id: string; fetched_at: number; raw_json: string }>;
  try {
    rows = getStmtGetBoardCacheRows().all() as Array<{
      task_id: string;
      fetched_at: number;
      raw_json: string;
    }>;
  } catch {
    return [];
  }
  const byId = new Map<string, CachedBoardTaskEntry>();
  for (const row of rows) {
    let tasks: unknown;
    try {
      tasks = JSON.parse(row.raw_json);
    } catch {
      continue;
    }
    if (!Array.isArray(tasks)) continue;
    for (const entry of tasks) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { id?: unknown }).id === 'string' &&
        typeof (entry as { status?: unknown }).status === 'string'
      ) {
        const e = entry as {
          id: string;
          status: string;
          dependsOn?: unknown;
        };
        byId.set(normalizeTaskId(e.id), {
          id: e.id,
          status: e.status,
          dependsOn: Array.isArray(e.dependsOn)
            ? e.dependsOn.filter((d): d is string => typeof d === 'string')
            : [],
        });
      }
    }
  }
  return [...byId.values()];
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

/**
 * Additively accumulate the session's cache-token spend. Each result event's
 * usage.cache_read_input_tokens/cache_creation_input_tokens is already the
 * cumulative total across every API call *in that turn*, so summing it across
 * turns (result events) gives the session-wide cumulative total — the same
 * additive rule incrementTokens applies for input/output tokens.
 */
export function incrementCacheTokens(
  sessionId: string,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): void {
  db.prepare(
    `UPDATE sessions
     SET cache_read_tokens = cache_read_tokens + ?,
         cache_creation_tokens = cache_creation_tokens + ?
     WHERE session_id = ?`,
  ).run(cacheReadTokens, cacheCreationTokens, sessionId);
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

/** Returns a cached task's Notion Type (e.g. "💻 Code"), or null if unknown. */
export function getTaskTypeFromCache(taskId: string): string | null {
  const row = getTaskCache(taskId);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.raw_json) as { type?: unknown };
    return typeof parsed.type === 'string' ? parsed.type : null;
  } catch {
    return null;
  }
}

/**
 * Returns a cached task's display-format status string, or null if unknown.
 * Mirrors updateTaskCacheStatus's read shape: NotionTask stores status at
 * top-level; raw Notion API uses properties.Status.select.name.
 */
export function getTaskStatusFromCache(taskId: string): string | null {
  const row = getTaskCache(taskId);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.raw_json) as {
      status?: unknown;
      properties?: { Status?: { select?: { name?: unknown } } };
    };
    if (typeof parsed.status === 'string') return parsed.status;
    const selectName = parsed.properties?.Status?.select?.name;
    return typeof selectName === 'string' ? selectName : null;
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
    | 'stalled_retry_base_exhausted'
    | 'session_initiated_close_at'
    | 'reviewer_requested_at'
    | 'flake_recovery_attempts'
    | 'flake_recovery_base_exhausted'
    | 'human_merge_only'
    | 'pr_intent_id'
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
  const now = new Date().toISOString();
  db.prepare<{
    pr_number: number;
    repo: string;
    head_sha: string | null;
    updated_at: string;
  }>(
    `
    UPDATE pull_requests
    SET head_sha = @head_sha, stalled_pr_retry_count = 0,
        updated_at = @updated_at, synced_at = @updated_at
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({ pr_number: prNumber, repo, head_sha: sha, updated_at: now });
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

/**
 * Marks (or clears) whether the current stalled_pr_retry_count's most recent
 * gate_failed escalation was confirmed base-attributable — the sole scoping
 * signal the base-recovery reset in StalledPRReconciler consults before
 * restoring this PR's budget, so recovery never resets an unrelated PR's
 * counter.
 */
export function setStalledRetryBaseExhausted(
  prNumber: number,
  repo: string,
  value: boolean,
): void {
  db.prepare<{ pr_number: number; repo: string; value: number }>(
    `UPDATE pull_requests SET stalled_retry_base_exhausted = @value WHERE pr_number = @pr_number AND repo = @repo`,
  ).run({ pr_number: prNumber, repo, value: value ? 1 : 0 });
}

/**
 * Resets stalled_pr_retry_count to 0 once the project's base branch
 * recovers, for a PR whose most recent exhaustion was itself confirmed
 * base-attributable (see baseAttribution.ts) — the head_sha-change reset
 * (setHeadSha) is this counter's other, pre-existing reset trigger. Always
 * clears stalled_retry_base_exhausted alongside the count.
 */
export function resetStalledPRRetryCountForBaseRecovery(
  prNumber: number,
  repo: string,
): void {
  db.prepare<{ pr_number: number; repo: string }>(
    `UPDATE pull_requests SET stalled_pr_retry_count = 0, stalled_retry_base_exhausted = 0 WHERE pr_number = @pr_number AND repo = @repo`,
  ).run({ pr_number: prNumber, repo });
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

// A PR row's identity/provenance fields are set once at creation and never
// mutate afterward; everything else (state, review/merge/CI status, pause
// reason, etc.) has no per-field historical record until the sibling
// point-in-time instrumentation task lands — see module header.
const PR_STATIC_FIELDS = new Set<keyof PullRequestRow>([
  'id',
  'pr_number',
  'pr_url',
  'task_id',
  'session_id',
  'repo',
  'head_branch',
  'base_branch',
  'created_at',
  'node_id',
]);

const PR_UNRECONSTRUCTABLE_REASON =
  'pull_requests.* mutable fields (state, review/merge/CI status, pause reason, etc.) have no historical record until the point-in-time instrumentation task lands — cannot answer "what was this PR\'s state at T", only "what is it now"';

export type PRAsOf = {
  [K in keyof PullRequestRow]: PullRequestRow[K] | Unreconstructable;
};

/**
 * Point-in-time read of the most recent PR for a task, as of `asOf`. Only
 * the static identity fields (see PR_STATIC_FIELDS) come back with real
 * values; every mutable field is an Unreconstructable marker — see module
 * header. Returns undefined both when no PR exists for the task and when the
 * PR wasn't created yet as of `asOf`.
 */
export function getPRAsOf(taskId: string, asOf: string): PRAsOf | undefined {
  const current = getPRByNotionTaskId(taskId);
  if (!current) return undefined;
  const asOfMs = Date.parse(asOf);
  if (current.created_at && Date.parse(current.created_at) > asOfMs) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(current) as (keyof PullRequestRow)[]) {
    result[key] = PR_STATIC_FIELDS.has(key)
      ? current[key]
      : unreconstructable(PR_UNRECONSTRUCTABLE_REASON);
  }
  return result as PRAsOf;
}

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

/**
 * Default cap on terminal (merged/closed) rows returned by getPRs. Open rows
 * are never subject to this cap — the request-scoped stale-open reconciliation
 * in routes/prs.ts is the only repair path for escalated state='open' rows,
 * so every open row must always be visible to it.
 */
const PR_LIST_TERMINAL_LIMIT = 50;

/**
 * Returns all open PRs for a repo plus the most recently updated terminal
 * (merged/closed) PRs, capped at `terminalLimit`. Unlike a flat "most recent
 * N overall" query, this guarantees every open row is present regardless of
 * how many terminal rows the project has accumulated.
 */
export function getPRs(
  repo: string,
  terminalLimit: number = PR_LIST_TERMINAL_LIMIT,
): PullRequestRow[] {
  const openRows = db
    .prepare<{ repo: string }>(
      `
    SELECT * FROM pull_requests WHERE repo = @repo AND state = 'open' ORDER BY pr_number DESC
  `,
    )
    .all({ repo }) as PullRequestRow[];
  const terminalRows = db
    .prepare<{ repo: string; limit: number }>(
      `
    SELECT * FROM pull_requests WHERE repo = @repo AND state != 'open'
    ORDER BY updated_at DESC LIMIT @limit
  `,
    )
    .all({ repo, limit: terminalLimit }) as PullRequestRow[];
  return [...openRows, ...terminalRows].sort(
    (a, b) => b.pr_number - a.pr_number,
  );
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
  const before = getPRByNumber(prNumber, repo);
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
  if (before && before.review_result !== result) {
    recordEvent({
      event_type: 'pr_review_result_changed',
      actor_type: 'system',
      task_id: before.task_id ?? null,
      payload: {
        pr_number: prNumber,
        repo,
        from: before.review_result,
        to: result,
      },
    });
  }
}

/**
 * Persist a PR's latest depth-review verdict — the second, post-conformance
 * review pass (see ReviewOrchestrator.dispatchDepthReview). Distinct from
 * setPRReviewResult, which writes pull_requests.review_result (the
 * conformance verdict only); this table is never read or written by that
 * path. Upserted on (pr_number, repo) — a re-run overwrites the prior row.
 */
export function upsertDepthReviewVerdict(row: NewDepthReviewVerdictRow): void {
  db.prepare<
    NewDepthReviewVerdictRow & { recorded_at: string; route_count: number }
  >(
    `
    INSERT INTO depth_review_verdicts
      (pr_number, repo, head_sha, verdict, dimensions, summary, depth_session_id, recorded_at, route_count)
    VALUES
      (@pr_number, @repo, @head_sha, @verdict, @dimensions, @summary, @depth_session_id, @recorded_at, @route_count)
    ON CONFLICT(pr_number, repo) DO UPDATE SET
      head_sha = excluded.head_sha,
      verdict = excluded.verdict,
      dimensions = excluded.dimensions,
      summary = excluded.summary,
      depth_session_id = excluded.depth_session_id,
      recorded_at = excluded.recorded_at,
      route_count = excluded.route_count
  `,
  ).run({
    ...row,
    recorded_at: new Date().toISOString(),
    route_count: row.route_count ?? 0,
  });
}

/** Read the latest depth-review verdict for a PR, if any depth pass has completed. */
export function getDepthReviewVerdict(
  prNumber: number,
  repo: string,
): DepthReviewVerdictRow | null {
  return db
    .prepare<{ pr_number: number; repo: string }>(
      `
    SELECT * FROM depth_review_verdicts WHERE pr_number = @pr_number AND repo = @repo
  `,
    )
    .get({ pr_number: prNumber, repo }) as DepthReviewVerdictRow | null;
}

/**
 * Thrown by linkPRToPRIntent when the approved ops.prIntent named by
 * `intentId` already authorized a different PR — one approved PR-intent
 * authorizes exactly one PR (fire-once); re-use against a second PR is
 * rejected rather than silently re-pointed.
 */
export class PRIntentAlreadyConsumedError extends Error {
  constructor(intentId: string, prNumber: number, repo: string) {
    super(
      `PR-intent "${intentId}" already authorized PR #${prNumber} in ${repo} — ` +
        'an approved ops.prIntent authorizes exactly one PR.',
    );
    this.name = 'PRIntentAlreadyConsumedError';
  }
}

/**
 * Links a PR to the approved ops.prIntent it was opened for — the Ops
 * fire-once consumption point PRReviewService's getPRIntentForPR reads at
 * review time. Idempotent for the same (prNumber, repo): re-linking the same
 * PR to the same intent is a no-op write. Rejects with
 * PRIntentAlreadyConsumedError when `intentId` is already linked to a
 * *different* PR row.
 */
export function linkPRToPRIntent(
  prNumber: number,
  repo: string,
  intentId: string,
): void {
  const existing = db
    .prepare<{
      intent_id: string;
    }>(
      `SELECT pr_number, repo FROM pull_requests WHERE pr_intent_id = @intent_id`,
    )
    .get({ intent_id: intentId }) as
    | { pr_number: number; repo: string }
    | undefined;
  if (existing && (existing.pr_number !== prNumber || existing.repo !== repo)) {
    throw new PRIntentAlreadyConsumedError(
      intentId,
      existing.pr_number,
      existing.repo,
    );
  }
  db.prepare<{ pr_number: number; repo: string; intent_id: string }>(
    `UPDATE pull_requests SET pr_intent_id = @intent_id WHERE pr_number = @pr_number AND repo = @repo`,
  ).run({ pr_number: prNumber, repo, intent_id: intentId });
}

/**
 * Resolves the approved ops.prIntent a PR was linked to at open time (see
 * linkPRToPRIntent), or null for a PR with no linked PR-intent — every
 * non-Ops PR, or an Ops PR reviewed before the linking sibling mechanism
 * runs. PRReviewService uses this to build the Ops rubric's "changed files"
 * dimension against the approved declaration instead of a task-body section.
 */
export function getPRIntentForPR(
  prNumber: number,
  repo: string,
): StagedIntentRow | null {
  const pr = getPRByNumber(prNumber, repo);
  if (!pr?.pr_intent_id) return null;
  return getStagedIntent(pr.pr_intent_id) ?? null;
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
  const before = getPRByNumber(prNumber, repo);
  db.prepare<{ pr_number: number; repo: string; state: string }>(
    `
    UPDATE pull_requests SET state = @state WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({ pr_number: prNumber, repo, state });
  if (before && before.state !== state) {
    recordEvent({
      event_type: 'pr_state_changed',
      actor_type: 'system',
      task_id: before.task_id ?? null,
      payload: { pr_number: prNumber, repo, from: before.state, to: state },
    });
  }
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
  const now = new Date().toISOString();
  const before = getPRByNumber(prNumber, repo);
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
        failing_checks = @failing_checks,
        updated_at = @checked_at,
        synced_at = @checked_at
    WHERE pr_number = @pr_number AND repo = @repo
  `,
  ).run({
    pr_number: prNumber,
    repo,
    mergeable,
    merge_state: mergeState,
    checked_at: now,
    failing_checks: failingChecksJson,
  });
  if (
    before &&
    (before.mergeable !== mergeable || before.merge_state !== mergeState)
  ) {
    recordEvent({
      event_type: 'pr_merge_state_changed',
      actor_type: 'system',
      task_id: before.task_id ?? null,
      payload: {
        pr_number: prNumber,
        repo,
        from_mergeable: before.mergeable,
        to_mergeable: mergeable,
        from_merge_state: before.merge_state,
        to_merge_state: mergeState,
      },
    });
  }
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

/**
 * Resets flake_recovery_attempts to 0 — called both on a passing verified-
 * flaky re-run (the original trigger) and, per the base-attributable-
 * failures exemption, once the project's base branch recovers for a PR
 * whose most recent exhaustion was itself base-attributable. Always clears
 * flake_recovery_base_exhausted alongside the count — a reset counter can
 * never legitimately be marked "exhausted for a base reason" a moment later.
 */
export function resetFlakeRecoveryAttempts(
  prNumber: number,
  repo: string,
): void {
  db.prepare(
    `UPDATE pull_requests SET flake_recovery_attempts = 0, flake_recovery_base_exhausted = 0 WHERE pr_number = ? AND repo = ?`,
  ).run(prNumber, repo);
}

/**
 * Marks (or clears) whether the current flake_recovery_attempts count's most
 * recent charge-worthy failure was confirmed base-attributable — the sole
 * scoping signal the base-recovery reset in PRMergeWatcher consults before
 * restoring this PR's budget, so recovery never resets an unrelated PR's
 * counter.
 */
export function setFlakeRecoveryBaseExhausted(
  prNumber: number,
  repo: string,
  value: boolean,
): void {
  db.prepare(
    `UPDATE pull_requests SET flake_recovery_base_exhausted = ? WHERE pr_number = ? AND repo = ?`,
  ).run(value ? 1 : 0, prNumber, repo);
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
  const before = getPRByNumber(prNumber, repo);
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
  if (before && before.pause_reason !== serialized) {
    recordEvent({
      event_type: 'pr_pause_reason_changed',
      actor_type: 'system',
      task_id: before.task_id ?? null,
      payload: {
        pr_number: prNumber,
        repo,
        from: before.pause_reason,
        to: serialized,
      },
    });
  }
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
      AND json_extract(review_result, '$.verdict') = 'approved'
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
  // planning session (session_type IN PLANNING_SESSION_TYPES — see session/sessionPredicates.ts)
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
  pr_flake_recovery_attempts: number | null;
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
        WHERE session_type IN (${PLANNING_SESSION_TYPE_SQL_LIST})
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
      pr.flake_recovery_attempts AS pr_flake_recovery_attempts,
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

/**
 * Returns the most recent ops session for a given task ID. Read by the
 * ops-journal route's deferred close (see setEntryState -> 'resolved'
 * handler) to look up the terminal_completion_reason of the session whose
 * journal entry just settled, since the operator-confirmed
 * applied-pending-confirm -> resolved transition typically happens well
 * after that session has gone terminal.
 */
export function getLatestOpsSessionByTaskId(
  taskId: string,
): Session | undefined {
  return db
    .prepare<{ task_id: string }>(
      `
    SELECT * FROM sessions
    WHERE task_id = @task_id AND session_type = 'ops'
    ORDER BY started_at DESC
    LIMIT 1
  `,
    )
    .get({ task_id: taskId }) as Session | undefined;
}

/** Returns the most recent docs session for a given task ID — the docs-flow counterpart to getLatestOpsSessionByTaskId. */
export function getLatestDocsSessionByTaskId(
  taskId: string,
): Session | undefined {
  return db
    .prepare<{ task_id: string }>(
      `
    SELECT * FROM sessions
    WHERE task_id = @task_id AND session_type = 'docs'
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
      AND json_extract(lb.review_result, '$.verdict') = 'approved'
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

// ─── behind-deploy preview ──────────────────────────────────────────────────

export interface BehindItem {
  kind: 'pr' | 'local-branch';
  taskId: string | null;
  title: string | null;
  mergedAt: string; // the row's updated_at
  prUrl?: string;
  prNumber?: number;
  branchName?: string;
}

/** Same repo-resolution as upsertPullRequest's repoConfigured check — github_repo may be a bare string or a JSON array of repos. */
function resolveProjectRepos(projectId: string): string[] {
  const project = listProjectRows().find((row) => row.id === projectId);
  const raw = project?.github_repo;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    // bare string
  }
  return [raw];
}

/**
 * Merged pull_requests + merged local_branches rows since `sinceIso` (the
 * project's last recorded deployed-SHA timestamp) — the DB-derived "behind"
 * preview. `sinceIso` null means the project has no project_deployed_sha row
 * (never deployed through this system): returns everything merged rather
 * than erroring.
 */
export function listMergedSince(
  projectId: string,
  sinceIso: string | null,
): BehindItem[] {
  const items: BehindItem[] = [];
  const repos = resolveProjectRepos(projectId);
  const prSessionIds = new Set<string>();

  if (repos.length > 0) {
    const placeholders = repos.map(() => '?').join(', ');
    const prRows = (
      sinceIso
        ? db
            .prepare(
              `SELECT pr_number, pr_url, task_id, title, updated_at, session_id
               FROM pull_requests
               WHERE repo IN (${placeholders}) AND state = 'merged' AND updated_at > ?
               ORDER BY updated_at ASC`,
            )
            .all(...repos, sinceIso)
        : db
            .prepare(
              `SELECT pr_number, pr_url, task_id, title, updated_at, session_id
               FROM pull_requests
               WHERE repo IN (${placeholders}) AND state = 'merged'
               ORDER BY updated_at ASC`,
            )
            .all(...repos)
    ) as Array<{
      pr_number: number;
      pr_url: string;
      task_id: string | null;
      title: string | null;
      updated_at: string | null;
      session_id: string | null;
    }>;
    for (const row of prRows) {
      if (row.session_id) {
        prSessionIds.add(row.session_id);
      }
      items.push({
        kind: 'pr',
        taskId: row.task_id,
        title: row.title,
        mergedAt: row.updated_at ?? '',
        prUrl: row.pr_url,
        prNumber: row.pr_number,
      });
    }
  }

  const branchRows = (
    sinceIso
      ? db
          .prepare(
            `SELECT lb.branch_name, lb.updated_at, lb.session_id, s.task_id, s.task_name
             FROM local_branches lb
             LEFT JOIN sessions s ON s.session_id = lb.session_id
             WHERE lb.project_id = ? AND lb.status = 'merged' AND lb.updated_at > ?
             ORDER BY lb.updated_at ASC`,
          )
          .all(projectId, sinceIso)
      : db
          .prepare(
            `SELECT lb.branch_name, lb.updated_at, lb.session_id, s.task_id, s.task_name
             FROM local_branches lb
             LEFT JOIN sessions s ON s.session_id = lb.session_id
             WHERE lb.project_id = ? AND lb.status = 'merged'
             ORDER BY lb.updated_at ASC`,
          )
          .all(projectId)
  ) as Array<{
    branch_name: string;
    updated_at: string;
    session_id: string | null;
    task_id: string | null;
    task_name: string | null;
  }>;
  for (const row of branchRows) {
    if (row.session_id && prSessionIds.has(row.session_id)) {
      continue;
    }
    items.push({
      kind: 'local-branch',
      taskId: row.task_id,
      title: row.task_name,
      mergedAt: row.updated_at,
      branchName: row.branch_name,
    });
  }

  items.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  return items;
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

// run_id/project/target_sha/started_at are set once at creation; status,
// current_step and completed_at have no per-field historical record until
// the sibling point-in-time instrumentation task lands — see module header.
const DEPLOY_RUN_STATIC_FIELDS = new Set<keyof DeployRunRow>([
  'run_id',
  'project',
  'target_sha',
  'started_at',
]);

const DEPLOY_RUN_UNRECONSTRUCTABLE_REASON =
  'deploy_run.status/current_step/completed_at have no historical record until the point-in-time instrumentation task lands — cannot answer "what was this run\'s status at T", only "what is it now"';

export type DeployRunAsOf = {
  [K in keyof DeployRunRow]: DeployRunRow[K] | Unreconstructable;
};

/**
 * Point-in-time read of a deploy_run row as of `asOf`. Only the static
 * identity fields (see DEPLOY_RUN_STATIC_FIELDS) come back with real values;
 * status/current_step/completed_at are Unreconstructable markers — see
 * module header. Returns undefined both when the run doesn't exist and when
 * it wasn't started yet as of `asOf`.
 */
export function getDeployRunAsOf(
  runId: string,
  asOf: string,
): DeployRunAsOf | undefined {
  const current = getDeployRun(runId);
  if (!current) return undefined;
  const asOfMs = Date.parse(asOf);
  if (Date.parse(current.started_at) > asOfMs) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(current) as (keyof DeployRunRow)[]) {
    result[key] = DEPLOY_RUN_STATIC_FIELDS.has(key)
      ? current[key]
      : unreconstructable(DEPLOY_RUN_UNRECONSTRUCTABLE_REASON);
  }
  return result as DeployRunAsOf;
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
  const before = getDeployRun(runId);
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
  if (before && before.status !== status) {
    recordEvent({
      event_type: 'deploy_run_status_changed',
      actor_type: 'system',
      project_id: before.project,
      payload: { run_id: runId, from: before.status, to: status },
    });
  }
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

// ─── session_poke_retry_counts ─────────────────────────────────────────────

function getSessionPokeRetryCount(sessionId: string): number {
  const row = db
    .prepare<{
      session_id: string;
    }>(
      `SELECT consecutive_failures FROM session_poke_retry_counts WHERE session_id = @session_id`,
    )
    .get({ session_id: sessionId }) as
    | { consecutive_failures: number }
    | undefined;
  return row?.consecutive_failures ?? 0;
}

/** Increment consecutive_failures for a session's poke/resume retry budget and return the new count. */
export function incrementSessionPokeRetryCount(sessionId: string): number {
  const now = Date.now();
  db.prepare(
    `INSERT INTO session_poke_retry_counts (session_id, consecutive_failures, last_failure_at)
     VALUES (?, 1, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       consecutive_failures = consecutive_failures + 1,
       last_failure_at = excluded.last_failure_at`,
  ).run(sessionId, now);
  return getSessionPokeRetryCount(sessionId);
}

export function resetSessionPokeRetryCount(sessionId: string): void {
  db.prepare(`DELETE FROM session_poke_retry_counts WHERE session_id = ?`).run(
    sessionId,
  );
}

// ─── session_pause_intervals ────────────────────────────────────────────────

export function insertPauseInterval(
  sessionId: string,
  pauseReason: CanonicalPauseReason,
): void {
  if (!getStmtGetSession().get({ session_id: sessionId })) {
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
  suspended: number;
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
  suspended: boolean,
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
    suspended: number;
  }>(
    `
    INSERT INTO stuck_session_timers
      (session_id, task_name, notify_deadline, pause_deadline, hard_stop_deadline,
       hard_stop_armed, notify_remaining_ms, pause_remaining_ms, hard_stop_remaining_ms, suspended)
    VALUES
      (@session_id, @task_name, @notify_deadline, @pause_deadline, @hard_stop_deadline,
       @hard_stop_armed, @notify_remaining_ms, @pause_remaining_ms, @hard_stop_remaining_ms, @suspended)
    ON CONFLICT(session_id) DO UPDATE SET
      task_name              = excluded.task_name,
      notify_deadline        = excluded.notify_deadline,
      pause_deadline         = excluded.pause_deadline,
      hard_stop_deadline     = excluded.hard_stop_deadline,
      hard_stop_armed        = excluded.hard_stop_armed,
      notify_remaining_ms    = excluded.notify_remaining_ms,
      pause_remaining_ms     = excluded.pause_remaining_ms,
      hard_stop_remaining_ms = excluded.hard_stop_remaining_ms,
      suspended              = excluded.suspended
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
    suspended: suspended ? 1 : 0,
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

// ─── orchestrator_test_results (legacy) ─────────────────────────────────────
//
// orchestrator_test_results (the legacy (pr_number, repo, sha)-keyed table)
// has no remaining production readers/writers — F2 (the orchestrator-run
// test gate) is fully migrated onto the shared test_request_runs
// content-hash cache (see the test_request_runs section below, and
// getLatestTestRequestRun / deleteTestRequestRunsForContentHash). The table
// itself is left in schema.ts as historical data; only its query functions
// were removed.

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

// ─── orchestrator_analyze_content_cache ─────────────────────────────────────

export interface AnalyzeContentCacheRow {
  command: string;
  content_hash: string;
  passed: number;
  output: string;
  ran_at: string;
}

/**
 * Narrower cache layer under orchestrator_analyze_results, keyed by command +
 * content-hash of that command's trigger-path files rather than by
 * (pr_number, repo, sha) — lets a byte-identical dependency state (e.g. the
 * same package.json/lockfile bump) reuse one audit result across different
 * PRs/SHAs.
 */
export function getAnalyzeContentCacheResult(
  command: string,
  contentHash: string,
): AnalyzeContentCacheRow | undefined {
  return db
    .prepare<{
      command: string;
      content_hash: string;
    }>(
      `SELECT * FROM orchestrator_analyze_content_cache WHERE command = @command AND content_hash = @content_hash`,
    )
    .get({ command, content_hash: contentHash }) as
    | AnalyzeContentCacheRow
    | undefined;
}

/**
 * INSERT OR IGNORE against the (command, content_hash) primary key — two
 * concurrently-admitted PRs racing to populate the same cache entry is
 * benign (one redundant audit run, not corruption), so this relies on the
 * unique constraint instead of adding new locking.
 */
export function insertAnalyzeContentCacheResult(
  command: string,
  contentHash: string,
  passed: boolean,
  output: string,
): void {
  db.prepare<{
    command: string;
    content_hash: string;
    passed: number;
    output: string;
    ran_at: string;
  }>(
    `INSERT OR IGNORE INTO orchestrator_analyze_content_cache (command, content_hash, passed, output, ran_at)
     VALUES (@command, @content_hash, @passed, @output, @ran_at)`,
  ).run({
    command,
    content_hash: contentHash,
    passed: passed ? 1 : 0,
    output,
    ran_at: new Date().toISOString(),
  });
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

// ─── audit_finding_dedup ────────────────────────────────────────────────────

export interface AuditFindingDedupRow {
  id: number;
  project_id: string;
  finding_identity: string;
  task_id: string;
  filed_at: string;
}

/** The dedup record for a (project, finding-identity) pair, or null if never filed. */
export function getAuditFindingDedup(
  projectId: string,
  findingIdentity: string,
): AuditFindingDedupRow | null {
  const row = db
    .prepare<{
      project_id: string;
      finding_identity: string;
    }>(
      `SELECT * FROM audit_finding_dedup WHERE project_id = @project_id AND finding_identity = @finding_identity`,
    )
    .get({ project_id: projectId, finding_identity: findingIdentity }) as
    | AuditFindingDedupRow
    | undefined;
  return row ?? null;
}

/** Records (or replaces) the task a finding was just filed as — one row per (project, finding-identity). */
export function upsertAuditFindingDedup(
  projectId: string,
  findingIdentity: string,
  taskId: string,
  filedAt: string,
): void {
  db.prepare<{
    project_id: string;
    finding_identity: string;
    task_id: string;
    filed_at: string;
  }>(
    `INSERT INTO audit_finding_dedup (project_id, finding_identity, task_id, filed_at)
     VALUES (@project_id, @finding_identity, @task_id, @filed_at)
     ON CONFLICT(project_id, finding_identity) DO UPDATE SET
       task_id = excluded.task_id,
       filed_at = excluded.filed_at`,
  ).run({
    project_id: projectId,
    finding_identity: findingIdentity,
    task_id: taskId,
    filed_at: filedAt,
  });
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
      (id, project, milestone, ts, tasks_open, tasks_closed, gate_open, gate_closed, gate_parked,
       seed_open, seed_closed, ops_open, ops_closed, total_scope, distance_to_green, status)
    VALUES
      (@id, @project, @milestone, @ts, @tasks_open, @tasks_closed, @gate_open, @gate_closed, @gate_parked,
       @seed_open, @seed_closed, @ops_open, @ops_closed, @total_scope, @distance_to_green, @status)
  `);
  _stmtInsertConvergenceSnapshot.run({
    id: randomUUID(),
    ...row,
    gate_parked: row.gate_parked ?? 0,
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
  /** Only rows with ts <= this ISO-8601 timestamp. */
  untilTs?: string;
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
  if (!window?.limit && !window?.sinceTs && !window?.untilTs) {
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
  if (window.untilTs) {
    conditions.push('ts <= @untilTs');
    params.untilTs = window.untilTs;
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

let _stmtSchedulerAuditStats: Database.Statement | null = null;

export function getSchedulerAuditStats(): SchedulerAuditStats[] {
  _stmtSchedulerAuditStats ??= db.prepare(`
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
  const rows = _stmtSchedulerAuditStats.all() as Array<{
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

/**
 * ops_journal.task_id is stored bare (no `source:` prefix — see reconcileJournal),
 * but callers may hold either form (e.g. OrphanedTaskSweeper holds the
 * `notion:`-prefixed dispatch id). Strip the prefix via toExternalId so both
 * forms resolve to the same row; a bare id (no colon) passes through
 * unchanged since toExternalId/parseTaskId only understands prefixed ids.
 */
function toBareOpsJournalTaskId(taskId: string): string {
  try {
    return toExternalId(taskId);
  } catch {
    return taskId;
  }
}

export function getOpsJournalEntry(taskId: string): OpsJournalRow | undefined {
  _stmtGetOpsJournalEntry ??= db.prepare<{ task_id: string }>(
    `SELECT * FROM ops_journal WHERE task_id = @task_id`,
  );
  return _stmtGetOpsJournalEntry.get({
    task_id: toBareOpsJournalTaskId(taskId),
  }) as OpsJournalRow | undefined;
}

/**
 * ops_journal_state_changed/entry_seeded/entry_dropped are recorded with
 * whatever task_id string the caller of setEntryState/reconcileJournal
 * happened to hold (see opsJournal.ts) — not necessarily the bare form
 * ops_journal.task_id normalizes to. Match against both so a caller who
 * only has the bare or the notion:-prefixed form still finds its history.
 */
function opsJournalAuditTaskIdCandidates(taskId: string): string[] {
  const bare = toBareOpsJournalTaskId(taskId);
  return bare === taskId ? [taskId] : [taskId, bare];
}

function queryOpsJournalAuditEvents(
  eventType: string,
  taskId: string,
): { ts: number; payload: Record<string, unknown> }[] {
  const candidates = opsJournalAuditTaskIdCandidates(taskId);
  const placeholders = candidates.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT ts, payload FROM audit_log WHERE event_type = ? AND task_id IN (${placeholders}) ORDER BY id ASC`,
    )
    .all(eventType, ...candidates) as { ts: number; payload: string }[];
  return rows.map((r) => ({ ts: r.ts, payload: JSON.parse(r.payload) }));
}

const OPS_JOURNAL_UNRECONSTRUCTABLE_REASON =
  'ops_journal fields other than state (disposition/evidence/finding_or_proposal/falsification/filed_followons/needs_from_operator/resolution/worked_in) have no per-field historical record — only state transitions are audited';

export interface OpsJournalAsOf {
  task_id: string;
  project: string;
  milestone: string;
  state: OpsJournalState;
  disposition: Unreconstructable;
  worked_in: Unreconstructable;
  evidence: Unreconstructable;
  finding_or_proposal: Unreconstructable;
  falsification: Unreconstructable;
  filed_followons: Unreconstructable;
  needs_from_operator: Unreconstructable;
  resolution: Unreconstructable;
  updated_at: string;
}

/**
 * Point-in-time read of an ops_journal entry's `state`, reconstructed by
 * replaying `ops_journal_state_changed`/`ops_journal_entry_seeded`/
 * `ops_journal_entry_dropped` audit_log rows up to `asOf`. Every other
 * column has no per-field history and comes back as an Unreconstructable
 * marker — see module header. Returns undefined when the entry doesn't
 * exist now, wasn't seeded yet as of `asOf`, or was dropped and not
 * re-seeded by `asOf`.
 */
export function getOpsJournalEntryAsOf(
  taskId: string,
  asOf: string,
): OpsJournalAsOf | undefined {
  const current = getOpsJournalEntry(taskId);
  if (!current) return undefined;
  const asOfMs = Date.parse(asOf);

  const seedEvents = queryOpsJournalAuditEvents(
    'ops_journal_entry_seeded',
    taskId,
  );
  const dropEvents = queryOpsJournalAuditEvents(
    'ops_journal_entry_dropped',
    taskId,
  );
  const stateEvents = queryOpsJournalAuditEvents(
    'ops_journal_state_changed',
    taskId,
  ) as {
    ts: number;
    payload: { from: OpsJournalState; to: OpsJournalState };
  }[];

  const seedTs = [...seedEvents].reverse().find((e) => e.ts <= asOfMs)?.ts;
  if (seedTs === undefined) return undefined;
  const droppedAfterSeed = dropEvents.some(
    (e) => e.ts > seedTs && e.ts <= asOfMs,
  );
  if (droppedAfterSeed) return undefined;

  let state = current.state;
  for (let i = stateEvents.length - 1; i >= 0; i--) {
    if (stateEvents[i].ts > asOfMs) {
      state = stateEvents[i].payload.from;
    } else {
      break;
    }
  }

  return {
    task_id: current.task_id,
    project: current.project,
    milestone: current.milestone,
    state,
    disposition: unreconstructable(OPS_JOURNAL_UNRECONSTRUCTABLE_REASON),
    worked_in: unreconstructable(OPS_JOURNAL_UNRECONSTRUCTABLE_REASON),
    evidence: unreconstructable(OPS_JOURNAL_UNRECONSTRUCTABLE_REASON),
    finding_or_proposal: unreconstructable(
      OPS_JOURNAL_UNRECONSTRUCTABLE_REASON,
    ),
    falsification: unreconstructable(OPS_JOURNAL_UNRECONSTRUCTABLE_REASON),
    filed_followons: unreconstructable(OPS_JOURNAL_UNRECONSTRUCTABLE_REASON),
    needs_from_operator: unreconstructable(
      OPS_JOURNAL_UNRECONSTRUCTABLE_REASON,
    ),
    resolution: unreconstructable(OPS_JOURNAL_UNRECONSTRUCTABLE_REASON),
    updated_at: current.updated_at,
  };
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
  _stmtUpsertOpsJournalEntry.run({
    ...row,
    task_id: toBareOpsJournalTaskId(row.task_id),
  });
}

export function deleteOpsJournalEntry(taskId: string): void {
  _stmtDeleteOpsJournalEntry ??= db.prepare<{ task_id: string }>(
    `DELETE FROM ops_journal WHERE task_id = @task_id`,
  );
  _stmtDeleteOpsJournalEntry.run({ task_id: toBareOpsJournalTaskId(taskId) });
}

// ─── capability_disqualification ────────────────────────────────────────────
// Statements are cached lazily (prepared on first use, not at module load) so
// importing this module doesn't fail on a not-yet-migrated db handle.

let _stmtGetCapabilityDisqualification: Database.Statement | null = null;
let _stmtGetCapabilityDisqualificationByInvestigationTask: Database.Statement | null =
  null;
let _stmtUpsertCapabilityDisqualification: Database.Statement | null = null;

function capabilityDisqualificationId(
  projectId: string,
  capability: string,
): string {
  return `${projectId}::${capability}`;
}

/** The current disqualification row for one (project, capability) key, or undefined if the key was never disqualified. */
export function getCapabilityDisqualification(
  projectId: string,
  capability: string,
): CapabilityDisqualificationRow | undefined {
  _stmtGetCapabilityDisqualification ??= db.prepare<{ id: string }>(
    `SELECT * FROM capability_disqualification WHERE id = @id`,
  );
  return _stmtGetCapabilityDisqualification.get({
    id: capabilityDisqualificationId(projectId, capability),
  }) as CapabilityDisqualificationRow | undefined;
}

/** The disqualification row a resolving Investigation task's id is attached to, or undefined. */
export function getCapabilityDisqualificationByInvestigationTask(
  investigationTaskId: string,
): CapabilityDisqualificationRow | undefined {
  _stmtGetCapabilityDisqualificationByInvestigationTask ??= db.prepare<{
    investigation_task_id: string;
  }>(
    `SELECT * FROM capability_disqualification WHERE investigation_task_id = @investigation_task_id`,
  );
  return _stmtGetCapabilityDisqualificationByInvestigationTask.get({
    investigation_task_id: investigationTaskId,
  }) as CapabilityDisqualificationRow | undefined;
}

/** Insert-or-replace of one (project, capability) key's disqualification row, keyed on its deterministic id. */
export function upsertCapabilityDisqualification(
  row: NewCapabilityDisqualificationRow,
): void {
  _stmtUpsertCapabilityDisqualification ??= db.prepare(`
    INSERT INTO capability_disqualification
      (id, project_id, capability, investigation_task_id, state, created_at, resolved_at, lifted_at, updated_at)
    VALUES
      (@id, @project_id, @capability, @investigation_task_id, @state, @created_at, @resolved_at, @lifted_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      investigation_task_id = @investigation_task_id,
      state = @state,
      resolved_at = @resolved_at,
      lifted_at = @lifted_at,
      updated_at = @updated_at
  `);
  _stmtUpsertCapabilityDisqualification.run({
    id: capabilityDisqualificationId(row.project_id, row.capability),
    project_id: row.project_id,
    capability: row.capability,
    investigation_task_id: row.investigation_task_id,
    state: row.state,
    created_at: row.created_at,
    resolved_at: row.resolved_at ?? null,
    lifted_at: row.lifted_at ?? null,
    updated_at: row.updated_at,
  });
}

// ─── flaky_remediation_tracking / flaky_remediation_pr_counts ──────────────
// Statements are cached lazily (prepared on first use, not at module load) so
// importing this module doesn't fail on a not-yet-migrated db handle.

let _stmtGetFlakyRemediationTracking: Database.Statement | null = null;
let _stmtUpsertFlakyRemediationTrackingCount: Database.Statement | null = null;
let _stmtSetFlakyRemediationLinkedTask: Database.Statement | null = null;
let _stmtInsertFlakyRemediationPrCount: Database.Statement | null = null;

/** The current tracking row for one test_id, or undefined if it was never lane-auto-disposed. */
export function getFlakyRemediationTracking(
  testId: string,
): FlakyRemediationTrackingRow | undefined {
  _stmtGetFlakyRemediationTracking ??= db.prepare<{ test_id: string }>(
    `SELECT * FROM flaky_remediation_tracking WHERE test_id = @test_id`,
  );
  return _stmtGetFlakyRemediationTracking.get({ test_id: testId }) as
    | FlakyRemediationTrackingRow
    | undefined;
}

/**
 * Records one lane-side f2-only auto-disposition of `testId`, triggered by
 * (prNumber, repo). Per the locked design, the counter is keyed on distinct
 * triggering PRs, not raw actuation calls: a PR that has already contributed
 * to this test's count (a retry/force-push retriggering f2) is a no-op here
 * — flaky_remediation_pr_counts' (test_id, pr_number, repo) primary key is
 * the dedup gate. Returns the up-to-date auto_disposition_count either way,
 * and whether this call is the one that incremented it.
 */
export function recordFlakyLaneAutoDisposition(
  testId: string,
  prNumber: number,
  repo: string,
  nowIso: string,
): { countedThisPr: boolean; autoDispositionCount: number } {
  _stmtInsertFlakyRemediationPrCount ??= db.prepare<{
    test_id: string;
    pr_number: number;
    repo: string;
    counted_at: string;
  }>(`
    INSERT OR IGNORE INTO flaky_remediation_pr_counts (test_id, pr_number, repo, counted_at)
    VALUES (@test_id, @pr_number, @repo, @counted_at)
  `);
  const info = _stmtInsertFlakyRemediationPrCount.run({
    test_id: testId,
    pr_number: prNumber,
    repo,
    counted_at: nowIso,
  });
  const countedThisPr = info.changes > 0;

  if (!countedThisPr) {
    const existing = getFlakyRemediationTracking(testId);
    return {
      countedThisPr: false,
      autoDispositionCount: existing?.auto_disposition_count ?? 0,
    };
  }

  _stmtUpsertFlakyRemediationTrackingCount ??= db.prepare<{
    test_id: string;
    created_at: string;
    updated_at: string;
  }>(`
    INSERT INTO flaky_remediation_tracking
      (test_id, remediation_task_id, remediation_task_open, auto_disposition_count, created_at, updated_at)
    VALUES
      (@test_id, NULL, 0, 1, @created_at, @updated_at)
    ON CONFLICT(test_id) DO UPDATE SET
      auto_disposition_count = auto_disposition_count + 1,
      updated_at = @updated_at
  `);
  _stmtUpsertFlakyRemediationTrackingCount.run({
    test_id: testId,
    created_at: nowIso,
    updated_at: nowIso,
  });

  const row = getFlakyRemediationTracking(testId);
  return {
    countedThisPr: true,
    autoDispositionCount: row?.auto_disposition_count ?? 0,
  };
}

/**
 * Links (or unlinks) `testId`'s tracking row to a remediation task, and
 * records whether that task is currently open (non-terminal) or closed
 * (terminal). Called once at filing time (open = true) and again once the
 * linked task reaches a terminal status (open = false) — the sole signal
 * that clears the way for a fresh filing on this test_id.
 */
export function setFlakyRemediationLinkedTask(
  testId: string,
  remediationTaskId: string | null,
  open: boolean,
  nowIso: string,
): void {
  _stmtSetFlakyRemediationLinkedTask ??= db.prepare<{
    test_id: string;
    remediation_task_id: string | null;
    remediation_task_open: number;
    updated_at: string;
  }>(`
    INSERT INTO flaky_remediation_tracking
      (test_id, remediation_task_id, remediation_task_open, auto_disposition_count, created_at, updated_at)
    VALUES
      (@test_id, @remediation_task_id, @remediation_task_open, 0, @updated_at, @updated_at)
    ON CONFLICT(test_id) DO UPDATE SET
      remediation_task_id = @remediation_task_id,
      remediation_task_open = @remediation_task_open,
      updated_at = @updated_at
  `);
  _stmtSetFlakyRemediationLinkedTask.run({
    test_id: testId,
    remediation_task_id: remediationTaskId,
    remediation_task_open: open ? 1 : 0,
    updated_at: nowIso,
  });
}

let _stmtClaimFlakyRemediationFiling: Database.Statement | null = null;

/**
 * Atomically claims the right to file a remediation task for `testId`:
 * flips remediation_task_open 0 -> 1 in a single UPDATE guarded by
 * `WHERE remediation_task_open = 0`, so two concurrent threshold-crossing
 * callers (plausible since PRMergeWatcher can process more than one PR
 * concurrently) can never both observe "no open task" and both file — only
 * whichever UPDATE's WHERE clause matches first wins (better-sqlite3 is
 * synchronous, so there is no interleaving within this single statement).
 * The caller must release the claim (setFlakyRemediationLinkedTask with
 * open=false) if it fails to actually finish filing — see
 * recordAndMaybeFileFlakyRemediation. Returns false if another caller (or a
 * still-open previously filed task) already holds the claim.
 */
export function tryClaimFlakyRemediationFiling(
  testId: string,
  nowIso: string,
): boolean {
  _stmtClaimFlakyRemediationFiling ??= db.prepare<{
    test_id: string;
    updated_at: string;
  }>(`
    UPDATE flaky_remediation_tracking
    SET remediation_task_open = 1, remediation_task_id = NULL, updated_at = @updated_at
    WHERE test_id = @test_id AND remediation_task_open = 0
  `);
  const info = _stmtClaimFlakyRemediationFiling.run({
    test_id: testId,
    updated_at: nowIso,
  });
  return info.changes > 0;
}

/** The tracking row currently linked to `taskId` as its open remediation task, or undefined. */
export function getFlakyRemediationTrackingByOpenTaskId(
  taskId: string,
): FlakyRemediationTrackingRow | undefined {
  return db
    .prepare<{
      remediation_task_id: string;
    }>(
      `SELECT * FROM flaky_remediation_tracking WHERE remediation_task_id = @remediation_task_id AND remediation_task_open = 1`,
    )
    .get({ remediation_task_id: taskId }) as
    | FlakyRemediationTrackingRow
    | undefined;
}

// ─── base_health_remediation_tracking ──────────────────────────────────────
// Statements are cached lazily (prepared on first use, not at module load) so
// importing this module doesn't fail on a not-yet-migrated db handle. Mirrors
// flaky_remediation_tracking's atomic-claim/dedup shape, keyed by base
// content_hash instead of test_id — see audit/baseHealthRemediationFiling.ts.

let _stmtGetBaseHealthRemediationTracking: Database.Statement | null = null;
let _stmtEnsureBaseHealthRemediationTrackingRow: Database.Statement | null =
  null;
let _stmtClaimBaseHealthRemediationFiling: Database.Statement | null = null;
let _stmtSetBaseHealthRemediationLinkedTask: Database.Statement | null = null;

/** The current tracking row for one base content_hash, or undefined if it was never confirmed unhealthy. */
export function getBaseHealthRemediationTracking(
  contentHash: string,
): BaseHealthRemediationTrackingRow | undefined {
  _stmtGetBaseHealthRemediationTracking ??= db.prepare<{
    content_hash: string;
  }>(
    `SELECT * FROM base_health_remediation_tracking WHERE content_hash = @content_hash`,
  );
  return _stmtGetBaseHealthRemediationTracking.get({
    content_hash: contentHash,
  }) as BaseHealthRemediationTrackingRow | undefined;
}

/**
 * Atomically claims the right to file a remediation task for `contentHash`:
 * ensures a tracking row exists (INSERT OR IGNORE, starting closed), then
 * flips remediation_task_open 0 -> 1 in a single UPDATE guarded by
 * `WHERE remediation_task_open = 0` — mirrors
 * tryClaimFlakyRemediationFiling's race-closing shape exactly, so two
 * concurrent base-health confirmations for the same content hash can never
 * both file. The caller must release the claim
 * (setBaseHealthRemediationLinkedTask with open=false) if it fails to
 * actually finish filing. Returns false if another caller (or a previously
 * filed task) already holds the claim.
 */
export function tryClaimBaseHealthRemediationFiling(
  contentHash: string,
  nowIso: string,
): boolean {
  _stmtEnsureBaseHealthRemediationTrackingRow ??= db.prepare<{
    content_hash: string;
    created_at: string;
    updated_at: string;
  }>(`
    INSERT OR IGNORE INTO base_health_remediation_tracking
      (content_hash, remediation_task_id, remediation_task_open, created_at, updated_at)
    VALUES
      (@content_hash, NULL, 0, @created_at, @updated_at)
  `);
  _stmtEnsureBaseHealthRemediationTrackingRow.run({
    content_hash: contentHash,
    created_at: nowIso,
    updated_at: nowIso,
  });

  _stmtClaimBaseHealthRemediationFiling ??= db.prepare<{
    content_hash: string;
    updated_at: string;
  }>(`
    UPDATE base_health_remediation_tracking
    SET remediation_task_open = 1, updated_at = @updated_at
    WHERE content_hash = @content_hash AND remediation_task_open = 0
  `);
  const info = _stmtClaimBaseHealthRemediationFiling.run({
    content_hash: contentHash,
    updated_at: nowIso,
  });
  return info.changes > 0;
}

/**
 * Links (or unlinks) `contentHash`'s tracking row to a remediation task, and
 * records whether that task is currently open. Called once at filing time
 * (open = true), or to release a failed claim (open = false, remediation_task_id
 * null) — see recordAndMaybeFileBaseHealthRemediation.
 */
export function setBaseHealthRemediationLinkedTask(
  contentHash: string,
  remediationTaskId: string | null,
  open: boolean,
  nowIso: string,
): void {
  _stmtSetBaseHealthRemediationLinkedTask ??= db.prepare<{
    content_hash: string;
    remediation_task_id: string | null;
    remediation_task_open: number;
    updated_at: string;
  }>(`
    INSERT INTO base_health_remediation_tracking
      (content_hash, remediation_task_id, remediation_task_open, created_at, updated_at)
    VALUES
      (@content_hash, @remediation_task_id, @remediation_task_open, @updated_at, @updated_at)
    ON CONFLICT(content_hash) DO UPDATE SET
      remediation_task_id = @remediation_task_id,
      remediation_task_open = @remediation_task_open,
      updated_at = @updated_at
  `);
  _stmtSetBaseHealthRemediationLinkedTask.run({
    content_hash: contentHash,
    remediation_task_id: remediationTaskId,
    remediation_task_open: open ? 1 : 0,
    updated_at: nowIso,
  });
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

function queryGateItemAuditTransitions(
  eventType: 'gate_item_state_changed' | 'gate_item_reclassified',
  gateItemId: string,
): { ts: number; from: string; to: string }[] {
  const rows = db
    .prepare<
      { event_type: string; like: string },
      { ts: number; payload: string }
    >(`SELECT ts, payload FROM audit_log WHERE event_type = @event_type AND payload LIKE @like ORDER BY id ASC`)
    .all({ event_type: eventType, like: `%"gateItemId":"${gateItemId}"%` });
  return rows
    .map((r) => {
      const payload = JSON.parse(r.payload) as {
        gateItemId: string;
        from: string;
        to: string;
      };
      return {
        ts: r.ts,
        from: payload.from,
        to: payload.to,
        gateItemId: payload.gateItemId,
      };
    })
    .filter((r) => r.gateItemId === gateItemId);
}

const GATE_ITEM_UNRECONSTRUCTABLE_REASON =
  'gate_item.min_deployed_commit/next_attempt_at/pending_attempt_count have no historical record until the point-in-time instrumentation task lands — cannot answer "what was this field at T", only "what is it now"';

export interface GateItemAsOf {
  id: string;
  project: string;
  milestone: string;
  text: string;
  classification: GateItemClassification;
  state: string;
  current_disposition: string | null;
  min_deployed_commit: Unreconstructable;
  next_attempt_at: Unreconstructable;
  pending_attempt_count: Unreconstructable;
  updated_at: string;
}

/**
 * Point-in-time read of a gate_item's `state`, `classification`, and
 * `current_disposition`, reconstructed by replaying `gate_item_created`/
 * `gate_item_state_changed`/`gate_item_reclassified` audit_log rows (and
 * gate_item_event's disposition history for current_disposition) up to
 * `asOf`. min_deployed_commit/next_attempt_at/pending_attempt_count have no
 * per-field history yet and come back as Unreconstructable markers — see
 * module header. Returns undefined both when the item doesn't exist and
 * when it wasn't created yet as of `asOf`.
 */
export function getGateItemAsOf(
  id: string,
  asOf: string,
): GateItemAsOf | undefined {
  const current = getGateItem(id);
  if (!current) return undefined;
  const asOfMs = Date.parse(asOf);

  const createdRow = db
    .prepare<
      { like: string },
      { ts: number }
    >(`SELECT ts FROM audit_log WHERE event_type = 'gate_item_created' AND payload LIKE @like ORDER BY id ASC LIMIT 1`)
    .get({ like: `%"gateItemId":"${id}"%` });
  if (createdRow && createdRow.ts > asOfMs) return undefined;

  const stateEvents = queryGateItemAuditTransitions(
    'gate_item_state_changed',
    id,
  );
  const reclassifyEvents = queryGateItemAuditTransitions(
    'gate_item_reclassified',
    id,
  );

  let state = current.state;
  for (let i = stateEvents.length - 1; i >= 0; i--) {
    if (stateEvents[i].ts > asOfMs) {
      state = stateEvents[i].from;
    } else {
      break;
    }
  }

  let classification = current.classification;
  for (let i = reclassifyEvents.length - 1; i >= 0; i--) {
    if (reclassifyEvents[i].ts > asOfMs) {
      classification = reclassifyEvents[i].from as GateItemClassification;
    } else {
      break;
    }
  }

  // current_disposition changes exactly when a state transition is recorded
  // (gateStore.advanceState writes both together) — find the latest such
  // transition at/before asOf, then the gate_item_event whose `at` produced
  // it (the last event inserted at/before that transition's audit ts; the
  // insert always precedes the audit write within the same synchronous call).
  let lastStateChangeTs: number | undefined;
  for (const se of stateEvents) {
    if (se.ts > asOfMs) break;
    lastStateChangeTs = se.ts;
  }
  let currentDisposition: string | null = null;
  if (lastStateChangeTs !== undefined) {
    for (const ev of listGateItemEvents(id)) {
      if (Date.parse(ev.at) <= lastStateChangeTs) {
        currentDisposition = ev.disposition;
      } else {
        break;
      }
    }
  }

  return {
    id: current.id,
    project: current.project,
    milestone: current.milestone,
    text: current.text,
    classification,
    state,
    current_disposition: currentDisposition,
    min_deployed_commit: unreconstructable(GATE_ITEM_UNRECONSTRUCTABLE_REASON),
    next_attempt_at: unreconstructable(GATE_ITEM_UNRECONSTRUCTABLE_REASON),
    pending_attempt_count: unreconstructable(
      GATE_ITEM_UNRECONSTRUCTABLE_REASON,
    ),
    updated_at: current.updated_at,
  };
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
       state, current_disposition, latest_disposition, next_attempt_at,
       pending_attempt_count, updated_at)
    VALUES
      (@id, @project, @milestone, @text, @classification, @min_deployed_commit,
       @state, @current_disposition, @latest_disposition, @next_attempt_at,
       @pending_attempt_count, @updated_at)
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
      latest_disposition = @latest_disposition,
      next_attempt_at = @next_attempt_at,
      pending_attempt_count = @pending_attempt_count,
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
      (gate_item_id, disposition, evidence, filed_followon, deploy_sha, operator, unattended, min_deployed_commit_at_fail, at)
    VALUES
      (@gate_item_id, @disposition, @evidence, @filed_followon, @deploy_sha, @operator, @unattended, @min_deployed_commit_at_fail, @at)
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
  const before = getGateItem(id);
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
  if (before && before.min_deployed_commit !== minDeployedCommit) {
    recordEvent({
      event_type: 'gate_item_min_deployed_commit_changed',
      actor_type: 'system',
      payload: {
        gate_item_id: id,
        from: before.min_deployed_commit,
        to: minDeployedCommit,
      },
    });
  }
}

let _stmtUpdateGateItemPendingSchedule: Database.Statement | null = null;

/**
 * Writes the `pending` backoff schedule columns directly — used by
 * gateStore.schedulePendingAttempt after a not-yet-triggerable disposition,
 * separately from the (state, current_disposition) write in advanceState.
 */
export function updateGateItemPendingSchedule(
  id: string,
  nextAttemptAt: string,
  pendingAttemptCount: number,
  updatedAt: string,
): void {
  const before = getGateItem(id);
  _stmtUpdateGateItemPendingSchedule ??= db.prepare<{
    id: string;
    next_attempt_at: string;
    pending_attempt_count: number;
    updated_at: string;
  }>(
    `UPDATE gate_item SET next_attempt_at = @next_attempt_at, pending_attempt_count = @pending_attempt_count, updated_at = @updated_at WHERE id = @id`,
  );
  _stmtUpdateGateItemPendingSchedule.run({
    id,
    next_attempt_at: nextAttemptAt,
    pending_attempt_count: pendingAttemptCount,
    updated_at: updatedAt,
  });
  if (
    before &&
    (before.next_attempt_at !== nextAttemptAt ||
      before.pending_attempt_count !== pendingAttemptCount)
  ) {
    recordEvent({
      event_type: 'gate_item_schedule_changed',
      actor_type: 'system',
      payload: {
        gate_item_id: id,
        from_next_attempt_at: before.next_attempt_at,
        to_next_attempt_at: nextAttemptAt,
        from_pending_attempt_count: before.pending_attempt_count,
        to_pending_attempt_count: pendingAttemptCount,
      },
    });
  }
}

let _stmtTouchGateItemUpdatedAt: Database.Statement | null = null;
let _stmtTouchGateItemUpdatedAtWithDisposition: Database.Statement | null =
  null;

/**
 * Stamps updated_at, and — when `latestDisposition` is supplied — also
 * writes it to the latest_disposition column, without ever touching
 * state/current_disposition. Used both for a dispositionless log entry
 * (updated_at only) and a non-resolving event like needs-setup/noted, which
 * must surface on the item's latest-disposition column despite not
 * advancing state.
 */
export function touchGateItemUpdatedAt(
  id: string,
  updatedAt: string,
  latestDisposition?: string,
): void {
  if (latestDisposition !== undefined) {
    _stmtTouchGateItemUpdatedAtWithDisposition ??= db.prepare<{
      id: string;
      updated_at: string;
      latest_disposition: string;
    }>(
      `UPDATE gate_item SET updated_at = @updated_at, latest_disposition = @latest_disposition WHERE id = @id`,
    );
    _stmtTouchGateItemUpdatedAtWithDisposition.run({
      id,
      updated_at: updatedAt,
      latest_disposition: latestDisposition,
    });
    return;
  }
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
  /** True: only items whose latest event is a needs-setup abstain — "attempted, inconclusive". */
  awaitingSetup?: boolean;
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
  if (filter.awaitingSetup !== undefined) {
    conditions.push(
      filter.awaitingSetup
        ? "latest_disposition = 'needs-setup'"
        : "(latest_disposition IS NULL OR latest_disposition != 'needs-setup')",
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
  classification?: string;
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
  if (filter.classification) {
    conditions.push('classification = @classification');
    params.classification = filter.classification;
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
      (id, project, milestone, spec, classification, min_deployed_commit, state, updated_at)
    VALUES
      (@id, @project, @milestone, @spec, @classification, @min_deployed_commit, @state, @updated_at)
  `);
  _stmtInsertSeedItem.run(row);
}

export function updateSeedItem(row: SeedItemRow): void {
  _stmtUpdateSeedItem ??= db.prepare<SeedItemRow>(`
    UPDATE seed_item SET
      project = @project,
      milestone = @milestone,
      spec = @spec,
      classification = @classification,
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

// ─── test_request_runs ──────────────────────────────────────────────────────

export function insertTestRequestRun(
  id: string,
  projectId: string,
  contentHash: string,
  sessionId: string | null,
  requestedAt: number,
  concurrentRunCount?: number | null,
): void {
  db.prepare(
    `INSERT INTO test_request_runs (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at, failure_reason, concurrent_run_count)
     VALUES (?, ?, ?, ?, 'running', '', ?, ?, NULL, NULL, ?)`,
  ).run(
    id,
    projectId,
    contentHash,
    sessionId,
    requestedAt,
    Date.now(),
    concurrentRunCount ?? null,
  );
}

export function completeTestRequestRun(
  id: string,
  state: TestRequestRunState,
  output: string,
  failureReason: TestRequestFailureReason | null = null,
  structuredResult?: string | null,
  oomKilled?: boolean,
  acquisitionAttempted?: boolean,
): void {
  db.prepare(
    `UPDATE test_request_runs SET state = ?, output = ?, finished_at = ?, failure_reason = ?, structured_result = ?, oom_killed = ?, test_report_acquisition_attempted = ? WHERE id = ?`,
  ).run(
    state,
    output,
    Date.now(),
    failureReason,
    structuredResult ?? null,
    oomKilled ? 1 : 0,
    acquisitionAttempted === undefined ? null : acquisitionAttempted ? 1 : 0,
    id,
  );
}

const TEST_REQUEST_RUN_COLUMNS = `id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at, failure_reason, structured_result, concurrent_run_count, oom_killed, test_report_acquisition_attempted`;

/** Every run still `running` — used by the boot-time crash-recovery sweep. */
export function listRunningTestRequestRuns(): TestRequestRunRow[] {
  return db
    .prepare(
      `SELECT ${TEST_REQUEST_RUN_COLUMNS}
       FROM test_request_runs WHERE state = 'running'`,
    )
    .all() as TestRequestRunRow[];
}

/**
 * Every non-running run with a structured_result but no extracted
 * test_run_results rows yet — the boot-time re-derivation sweep's work list
 * (see ingestTestRunResults in testRequestLane.ts). Catches both a crash
 * mid-ingestion and structured_result having been populated by a process
 * that predates this extraction step.
 */
export function listTestRequestRunsNeedingExtraction(): TestRequestRunRow[] {
  return db
    .prepare(
      `SELECT ${TEST_REQUEST_RUN_COLUMNS}
       FROM test_request_runs
       WHERE structured_result IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM test_run_results
           WHERE test_run_results.test_request_run_id = test_request_runs.id
         )`,
    )
    .all() as TestRequestRunRow[];
}

/**
 * F2's (the orchestrator-run test gate) shared-cache read: the most
 * recently finished (non-`running`) run for (project_id, content_hash). A
 * hit means an identical whole-tree content hash already ran under this
 * project's test commands — F2 downgrades to cache-hit-only and skips
 * re-execution; a miss falls through to a real run via runProjectTestRequest,
 * which durably records into this same table.
 */
export function getLatestTestRequestRun(
  projectId: string,
  contentHash: string,
): TestRequestRunRow | undefined {
  return db
    .prepare<{ project_id: string; content_hash: string }>(
      `SELECT ${TEST_REQUEST_RUN_COLUMNS}
       FROM test_request_runs
       WHERE project_id = @project_id AND content_hash = @content_hash AND state != 'running'
       ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    )
    .get({ project_id: projectId, content_hash: contentHash }) as
    | TestRequestRunRow
    | undefined;
}

/**
 * Single run by id — used to fetch a just-completed run's structured_result
 * for delivery digest rendering (see testResultDigest.ts) once
 * runProjectTestRequest resolves with only the run's id in hand.
 */
export function getTestRequestRunById(
  id: string,
): TestRequestRunRow | undefined {
  return db
    .prepare(
      `SELECT ${TEST_REQUEST_RUN_COLUMNS} FROM test_request_runs WHERE id = ?`,
    )
    .get(id) as TestRequestRunRow | undefined;
}

/**
 * The most recent run (project_id, session_id) originated — session-keyed
 * counterpart to getLatestTestRequestRun's content-hash keying, for a
 * frontend consumer (useTestLaneRunStatus) that knows its own session id but
 * has no client-side visibility into the server-computed whole-tree content
 * hash. Prefers a currently-`running` row over the latest finished one, same
 * precedence as the GET /test-request-runs route applies for the
 * content-hash lens.
 */
export function getLatestTestRequestRunForSession(
  projectId: string,
  sessionId: string,
): TestRequestRunRow | undefined {
  const running = db
    .prepare<{ project_id: string; session_id: string }>(
      `SELECT id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at, failure_reason, structured_result
       FROM test_request_runs
       WHERE project_id = @project_id AND session_id = @session_id AND state = 'running'
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get({ project_id: projectId, session_id: sessionId }) as
    | TestRequestRunRow
    | undefined;
  if (running) return running;
  return db
    .prepare<{ project_id: string; session_id: string }>(
      `SELECT id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at, failure_reason, structured_result
       FROM test_request_runs
       WHERE project_id = @project_id AND session_id = @session_id AND state != 'running'
       ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    )
    .get({ project_id: projectId, session_id: sessionId }) as
    | TestRequestRunRow
    | undefined;
}

/**
 * Full run history for one (project_id, session_id) — the Tests tab's
 * run-history table. Newest first; `limit` bounds the page size since a
 * long-lived session can accumulate many test.request cycles.
 */
export function listTestRequestRunsForSession(
  projectId: string,
  sessionId: string,
  limit = 50,
): TestRequestRunRow[] {
  return db
    .prepare<{ project_id: string; session_id: string; limit: number }>(
      `SELECT ${TEST_REQUEST_RUN_COLUMNS}
       FROM test_request_runs
       WHERE project_id = @project_id AND session_id = @session_id
       ORDER BY started_at DESC, rowid DESC LIMIT @limit`,
    )
    .all({
      project_id: projectId,
      session_id: sessionId,
      limit,
    }) as TestRequestRunRow[];
}

/**
 * computeTestFlipRateFlag scoped to a caller-supplied set of test ids — the
 * Tests tab's per-test flip-rate annotation, restricted to test ids seen in
 * a task's own runs rather than every test in the project (listFlaggedFlakyTests'
 * scope). Reuses the same live-recompute engine and the same default
 * window/threshold settings as the lane's own auto-disposition check; no new
 * comparison logic.
 */
/**
 * Bounds how many unique test ids getTaskTestFlipRateFlags will run
 * computeTestFlipRateFlag against for a single call — a task's own runs can
 * still surface thousands of unique test ids even after
 * TEST_RUN_RESULTS_PER_RUN_CAP bounds each individual run's row count (up to
 * 50 runs × the per-run cap), and each lookup is a synchronous prepared-
 * statement execution. The cap trades completeness of the flip-rate
 * annotation for a bounded amount of synchronous DB work per request.
 */
export const FLIP_RATE_FLAG_TEST_ID_CAP = 200;

export function getTaskTestFlipRateFlags(
  testIds: string[],
  windowN: number,
  thresholdK: number,
): TestFlipRateFlag[] {
  const uniqueIds = [...new Set(testIds)].slice(0, FLIP_RATE_FLAG_TEST_ID_CAP);
  return uniqueIds.map((testId) =>
    computeTestFlipRateFlag(testId, windowN, thresholdK),
  );
}

/**
 * Invalidate every recorded run for (project_id, content_hash) — F2's
 * flaky.confirm actuation path. Callers must audit this via recordEvent —
 * deletion alone is silent. The subsequent rerun (via runProjectTestRequest)
 * repopulates the cache with a fresh row.
 */
export function deleteTestRequestRunsForContentHash(
  projectId: string,
  contentHash: string,
): void {
  db.prepare<{ project_id: string; content_hash: string }>(
    `DELETE FROM test_request_runs WHERE project_id = @project_id AND content_hash = @content_hash`,
  ).run({ project_id: projectId, content_hash: contentHash });
}

// ─── dependency_cache_entries ───────────────────────────────────────────────

/** Upserts a (project_id, lock_hash) row into `building` — the leader's durable claim before it runs the project's bootstrap_script. */
export function insertBuildingDependencyCacheEntry(
  projectId: string,
  lockHash: string,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO dependency_cache_entries (project_id, lock_hash, status, created_at, last_used_at)
     VALUES (?, ?, 'building', ?, ?)
     ON CONFLICT(project_id, lock_hash) DO UPDATE SET status = 'building', last_used_at = excluded.last_used_at`,
  ).run(projectId, lockHash, now, now);
}

export function markDependencyCacheEntryStatus(
  projectId: string,
  lockHash: string,
  status: DependencyCacheEntryStatus,
): void {
  db.prepare(
    `UPDATE dependency_cache_entries SET status = ? WHERE project_id = ? AND lock_hash = ?`,
  ).run(status, projectId, lockHash);
}

/** Only a `ready` row is a valid cache hit — see DependencyCacheEntryRow doc comment. */
export function getReadyDependencyCacheEntry(
  projectId: string,
  lockHash: string,
): DependencyCacheEntryRow | undefined {
  return db
    .prepare(
      `SELECT * FROM dependency_cache_entries WHERE project_id = ? AND lock_hash = ? AND status = 'ready'`,
    )
    .get(projectId, lockHash) as DependencyCacheEntryRow | undefined;
}

export function touchDependencyCacheEntryLastUsed(
  projectId: string,
  lockHash: string,
): void {
  db.prepare(
    `UPDATE dependency_cache_entries SET last_used_at = ? WHERE project_id = ? AND lock_hash = ?`,
  ).run(Date.now(), projectId, lockHash);
}

/** Rows still `building` — used by the boot-time crash-recovery sweep. */
export function listBuildingDependencyCacheEntries(): DependencyCacheEntryRow[] {
  return db
    .prepare(`SELECT * FROM dependency_cache_entries WHERE status = 'building'`)
    .all() as DependencyCacheEntryRow[];
}

/** `ready` rows oldest-used first — used by DependencyCacheReconciler's eviction sweep. */
export function listReadyDependencyCacheEntries(): DependencyCacheEntryRow[] {
  return db
    .prepare(
      `SELECT * FROM dependency_cache_entries WHERE status = 'ready' ORDER BY last_used_at ASC`,
    )
    .all() as DependencyCacheEntryRow[];
}

/**
 * Atomically claims a `ready` row for eviction: deletes it only if
 * `last_used_at` still matches `expectedLastUsedAt`, i.e. nothing has
 * touched (materialized from) it since the reconciler last read it. Returns
 * false if the row was touched or already gone, meaning the caller must NOT
 * delete the on-disk entry — DependencyCacheReconciler relies on this to
 * close the race between its sweep snapshot and the actual eviction.
 */
export function claimDependencyCacheEntryForEviction(
  projectId: string,
  lockHash: string,
  expectedLastUsedAt: number,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM dependency_cache_entries
       WHERE project_id = ? AND lock_hash = ? AND status = 'ready' AND last_used_at = ?`,
    )
    .run(projectId, lockHash, expectedLastUsedAt);
  return result.changes > 0;
}

// ─── test_run_results ───────────────────────────────────────────────────────

/** True if any row has already been extracted for this run — the idempotency check. */
export function hasTestRunResults(testRequestRunId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM test_run_results WHERE test_request_run_id = ? LIMIT 1`,
    )
    .get(testRequestRunId);
  return row !== undefined;
}

let _stmtInsertTestRunResult: Database.Statement | null = null;

/**
 * Inserts every extracted test row for a run in a single transaction, so a
 * crash mid-ingestion never leaves a partial set for `hasTestRunResults` to
 * mistake for "done". No-op on an empty `tests` list.
 */
export function insertTestRunResults(
  testRequestRunId: string,
  tests: NewTestRunResultRow[],
  concurrentRunCount: number | null,
  oomKilled: boolean,
): void {
  if (tests.length === 0) return;
  _stmtInsertTestRunResult ??= db.prepare<{
    test_request_run_id: string;
    test_id: string;
    name: string;
    outcome: string;
    duration_ms: number;
    concurrent_run_count: number | null;
    oom_killed: number;
    created_at: number;
  }>(`
    INSERT INTO test_run_results
      (test_request_run_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
    VALUES
      (@test_request_run_id, @test_id, @name, @outcome, @duration_ms, @concurrent_run_count, @oom_killed, @created_at)
  `);
  const stmt = _stmtInsertTestRunResult;
  const insertAll = db.transaction((items: NewTestRunResultRow[]) => {
    const now = Date.now();
    for (const item of items) {
      stmt.run({
        test_request_run_id: testRequestRunId,
        test_id: item.test_id,
        name: item.name,
        outcome: item.outcome,
        duration_ms: item.duration_ms,
        concurrent_run_count: concurrentRunCount,
        oom_killed: oomKilled ? 1 : 0,
        created_at: now,
      });
    }
  });
  insertAll(tests);
}

/**
 * Per-run cap for listTestRunResultsForRun — a single completed run can
 * insert on the order of 9,500 rows (this project's own live database, per
 * commit d30cdce7's measurement), and the Tests tab history endpoint fetches
 * this for up to 50 runs at once. Without a cap that's several hundred
 * thousand row objects built and JSON-serialized in one synchronous
 * event-loop tick. Preserves insertion order (existing callers, e.g.
 * ingestTestRunResults's own extraction test, depend on that ordering) —
 * callers needing failures surfaced first over a truncated page should
 * filter/sort client-side or via countTestRunResultsForRun.
 */
export const TEST_RUN_RESULTS_PER_RUN_CAP = 500;

export function listTestRunResultsForRun(
  testRequestRunId: string,
  limit: number = TEST_RUN_RESULTS_PER_RUN_CAP,
): TestRunResultRow[] {
  return db
    .prepare(
      `SELECT id, test_request_run_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at
       FROM test_run_results
       WHERE test_request_run_id = ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(testRequestRunId, limit) as TestRunResultRow[];
}

/** Total test_run_results row count for one run — used to detect truncation against TEST_RUN_RESULTS_PER_RUN_CAP without pulling every row. */
export function countTestRunResultsForRun(testRequestRunId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM test_run_results WHERE test_request_run_id = ?`,
    )
    .get(testRequestRunId) as { count: number };
  return row.count;
}

/**
 * Deletes raw test_run_results rows older than `retentionMs`, keyed off
 * created_at (the extraction timestamp, not the underlying test run time).
 * The per-test aggregate in test_perf_baselines is a separately-maintained
 * table (recomputed, not derived from a join over test_run_results at read
 * time) so it is untouched by this delete regardless of window.
 *
 * Safe against in-flight reads (ingestTestRunResults's insert transaction,
 * listRecentValidTestDurations's baseline read) because better-sqlite3 runs
 * every statement synchronously on a single connection — there is no
 * interleaving of a DELETE with a read or write already in progress. The
 * cutoff itself only ever touches rows well outside any read's window: reads
 * pull the newest few dozen samples, and the window here is 30 days.
 */
export function pruneTestRunResults(retentionMs: number): number {
  const cutoff = Date.now() - retentionMs;
  const result = db
    .prepare(`DELETE FROM test_run_results WHERE created_at < ?`)
    .run(cutoff);
  return result.changes;
}

// ─── test_perf_baselines ────────────────────────────────────────────────────

/**
 * Most recent `limit` *valid* (concurrent_run_count = 0 AND oom_killed = 0)
 * durations for a test_id, newest first — the sample pool
 * computeTestPerfBaseline draws its baseline window and recent-run guard
 * from. Excluded samples are never deleted from test_run_results, just
 * skipped here.
 */
export function listRecentValidTestDurations(
  testId: string,
  limit: number,
): number[] {
  const rows = db
    .prepare(
      `SELECT duration_ms FROM test_run_results
       WHERE test_id = ? AND concurrent_run_count = 0 AND oom_killed = 0
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(testId, limit) as { duration_ms: number }[];
  return rows.map((r) => r.duration_ms);
}

let _stmtUpsertTestPerfBaseline: Database.Statement | null = null;

/** Recomputes (not appends) the single current baseline row for a test_id. */
export function upsertTestPerfBaseline(row: NewTestPerfBaselineRow): void {
  _stmtUpsertTestPerfBaseline ??= db.prepare<{
    test_id: string;
    median_duration_ms: number;
    mad_duration_ms: number;
    sample_count: number;
    last_duration_ms: number;
    is_regressed: number;
    updated_at: number;
  }>(`
    INSERT INTO test_perf_baselines
      (test_id, median_duration_ms, mad_duration_ms, sample_count, last_duration_ms, is_regressed, updated_at)
    VALUES
      (@test_id, @median_duration_ms, @mad_duration_ms, @sample_count, @last_duration_ms, @is_regressed, @updated_at)
    ON CONFLICT(test_id) DO UPDATE SET
      median_duration_ms = excluded.median_duration_ms,
      mad_duration_ms = excluded.mad_duration_ms,
      sample_count = excluded.sample_count,
      last_duration_ms = excluded.last_duration_ms,
      is_regressed = excluded.is_regressed,
      updated_at = excluded.updated_at
  `);
  _stmtUpsertTestPerfBaseline.run({
    test_id: row.test_id,
    median_duration_ms: row.median_duration_ms,
    mad_duration_ms: row.mad_duration_ms,
    sample_count: row.sample_count,
    last_duration_ms: row.last_duration_ms,
    is_regressed: row.is_regressed ? 1 : 0,
    updated_at: Date.now(),
  });
}

export function getTestPerfBaseline(
  testId: string,
): TestPerfBaselineRow | undefined {
  return db
    .prepare(`SELECT * FROM test_perf_baselines WHERE test_id = ?`)
    .get(testId) as TestPerfBaselineRow | undefined;
}

export interface TestFlipRateFlag {
  testId: string;
  sampleCount: number;
  transitionCount: number;
  flagged: boolean;
}

let _stmtTestFlipRateSamples: Database.Statement | null = null;

/**
 * Live pass<->fail flip-rate flag for one test id, recomputed from its last
 * `windowN` valid samples (concurrent_run_count = 0 and oom_killed = false —
 * a row failing either check never occupies a window slot, so it can't be a
 * pass, a fail, or a transition). Flagged once transitionCount >= thresholdK.
 * Nothing is persisted here — every call reflects the current window, so the
 * flag clears on its own the moment a fresh ingestion's recomputation drops
 * the transition count back below K; there is no sticky marker to reset.
 */
export function computeTestFlipRateFlag(
  testId: string,
  windowN: number,
  thresholdK: number,
  // Excludes samples at/after this timestamp — the lane-side flaky
  // auto-disposition's "predates this PR's first run" masking guard
  // (see PRMergeWatcher.tryF2LaneAutoDisposition). Defaults to "no cutoff"
  // for every other caller (listFlaggedFlakyTests, the lane-health rollup).
  beforeMs: number = Number.MAX_SAFE_INTEGER,
): TestFlipRateFlag {
  _stmtTestFlipRateSamples ??= db.prepare<{
    test_id: string;
    limit: number;
    before: number;
  }>(`
    SELECT outcome FROM (
      SELECT outcome, created_at, id
      FROM test_run_results
      WHERE test_id = @test_id
        AND concurrent_run_count = 0
        AND oom_killed = 0
        AND outcome IN ('passed', 'failed')
        AND created_at < @before
      ORDER BY created_at DESC, id DESC
      LIMIT @limit
    )
    ORDER BY created_at ASC, id ASC
  `);
  const rows = _stmtTestFlipRateSamples.all({
    test_id: testId,
    limit: windowN,
    before: beforeMs,
  }) as { outcome: string }[];

  let transitionCount = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].outcome !== rows[i - 1].outcome) transitionCount++;
  }

  return {
    testId,
    sampleCount: rows.length,
    transitionCount,
    flagged: transitionCount >= thresholdK,
  };
}

let _stmtFailingTestIdsForRun: Database.Statement | null = null;

/**
 * The failed/errored test_run_results rows for one test_request_run — the
 * per-test failure set the lane-side f2 auto-disposition check evaluates
 * against computeTestFlipRateFlag and the touched-file masking guard (see
 * PRMergeWatcher.tryF2LaneAutoDisposition / testRequestLane.ts's
 * evaluateF2LaneFlakyDisposition). Empty when the run has no per-test
 * detail (structured_result never ingested) — the caller treats that as
 * not-eligible, never as "no failures".
 */
export function getFailingTestIdsForRun(
  testRequestRunId: string,
): { test_id: string; name: string }[] {
  _stmtFailingTestIdsForRun ??= db.prepare<{ run_id: string }>(`
    SELECT test_id, name FROM test_run_results
    WHERE test_request_run_id = @run_id
      AND outcome IN ('failed', 'error')
  `);
  return _stmtFailingTestIdsForRun.all({
    run_id: testRequestRunId,
  }) as { test_id: string; name: string }[];
}

interface FlaggedFlakyTest {
  testId: string;
  name: string;
  sampleCount: number;
  transitionCount: number;
}

let _stmtDistinctProjectTestIds: Database.Statement | null = null;

/**
 * Every test under `projectId` currently flagged by computeTestFlipRateFlag —
 * the lane-health rollup's flaky-test tier, sourced the same way as the
 * regressed-test tier (per test_id, recomputed live, nothing persisted).
 * test_run_results carries no project_id column, so scoping joins through
 * test_request_runs.
 */
function listFlaggedFlakyTests(
  projectId: string,
  windowN: number,
  thresholdK: number,
): FlaggedFlakyTest[] {
  // GROUP BY test_id (not DISTINCT test_id, name) — a test's recorded name
  // can vary across runs, and DISTINCT on both columns would fan out into
  // duplicate testId rows. MAX(created_at) picks the most recent run's name
  // per test_id, mirroring getRegressedTestsForProject's same bare-column-
  // with-MAX() convention.
  _stmtDistinctProjectTestIds ??= db.prepare<{ project_id: string }>(`
    SELECT trr.test_id AS test_id, trr.name AS name, MAX(trr.created_at) AS created_at
    FROM test_run_results trr
    JOIN test_request_runs r ON r.id = trr.test_request_run_id
    WHERE r.project_id = @project_id
    GROUP BY trr.test_id
  `);
  const rows = _stmtDistinctProjectTestIds.all({
    project_id: projectId,
  }) as { test_id: string; name: string }[];

  const flagged: FlaggedFlakyTest[] = [];
  for (const row of rows) {
    const flag = computeTestFlipRateFlag(row.test_id, windowN, thresholdK);
    if (flag.flagged) {
      flagged.push({
        testId: row.test_id,
        name: row.name,
        sampleCount: flag.sampleCount,
        transitionCount: flag.transitionCount,
      });
    }
  }
  return flagged;
}

// ─── session_test_request_cycles ───────────────────────────────────────────

export function getSessionTestRequestCycleCount(sessionId: string): number {
  const row = db
    .prepare(
      `SELECT count FROM session_test_request_cycles WHERE session_id = ?`,
    )
    .get(sessionId) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** Increment the per-session test.request cycle counter and return the new count. */
export function incrementSessionTestRequestCycleCount(
  sessionId: string,
): number {
  const now = Date.now();
  db.prepare(
    `INSERT INTO session_test_request_cycles (session_id, count, updated_at)
     VALUES (?, 1, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       count = count + 1,
       updated_at = excluded.updated_at`,
  ).run(sessionId, now);
  return getSessionTestRequestCycleCount(sessionId);
}

/**
 * Undoes one prior increment — used when a test.request cycle's only
 * failure(s) turned out to be confirmed base-attributable via a
 * whole-process-crash base break (baseAttributableFilter's `inconclusive`
 * outcome), so that run doesn't count against test_request_cycle_limit.
 * Floors at 0 rather than going negative.
 */
export function decrementSessionTestRequestCycleCount(
  sessionId: string,
): number {
  const now = Date.now();
  db.prepare(
    `UPDATE session_test_request_cycles
     SET count = MAX(0, count - 1), updated_at = ?
     WHERE session_id = ?`,
  ).run(now, sessionId);
  return getSessionTestRequestCycleCount(sessionId);
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
let _stmtHasPendingDecisionForTask: Database.Statement | null = null;
let _stmtHasDecisionPickOneForTask: Database.Statement | null = null;

export function insertStagedIntent(row: StagedIntentRow): void {
  _stmtInsertStagedIntent ??= db.prepare<StagedIntentRow>(`
    INSERT INTO staged_intent
      (id, kind, payload, payload_hash, task_id, project_id, session_id,
       group_id, milestone, state, supersedes, annotation, decision_proposal, investigation, groom_proposal,
       advisory, disposition_reason, answer, applied_task_id, created_at, updated_at)
    VALUES
      (@id, @kind, @payload, @payload_hash, @task_id, @project_id, @session_id,
       @group_id, @milestone, @state, @supersedes, @annotation, @decision_proposal, @investigation, @groom_proposal,
       @advisory, @disposition_reason, @answer, @applied_task_id, @created_at, @updated_at)
  `);
  // `row.investigation`/`row.applied_task_id` default to null for callers
  // built before these columns existed (test fixtures, older call sites) —
  // better-sqlite3's named-param binding otherwise throws on a key absent
  // from the object.
  _stmtInsertStagedIntent.run({
    ...row,
    investigation: row.investigation ?? null,
    applied_task_id: row.applied_task_id ?? null,
  });
}

let _stmtSetStagedIntentAppliedTaskId: Database.Statement | null = null;

/**
 * Durably records that this intent's apply already produced `resultId` — a
 * plain UPDATE, unrestricted by STAGED_INTENT_TRANSITIONS, so it always
 * succeeds even if the row's own state transition (staged/approved ->
 * committed) is about to lose a race against a concurrent supersede. See
 * StagedIntentRow.applied_task_id's doc comment.
 */
export function setStagedIntentAppliedTaskId(
  id: string,
  resultId: string,
): void {
  _stmtSetStagedIntentAppliedTaskId ??= db.prepare<{
    id: string;
    applied_task_id: string;
  }>(
    `UPDATE staged_intent SET applied_task_id = @applied_task_id WHERE id = @id`,
  );
  _stmtSetStagedIntentAppliedTaskId.run({ id, applied_task_id: resultId });
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

let _stmtHasUndispositionedStagedIntentsForSession: Database.Statement | null =
  null;

/**
 * True if this session holds any staged intent still awaiting operator
 * disposition (state IN staged/approved — the same set
 * sweepStagedIntentsForTerminalSessions reaps). Used by boot orphan recovery
 * to distinguish a planning session that merely parked awaiting the operator
 * from one that genuinely finished with nothing pending: only the latter
 * should settle to 'done' from a stuck-result row.
 */
export function hasUndispositionedStagedIntentsForSession(
  sessionId: string,
): boolean {
  _stmtHasUndispositionedStagedIntentsForSession ??= db.prepare<{
    session_id: string;
  }>(
    `SELECT 1 FROM staged_intent
     WHERE session_id = @session_id AND state IN ('staged', 'approved')
     LIMIT 1`,
  );
  return (
    _stmtHasUndispositionedStagedIntentsForSession.get({
      session_id: sessionId,
    }) !== undefined
  );
}

/**
 * True if this task has at least one decision.pickOne intent, staged by any
 * session, in a non-withdrawn/non-superseded state. decision.pickOne carries
 * no taskId of its own the way grouped kinds do (extractTaskId returns null
 * for it — see stagedIntents.ts's assertCompletenessApproval doc comment), so
 * this joins staged_intent to sessions on session_id and scopes by the
 * session's own bound task_id instead — normalized the same way
 * getTerminalSessionsForTask normalizes, so a hyphenated/bare id mismatch
 * never hides a real predecessor decision. Scoped to the *task*, not the
 * staging session, so a resumed or re-dispatched design session sees
 * decisions an earlier session on the same task already staged or had
 * answered.
 */
export function hasDecisionPickOneForTask(taskId: string): boolean {
  _stmtHasDecisionPickOneForTask ??= db.prepare<{ task_id: string }>(
    `SELECT 1 FROM staged_intent si
     JOIN sessions s ON s.session_id = si.session_id
     WHERE si.kind = 'decision.pickOne'
       AND si.state NOT IN ('withdrawn', 'superseded')
       AND REPLACE(COALESCE(s.task_id, ''), '-', '') = @task_id
     LIMIT 1`,
  );
  return (
    _stmtHasDecisionPickOneForTask.get({
      task_id: taskId.replace(/-/g, ''),
    }) !== undefined
  );
}

/**
 * True if this task has a staged_intent outstanding in a state the operator
 * still owns a disposition for — staged/needs_revision/pending_verification.
 * Used by StrandedOpsTaskMonitor to distinguish "legitimately waiting on the
 * operator" (never reported, however old) from "nothing exists that can
 * move this" (reported once stale).
 */
export function hasPendingDecisionForTask(taskId: string): boolean {
  _stmtHasPendingDecisionForTask ??= db.prepare<{ task_id: string }>(
    `SELECT 1 FROM staged_intent
     WHERE task_id = @task_id
       AND state IN ('staged', 'needs_revision', 'pending_verification')
     LIMIT 1`,
  );
  return _stmtHasPendingDecisionForTask.get({ task_id: taskId }) !== undefined;
}

let _stmtGetLatestNoOpForTask: Database.Statement | null = null;

/**
 * The task's most recent planning.noOp staged intent (by creation order),
 * in whatever state it currently holds. isGroomNoOpSuppressed reads its
 * state/updated_at to decide whether the deliberate "leave it at Backlog"
 * decision it recorded still stands.
 */
function getLatestNoOpForTask(taskId: string): StagedIntentRow | undefined {
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
 * A planning flow whose candidacy predicate needs to consult operator kills —
 * see isPlanningKillSuppressed.
 */
export type KillSuppressiblePlanningFlow = 'groom' | 'design' | 'ops';

/**
 * True while a task's most recent planning session of `flow` was ended by an
 * explicit operator kill (reason `user_kill`) and no orchestrator-authored
 * edit (task_body_updated / task_deps_updated) has landed for the task since
 * that kill — the deliberate-kill analog of isGroomNoOpSuppressed, generalized
 * across groom/design/ops. A kill is deliberately excluded from the crash
 * budget (SessionManager's UNCOUNTED_REASONS) so it never triggers a revert or
 * needs_attention; without this gate that exclusion left the task fully
 * candidate-eligible again, re-dispatching on the very next scan tick despite
 * the operator's explicit stop. A session ending for any other reason
 * (done/error/launch_failed/etc.) never suppresses candidacy. The
 * session_errored audit event this reads is written unconditionally by
 * markSessionErrored for every terminal session, including kills.
 */
export function isPlanningKillSuppressed(
  taskId: string,
  flow: KillSuppressiblePlanningFlow,
): boolean {
  const norm = normalizeBoardId(taskId);
  const rows = db
    .prepare<
      { flow: string },
      Session
    >(`SELECT * FROM sessions WHERE session_type = @flow ORDER BY started_at DESC`)
    .all({ flow }) as Session[];
  const session = rows.find(
    (row) => normalizeBoardId(row.task_id ?? '') === norm,
  );
  if (!session || session.status !== 'killed') return false;

  const event = db
    .prepare<{ actor_id: string }, { payload: string }>(
      `SELECT payload FROM audit_log
       WHERE event_type = 'session_errored' AND actor_id = @actor_id
       ORDER BY ts DESC LIMIT 1`,
    )
    .get({ actor_id: session.session_id }) as { payload: string } | undefined;
  if (!event) return false;

  const payload = JSON.parse(event.payload) as { reason?: string };
  if (payload.reason !== 'user_kill') return false;

  return !hasTaskEditSinceTimestamp(taskId, session.ended_at ?? 0);
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

/**
 * The decision-inbox visibility set: intent states where the operator still
 * owns a disposition — active (staged/approved) plus blocked
 * (needs_revision/pending_verification). Terminal states (committed,
 * rejected, superseded, withdrawn) are never included. This is the single
 * source of truth for "awaiting operator disposition" — reuse it rather than
 * re-listing the state names, so other surfaces (e.g. the grooming
 * burndown's awaiting-disposition state) can't drift from the inbox they
 * mirror.
 */
const DECISION_INBOX_VISIBLE_STATES: readonly StagedIntentState[] = [
  'staged',
  'approved',
  'needs_revision',
  'pending_verification',
];

let _stmtListStagedIntentsByMilestone: Database.Statement | null = null;
let _stmtListStagedIntentsUnattributed: Database.Statement | null = null;
let _stmtHasAwaitingDispositionIntentForTask: Database.Statement | null = null;

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
         AND NOT (kind = 'test.request' AND state = 'approved')
       ORDER BY created_at DESC`,
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
       AND NOT (kind = 'test.request' AND state = 'approved')
     ORDER BY created_at DESC`,
  );
  return _stmtListStagedIntentsByMilestone.all({
    project_id: projectId,
    milestone,
  }) as StagedIntentRow[];
}

/**
 * True if this task has at least one staged_intent in the decision-inbox
 * visibility set (see DECISION_INBOX_VISIBLE_STATES) — i.e. the operator
 * still owns a disposition for it. Used by buildTaskViewFromRow to surface
 * "groomed, awaiting disposition" as a distinct grooming-bar state from
 * untouched.
 */
export function hasAwaitingDispositionIntentForTask(taskId: string): boolean {
  _stmtHasAwaitingDispositionIntentForTask ??= db.prepare<unknown[]>(
    `SELECT 1 FROM staged_intent
     WHERE task_id = ?
       AND state IN (${DECISION_INBOX_VISIBLE_STATES.map(() => '?').join(', ')})
     LIMIT 1`,
  );
  return (
    _stmtHasAwaitingDispositionIntentForTask.get(
      taskId,
      ...DECISION_INBOX_VISIBLE_STATES,
    ) !== undefined
  );
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

let _stmtListActiveBodyPatchIntentsForTask: Database.Statement | null = null;

/**
 * Active (staged/approved) task.updateBody / task.patchBodySection intents
 * for a task, regardless of group — the same-task body-patch set
 * computeProposedBody (routes/stagedIntents.ts) folds into its preview so an
 * ungrouped body patch is never invisible to a grouped Ready-flip's gate
 * check just because it wasn't staged into that group. task.patchBodySection
 * rows store their dedup-scoped `<taskId>::<section>` compound key in the
 * task_id column (see extractTaskId in stagedIntents.ts), not the bare
 * taskId — the LIKE clause matches that compound form alongside
 * task.updateBody's plain taskId.
 */
export function listActiveBodyPatchIntentsForTask(
  taskId: string,
): StagedIntentRow[] {
  _stmtListActiveBodyPatchIntentsForTask ??= db.prepare<{
    task_id: string;
    task_id_prefix: string;
  }>(
    `SELECT * FROM staged_intent
     WHERE (task_id = @task_id OR task_id LIKE @task_id_prefix)
       AND kind IN ('task.updateBody', 'task.patchBodySection')
       AND state IN ('staged', 'approved')
     ORDER BY created_at ASC`,
  );
  return _stmtListActiveBodyPatchIntentsForTask.all({
    task_id: taskId,
    task_id_prefix: `${taskId}::%`,
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
let _stmtHasBlockedStagedIntentForSession: Database.Statement | null = null;

/**
 * True when the session owns at least one staged_intent row parked in
 * needs_revision or pending_verification — the same pair of states
 * commitGroupIntents' blocked-member guard (routes/stagedIntents.ts) refuses
 * a group over. Read directly off the persisted table, never a live session
 * handle, so this stays correct across a backend restart.
 */
function hasBlockedStagedIntentForSession(sessionId: string): boolean {
  _stmtHasBlockedStagedIntentForSession ??= db.prepare<{
    session_id: string;
  }>(
    `SELECT 1 FROM staged_intent
     WHERE session_id = @session_id AND state IN ('needs_revision', 'pending_verification')
     LIMIT 1`,
  );
  return (
    _stmtHasBlockedStagedIntentForSession.get({ session_id: sessionId }) !==
    undefined
  );
}

/**
 * Derived "is this session's proposal set complete" signal — never a
 * persisted flag. True exactly when the session's turn is not in flight, it
 * has at least one currently-active (staged/approved) staged intent, and
 * none of its staged intents are wedged in needs_revision/pending_verification
 * (a blocked member means the owning session isn't done turning on its own
 * proposal set — the same predicate commitGroupIntents' blocked-member guard
 * enforces at commit time, mirrored here so a session reads incomplete
 * rather than fail open). Turn-in-flight lives only on the live AgentSession
 * instance and is never persisted (see AgentSession.hasActiveTurn()/
 * _turnInFlight) — callers must supply it; a session with no live instance
 * in this process (parked across a restart, or never spawned here) has no
 * turn in flight by construction. A wake (AgentSession.sendMessage) flips
 * turn-in-flight back to true, so a previously-complete session's staged
 * intents refuse disposition again until the resumed turn ends — no extra
 * bookkeeping needed.
 */
export function isSessionComplete(
  sessionId: string,
  turnInFlight: boolean,
): boolean {
  if (turnInFlight) return false;
  if (hasBlockedStagedIntentForSession(sessionId)) return false;
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

let _stmtListActiveOpsSetStateIntentsForTask: Database.Statement | null = null;

/**
 * Live (staged/approved) journal.setState intents for a task, oldest first —
 * the in-flight ops-journal transition chain a session may be building up
 * within one turn (e.g. pending -> candidate staged, then candidate ->
 * resolved staged in the same closing group). Used to fold the effective
 * "current" state a new journal.setState should be validated against at
 * stage time, since the applied row alone only reflects the last *applied*
 * hop, not staged-but-not-yet-applied ones. See
 * ops/opsJournal.ts's foldOpsTransitionChain.
 */
export function listActiveOpsSetStateIntentsForTask(
  projectId: string,
  taskId: string,
): StagedIntentRow[] {
  _stmtListActiveOpsSetStateIntentsForTask ??= db.prepare<{
    project_id: string;
    task_id: string;
  }>(
    `SELECT * FROM staged_intent
     WHERE project_id = @project_id AND task_id = @task_id AND kind = 'journal.setState'
       AND state IN ('staged', 'approved')
     ORDER BY created_at ASC`,
  );
  return _stmtListActiveOpsSetStateIntentsForTask.all({
    project_id: projectId,
    task_id: taskId,
  }) as StagedIntentRow[];
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

const _stmtFindActiveGateVerifyMirrorForItemByOrigin = new Map<
  string,
  Database.Statement
>();

/**
 * The standing staged/approved `gate.verify` mirror intent (if any) for a
 * given gate_item — the dedup slot for the reconciler's mirror step
 * (gateReconciler.ts's reconcileHumanObservationMirrors), which carries no
 * taskId to key on via findActiveStagedIntentForTask (gate.verify intents
 * key on payload.gateItemId, not payload.taskId). Scoped to a specific
 * payload.origin — `'mirror'` for a runnable Human-Observation item,
 * `'consent'` for a Prod-Mutating item held at pending-approval — so a
 * genuine verifier-originated gate.verify report, or the other origin's
 * mirror, for the same item is never mistaken for a live one of this kind.
 */
export function findActiveGateVerifyMirrorForItem(
  gateItemId: string,
  origin: 'mirror' | 'consent' = 'mirror',
): StagedIntentRow | undefined {
  let stmt = _stmtFindActiveGateVerifyMirrorForItemByOrigin.get(origin);
  if (!stmt) {
    stmt = db.prepare<{ gate_item_id: string; origin: string }>(
      `SELECT * FROM staged_intent
       WHERE kind = 'gate.verify' AND state IN ('staged', 'approved')
         AND json_extract(payload, '$.origin') = @origin
         AND json_extract(payload, '$.gateItemId') = @gate_item_id
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    _stmtFindActiveGateVerifyMirrorForItemByOrigin.set(origin, stmt);
  }
  return stmt.get({
    gate_item_id: gateItemId,
    origin,
  }) as StagedIntentRow | undefined;
}

const _stmtListActiveGateVerifyMirrorsByOrigin = new Map<
  string,
  Database.Statement
>();

/**
 * Every live (staged/approved) mirror intent of the given origin, across all
 * projects — the reconciler's level-triggered retirement scan reads this
 * each pass to withdraw mirrors whose gate_item has since resolved (via the
 * direct GateReadinessPanel/consent path) or, for `'mirror'`, been
 * reclassified away from Human-Observation, so a stale card never lingers
 * in the Decision Inbox.
 */
export function listActiveGateVerifyMirrors(
  origin: 'mirror' | 'consent' = 'mirror',
): StagedIntentRow[] {
  let stmt = _stmtListActiveGateVerifyMirrorsByOrigin.get(origin);
  if (!stmt) {
    stmt = db.prepare<{ origin: string }>(
      `SELECT * FROM staged_intent
       WHERE kind = 'gate.verify' AND state IN ('staged', 'approved')
         AND json_extract(payload, '$.origin') = @origin`,
    );
    _stmtListActiveGateVerifyMirrorsByOrigin.set(origin, stmt);
  }
  return stmt.all({ origin }) as StagedIntentRow[];
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

let _stmtSelectSweepableStagedIntents: Database.Statement | null = null;
let _stmtSupersedeStagedIntentById: Database.Statement | null = null;

/**
 * Backstop sweep for expireStagedIntentsForSession: reaps `staged`/`approved`
 * intents whose owning session already sits at a terminal DB status
 * (done/error/killed) but never went through the terminal-transition hook —
 * e.g. a process crash, or a write path that predates this reaper. Safe to
 * run repeatedly (idempotent: nothing left to reap after the first pass).
 * Returns the reaped rows grouped by session, so the caller can tell each
 * swept session exactly what it lost (see SessionManager's
 * reapStagedIntentsBackstopSweep, which reuses markSessionErrored's expiry
 * notice with these rows).
 */
export function sweepStagedIntentsForTerminalSessions(
  reason: string,
  now: number,
): Array<{
  sessionId: string;
  expired: Array<Pick<StagedIntentRow, 'id' | 'kind' | 'group_id'>>;
}> {
  _stmtSelectSweepableStagedIntents ??= db.prepare(`
    SELECT id, kind, group_id, session_id FROM staged_intent
    WHERE state IN ('staged', 'approved')
      AND session_id IN (
        SELECT session_id FROM sessions WHERE status IN ('done', 'error', 'killed')
      )
  `);
  const rows = _stmtSelectSweepableStagedIntents.all() as Array<{
    id: string;
    kind: string;
    group_id: string | null;
    session_id: string;
  }>;
  if (rows.length === 0) return [];

  // Re-checks the same state/session-terminal predicate as the SELECT above
  // at write time, so a row that changed state (or whose session left the
  // terminal set) between the SELECT and this UPDATE — e.g. a concurrent
  // disposition, or an overlapping sweep invocation — is left untouched
  // rather than blindly forced to 'superseded'. This preserves the
  // check-and-set atomicity of the single-statement UPDATE this replaced.
  _stmtSupersedeStagedIntentById ??= db.prepare<{
    id: string;
    reason: string;
    now: number;
  }>(`
    UPDATE staged_intent
    SET state = 'superseded', disposition_reason = @reason, updated_at = @now
    WHERE id = @id
      AND state IN ('staged', 'approved')
      AND session_id IN (
        SELECT session_id FROM sessions WHERE status IN ('done', 'error', 'killed')
      )
  `);
  const stmt = _stmtSupersedeStagedIntentById;
  const actuallySuperseded = db.transaction((items: typeof rows) => {
    const reaped: typeof rows = [];
    for (const item of items) {
      const result = stmt.run({ id: item.id, reason, now });
      if (result.changes > 0) reaped.push(item);
    }
    return reaped;
  })(rows);

  const bySession = new Map<
    string,
    Array<Pick<StagedIntentRow, 'id' | 'kind' | 'group_id'>>
  >();
  for (const row of actuallySuperseded) {
    const existing = bySession.get(row.session_id);
    const entry = { id: row.id, kind: row.kind, group_id: row.group_id };
    if (existing) {
      existing.push(entry);
    } else {
      bySession.set(row.session_id, [entry]);
    }
  }
  return Array.from(bySession.entries()).map(([sessionId, expired]) => ({
    sessionId,
    expired,
  }));
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
export type TrustPrecisionFlow =
  | 'groom'
  | 'design'
  | 'ops'
  | 'investigate'
  | 'gate-verify';

const STAGED_INTENT_FLOWS: ReadonlySet<TrustPrecisionFlow> = new Set([
  'groom',
  'design',
  'ops',
  'investigate',
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
 *    Scoped to project+milestone via staged_intent.milestone (the canonical
 *    short id, e.g. "M13" — same key space as gate_item.milestone).
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
      WHERE s.project_id = ? AND s.session_type = ? AND si.milestone = ?
        AND si.state IN (${dispositionedPlaceholders})
    `,
    )
    .get(
      ...STAGED_INTENT_REJECTED_STATES,
      project,
      flow,
      milestone,
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

// ─── flake-recovery misclassification signal ──────────────────────────────

/** The gates a flake-recovery re-run can target — see PRMergeWatcher.handleVerifiedFlakyDisposition. */
type FlakeRecoveryGate = 'ci' | 'f2';

const FLAKE_RECOVERY_EVENT_TO_GATE: Record<string, FlakeRecoveryGate> = {
  flake_recovery_ci_rerun: 'ci',
  flake_recovery_f2_rerun: 'f2',
};

export interface FlakeRecoveryMisclassificationRateResult {
  project: string;
  gate: FlakeRecoveryGate;
  conclusive: number;
  failed: number;
  inconclusive: number;
  rate: number | null;
}

/**
 * The transient-failure contract's self-falsification rate: of flake-recovery
 * re-runs that reached a conclusive outcome (passed/failed — see
 * FlakeRecoveryOutcome), what fraction ended in `failed`. Inconclusive
 * re-runs (head_sha drifted mid-run) are reported alongside but excluded
 * from both the numerator and denominator, so they never silently dilute or
 * inflate the rate. Informative only — mirrors getFlowRejectionRate's
 * no-gating posture; nothing reads this to auto-disarm anything.
 */
export function getFlakeRecoveryMisclassificationRates(
  project?: string,
): FlakeRecoveryMisclassificationRateResult[] {
  const eventTypes = Object.keys(FLAKE_RECOVERY_EVENT_TO_GATE);
  const placeholders = eventTypes.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `
      SELECT
        project_id AS project,
        event_type AS eventType,
        SUM(CASE WHEN json_extract(payload, '$.outcome') = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN json_extract(payload, '$.outcome') IN ('passed', 'failed') THEN 1 ELSE 0 END) AS conclusive,
        SUM(CASE WHEN json_extract(payload, '$.outcome') = 'inconclusive' THEN 1 ELSE 0 END) AS inconclusive
      FROM audit_log
      WHERE event_type IN (${placeholders})
        AND project_id IS NOT NULL
        ${project ? 'AND project_id = ?' : ''}
      GROUP BY project_id, event_type
    `,
    )
    .all(...eventTypes, ...(project ? [project] : [])) as Array<{
    project: string;
    eventType: string;
    failed: number | null;
    conclusive: number | null;
    inconclusive: number | null;
  }>;

  return rows.map((row) => {
    const conclusive = row.conclusive ?? 0;
    const failed = row.failed ?? 0;
    return {
      project: row.project,
      gate: FLAKE_RECOVERY_EVENT_TO_GATE[row.eventType],
      conclusive,
      failed,
      inconclusive: row.inconclusive ?? 0,
      rate: conclusive > 0 ? failed / conclusive : null,
    };
  });
}

// ─── lane-health rollup ────────────────────────────────────────────────────

/** p50/p90/p99 of a duration distribution, in ms. Null fields mean no samples were available. */
interface DurationPercentiles {
  p50: number | null;
  p90: number | null;
  p99: number | null;
  sampleCount: number;
}

interface RegressedTestSummary {
  testId: string;
  name: string;
  medianDurationMs: number;
  lastDurationMs: number;
}

export interface LaneHealthRollup {
  project: string;
  totalRuns: number;
  passRate: number | null;
  timeoutRate: number | null;
  /** started_at - requested_at — time spent behind the admission/coalescing semaphore, not test execution. */
  queueWaitMs: DurationPercentiles;
  /** finished_at - started_at — actual lane execution time. */
  executionTimeMs: DurationPercentiles;
  /** Tests currently flagged is_regressed=1 (per-test median/MAD baseline) among this project's tests — display-only, per Open Question 5. */
  regressedTests: RegressedTestSummary[];
  /** Tests currently flagged by the live per-test flip-rate flag — see listFlaggedFlakyTests. */
  flakyTests: {
    count: number;
    tests: FlaggedFlakyTest[];
  };
}

/**
 * Tests currently flagged `is_regressed` whose most recent test_run_results
 * row belongs to this project — test_perf_baselines carries no project_id of
 * its own (keyed by test_id, shared across the lane), so this joins through
 * test_run_results/test_request_runs to scope it. SQLite resolves the bare
 * `name`/`last_duration_ms`-adjacent columns to the max(created_at) row per
 * the GROUP BY per its documented bare-column-with-MAX() behavior.
 */
function getRegressedTestsForProject(
  projectId: string,
): RegressedTestSummary[] {
  const rows = db
    .prepare<{ project_id: string }>(
      `SELECT tpb.test_id AS test_id, trr.name AS name,
              tpb.median_duration_ms AS median_duration_ms,
              tpb.last_duration_ms AS last_duration_ms,
              MAX(trr.created_at) AS created_at
       FROM test_perf_baselines tpb
       JOIN test_run_results trr ON trr.test_id = tpb.test_id
       JOIN test_request_runs r ON r.id = trr.test_request_run_id
       WHERE tpb.is_regressed = 1 AND r.project_id = @project_id
       GROUP BY tpb.test_id
       ORDER BY name ASC`,
    )
    .all({ project_id: projectId }) as Array<{
    test_id: string;
    name: string;
    median_duration_ms: number;
    last_duration_ms: number;
  }>;

  return rows.map((r) => ({
    testId: r.test_id,
    name: r.name,
    medianDurationMs: r.median_duration_ms,
    lastDurationMs: r.last_duration_ms,
  }));
}

function percentilesOf(samples: number[]): DurationPercentiles {
  if (samples.length === 0) {
    return { p50: null, p90: null, p99: null, sampleCount: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => {
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[idx];
  };
  return {
    p50: at(50),
    p90: at(90),
    p99: at(99),
    sampleCount: sorted.length,
  };
}

/**
 * Project-scoped lane-health rollup over test_request_runs: pass rate,
 * timeout rate, and — critically — queue-wait vs execution-time kept as
 * separate distributions (see requested_at/started_at/finished_at split on
 * TestRequestRunRow) so 'this suite is slow' (execution-time) can be told
 * apart from 'this run was starved by a concurrent peer' (queue-wait).
 * Scoped to finished (non-`running`) runs; `limit` bounds how many of the
 * most recent finished runs are considered (most-recent-first).
 */
export function getLaneHealthRollup(
  projectId: string,
  limit = 500,
  // Defaults mirror config/settings.ts's flip_rate_window_n/flip_rate_threshold_k
  // DEFAULT_SETTINGS — not imported here to avoid a circular import (settings.ts
  // imports getSetting/setSetting from this module). Callers with access to the
  // configured settings (e.g. the milestones route) should pass them explicitly.
  flipRateWindowN = 20,
  flipRateThresholdK = 2,
): LaneHealthRollup {
  const rows = db
    .prepare<{ project_id: string; limit: number }>(
      `SELECT state, requested_at, started_at, finished_at, failure_reason
       FROM test_request_runs
       WHERE project_id = @project_id AND state != 'running'
       ORDER BY finished_at DESC, rowid DESC
       LIMIT @limit`,
    )
    .all({ project_id: projectId, limit }) as Array<{
    state: TestRequestRunState;
    requested_at: number | null;
    started_at: number;
    finished_at: number | null;
    failure_reason: TestRequestFailureReason | null;
  }>;

  const totalRuns = rows.length;
  const passed = rows.filter((r) => r.state === 'passed').length;
  const timedOut = rows.filter((r) => r.failure_reason === 'timeout').length;

  const queueWaitSamples = rows
    .filter((r) => r.requested_at !== null)
    .map((r) => r.started_at - (r.requested_at as number));
  const executionTimeSamples = rows
    .filter((r) => r.finished_at !== null)
    .map((r) => (r.finished_at as number) - r.started_at);

  const flakyTests = listFlaggedFlakyTests(
    projectId,
    flipRateWindowN,
    flipRateThresholdK,
  );

  return {
    project: projectId,
    totalRuns,
    passRate: totalRuns > 0 ? passed / totalRuns : null,
    timeoutRate: totalRuns > 0 ? timedOut / totalRuns : null,
    queueWaitMs: percentilesOf(queueWaitSamples),
    executionTimeMs: percentilesOf(executionTimeSamples),
    regressedTests: getRegressedTestsForProject(projectId),
    flakyTests: { count: flakyTests.length, tests: flakyTests },
  };
}

/** The auto-grant kinds the disagreement-rate signal covers. */
export type AutoGrantKind = 'gate.accrete' | 'seed.stage';

export interface AutoGrantDisagreementRateResult {
  kind: AutoGrantKind;
  project: string;
  milestone: string;
  /** Auto-granted (annotation.autoApproved) commits of this kind this rate was computed over. */
  total: number;
  /** Of `total`, the ones whose accreted item(s) were later disagreed with by an independent verification. */
  disagreed: number;
  /** `disagreed / total`, or null when there's no denominator yet. */
  rate: number | null;
}

let _stmtAutoGrantCommittedIntents: Database.Statement | null = null;
let _stmtAutoGrantGateItemIds: Database.Statement | null = null;
let _stmtAutoGrantGateItemEvents: Database.Statement | null = null;
let _stmtAutoGrantSeedItemIds: Database.Statement | null = null;
let _stmtAutoGrantSeedItemEvents: Database.Statement | null = null;

/**
 * Per-(project, milestone, kind) auto-grant disagreement rate — the
 * measurable proxy for the auto-grant accuracy claim (Technical
 * Architecture § "Auto-grant disagreement-rate signal"). Scoped to
 * `kind ∈ {gate.accrete, seed.stage}`: the two staged-intent kinds that
 * commit to `staged_intent`, tagged `annotation: {autoApproved: true}`, and
 * whose accreted item(s) are readable off `gate_item_source`/
 * `seed_item_source` (keyed by `source_task_id`).
 *
 * Numerator: committed auto-granted rows of this kind whose accreted
 * item(s) later received an independent-verification disagreement —
 * a `fail` `gate_item_event.disposition` (gate.accrete) or a `blocked`
 * `seed_item_event.outcome` (seed.stage), or a `needs-setup` disposition
 * recurring 2+ times on the same gate item (a single needs-setup is
 * evidence gathering, not disagreement; seed items have no needs-setup
 * equivalent). Denominator: all committed auto-granted rows of this kind —
 * operator-approved commits of the same kinds are covered by the existing
 * `getFlowRejectionRate` and are excluded here.
 *
 * Purely observational: no threshold, no auto-disarm, no new arm/disarm
 * ladder — the operator reads this like the other trust-precision signals.
 */
export function getAutoGrantDisagreementRate(
  project: string,
  milestone: string,
  kind: AutoGrantKind,
): AutoGrantDisagreementRateResult {
  _stmtAutoGrantCommittedIntents ??= db.prepare(`
    SELECT payload, annotation
    FROM staged_intent
    WHERE kind = ? AND project_id = ? AND milestone = ? AND state = 'committed'
  `);
  const rows = _stmtAutoGrantCommittedIntents.all(kind, project, milestone) as {
    payload: string;
    annotation: string | null;
  }[];

  const autoApprovedSourceTaskIds: string[] = [];
  for (const row of rows) {
    if (!row.annotation) continue;
    let annotation: { autoApproved?: unknown };
    try {
      annotation = JSON.parse(row.annotation) as { autoApproved?: unknown };
    } catch {
      continue;
    }
    if (annotation.autoApproved !== true) continue;
    try {
      const payload = JSON.parse(row.payload) as {
        sourceTask?: { id?: unknown };
      };
      const rawId = payload?.sourceTask?.id;
      if (typeof rawId === 'string') {
        autoApprovedSourceTaskIds.push(normalizeTaskId(rawId));
      }
    } catch {
      /* malformed payload — excluded from both numerator and denominator */
    }
  }

  const total = autoApprovedSourceTaskIds.length;
  let disagreed = 0;

  if (kind === 'gate.accrete') {
    _stmtAutoGrantGateItemIds ??= db.prepare(`
      SELECT DISTINCT gate_item_id FROM gate_item_source WHERE source_task_id = ?
    `);
    _stmtAutoGrantGateItemEvents ??= db.prepare(`
      SELECT disposition FROM gate_item_event WHERE gate_item_id = ?
    `);
    for (const sourceTaskId of autoApprovedSourceTaskIds) {
      const itemIds = _stmtAutoGrantGateItemIds.all(sourceTaskId) as {
        gate_item_id: string;
      }[];
      const disagreedHere = itemIds.some(({ gate_item_id }) => {
        const events = _stmtAutoGrantGateItemEvents!.all(gate_item_id) as {
          disposition: string | null;
        }[];
        if (events.some((e) => e.disposition === 'fail')) return true;
        const needsSetupCount = events.filter(
          (e) => e.disposition === 'needs-setup',
        ).length;
        return needsSetupCount >= 2;
      });
      if (disagreedHere) disagreed++;
    }
  } else {
    _stmtAutoGrantSeedItemIds ??= db.prepare(`
      SELECT DISTINCT seed_item_id FROM seed_item_source WHERE source_task_id = ?
    `);
    _stmtAutoGrantSeedItemEvents ??= db.prepare(`
      SELECT outcome FROM seed_item_event WHERE seed_item_id = ?
    `);
    for (const sourceTaskId of autoApprovedSourceTaskIds) {
      const itemIds = _stmtAutoGrantSeedItemIds.all(sourceTaskId) as {
        seed_item_id: string;
      }[];
      const disagreedHere = itemIds.some(({ seed_item_id }) => {
        const events = _stmtAutoGrantSeedItemEvents!.all(seed_item_id) as {
          outcome: string;
        }[];
        return events.some((e) => e.outcome === 'blocked');
      });
      if (disagreedHere) disagreed++;
    }
  }

  return {
    kind,
    project,
    milestone,
    total,
    disagreed,
    rate: total > 0 ? disagreed / total : null,
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

/**
 * Distinct topic values across the whole arch_unit table (all statuses) —
 * the live topic vocabulary, used to tell "topic not recognized" apart from
 * "topic recognized but currently empty" when a queryArchUnits call by
 * topic returns zero rows.
 */
export function listArchUnitTopics(): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT topic FROM arch_unit ORDER BY topic`)
    .all() as { topic: string }[];
  return rows.map((r) => r.topic);
}

/**
 * Distinct region values across the whole arch_unit table (all statuses),
 * flattened out of each row's JSON regions array — the live region
 * vocabulary a region substring filter is checked against.
 */
export function listArchUnitRegions(): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT r.value AS region
       FROM arch_unit, json_each(arch_unit.regions) AS r
       ORDER BY region`,
    )
    .all() as { region: string }[];
  return rows.map((r) => r.region);
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

/**
 * Effective arm state: the flow_arm row's value if present, else DEFAULT_ARM[flow].
 * `milestoneId` is the milestone's DB id (UUID), NOT its gate_item/seed_item
 * display name (e.g. "M13") — flow_arm.milestone_id is keyed by id. Resolve
 * a display name to its row (e.g. via resolveMilestoneRowForProject) before
 * calling this.
 */
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

// ─── completing_signal_ledger ────────────────────────────────────────────────
// New, additive infrastructure for session/sessionStatusDeriver.ts — no
// existing writer inserts into this table yet. See the schema comment on
// completing_signal_ledger in schema.ts.

let _stmtInsertCompletingSignal: Database.Statement | null = null;
let _stmtListCompletingSignalsForSession: Database.Statement | null = null;

/** Append a completing-signal observation for a session. Synchronous, single-row insert — never batched. */
export function insertCompletingSignal(
  entry: NewCompletingSignalLedgerRow,
): void {
  _stmtInsertCompletingSignal ??= db.prepare<NewCompletingSignalLedgerRow>(`
    INSERT INTO completing_signal_ledger
      (session_id, task_id, session_type, signal_class, signal_value, recorded_at)
    VALUES
      (@session_id, @task_id, @session_type, @signal_class, @signal_value, @recorded_at)
  `);
  _stmtInsertCompletingSignal.run(entry);
}

/** All completing-signal ledger rows for a session, oldest first. */
export function listCompletingSignalsForSession(
  sessionId: string,
): CompletingSignalLedgerRow[] {
  _stmtListCompletingSignalsForSession ??= db.prepare<{
    session_id: string;
  }>(`
    SELECT * FROM completing_signal_ledger
    WHERE session_id = @session_id
    ORDER BY recorded_at ASC, id ASC
  `);
  return _stmtListCompletingSignalsForSession.all({
    session_id: sessionId,
  }) as CompletingSignalLedgerRow[];
}
