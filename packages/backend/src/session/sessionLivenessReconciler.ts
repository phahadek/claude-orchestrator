import {
  listLivePlanningSessionRows,
  listLiveSessionRows,
  getSessionLastActivityMs,
  updateSessionStatus,
  getSession,
  TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED,
} from '../db/queries';
import { isPlanningSession } from './sessionPredicates';
import { revokeStageCredential } from '../auth/SessionStageAuth';
import { revokeRouteCredential } from '../auth/SessionRouteAuth';
import { recordEvent } from '../audit/AuditLog';
import { runtimeSettings } from '../config';
import {
  isSessionProcessAlive,
  scanClaudeSessionProcesses,
  type ClaudeSessionProcess,
} from './processLiveness';
import { logger } from '../logger';
import type { Session } from '../db/types';

/**
 * Minimum time since a session's last recorded activity (or since it
 * started, if it has no events) before the reconciler acts on a
 * process-not-found verdict. The signal that authorizes reconciliation is
 * always OS process non-existence, never elapsed time or status alone (see
 * procedures.md's ban on that reasoning) — this floor only corroborates the
 * process check against the one race it cannot rule out by itself: a row
 * just inserted a moment before its subprocess actually forked.
 */
const LIVENESS_RECONCILE_GRACE_MS = 2 * 60_000;

export interface SessionLivenessReconcilerDeps {
  /** Overridable for tests; defaults to the real `ps`-backed check. */
  isProcessAlive?: (sessionId: string) => boolean;
  /** Drops the session's stale in-memory entry, if any — SessionManager wires this to evictDeadSessionEntry. */
  evictSessionMapEntry?: (sessionId: string) => void;
  nowFn?: () => number;
  /**
   * Only consulted by the planning population (reconcileSessionLiveness):
   * a last-chance completeness check tried before this sweep would
   * otherwise overwrite a dead-process row with a bare 'killed' status.
   * SessionManager wires this to PlanningOrchestrator.tryTerminalizeIfComplete
   * — a session whose staged work had actually settled (e.g. an
   * investigate session that staged nothing, or dispositioned everything)
   * before its process died is driven to 'done' with a proper
   * terminal_completion_reason via markTerminal instead of being reaped as
   * an unexplained 'killed', closing the restart race where a session never
   * lived long enough to reach its own onSessionParked/checkTerminal path.
   * Returns true if it terminalized the session itself (the sweep then
   * skips its own 'killed' write for that row); false leaves the row to the
   * normal 'killed' fallback below.
   */
  tryMarkPlanningTerminal?: (sessionId: string) => boolean;
}

export interface SessionLivenessReconcileResult {
  reconciled: string[];
  /** Size of the candidate set this sweep examined (before filtering to dead rows). */
  examined: number;
  /** Count of candidate rows whose process check reported alive (examined - reconciled.length). */
  alive: number;
}

/**
 * DB → OS reconciliation sweep: a non-terminal planning session row (running
 * or idle) whose OS subprocess does not exist is reconciled to a terminal
 * status ('killed'). The mirror-image counterpart to
 * SessionManager.reconcileSessionsMap (memory → DB, drops a stale in-memory
 * entry when the DB row is already terminal): this sweep goes the other
 * direction and writes the terminal status itself, so it is the only one of
 * the two with authority to do that. It also drops the in-memory entry
 * directly, so the two sweeps can never leave a session stranded in the gap
 * where each defers to the other's axis (a stale in-memory entry paired with
 * a non-terminal DB row).
 *
 * Never gated on SessionManager.isAlive() / the in-memory `this.sessions`
 * map — that in-memory state is exactly what can be stale here.
 */
export function reconcileSessionLiveness(
  deps: SessionLivenessReconcilerDeps = {},
): SessionLivenessReconcileResult {
  return runLivenessSweep(listLivePlanningSessionRows(), 'planning', deps);
}

/**
 * Non-planning counterpart to reconcileSessionLiveness above: covers
 * standard/review/depth_review (and any other non-planning) session rows,
 * which have no other periodic OS-process-liveness sweep —
 * StuckSessionMonitor only matches rows whose last event is 'result' (a
 * session killed before it ever emits a session_events row never matches
 * that INNER JOIN), and resumeOrphanSessions only runs on backend boot.
 * Same grace-floor / api-mode-skip / map-eviction semantics as the planning
 * sweep; kept as a separate exported function (rather than folding into
 * reconcileSessionLiveness) so the planning sweep's audit event name and
 * behavior stay byte-for-byte unchanged for existing callers/tests.
 */
export function reconcileNonPlanningSessionLiveness(
  deps: SessionLivenessReconcilerDeps = {},
): SessionLivenessReconcileResult {
  const rows = listLiveSessionRows().filter(
    (row) => !isPlanningSession(row.session_type ?? ''),
  );
  return runLivenessSweep(rows, 'non-planning', deps);
}

function runLivenessSweep(
  rows: Session[],
  population: 'planning' | 'non-planning',
  deps: SessionLivenessReconcilerDeps,
): SessionLivenessReconcileResult {
  // API-mode sessions have no OS subprocess by design — a "no process
  // found" verdict would be true for every live session in that mode, not
  // just dead ones, so this reconciler does not apply to it.
  if (runtimeSettings.session_mode === 'api') {
    return { reconciled: [], examined: 0, alive: 0 };
  }

  const isProcessAlive = deps.isProcessAlive ?? isSessionProcessAlive;
  const evictSessionMapEntry = deps.evictSessionMapEntry ?? (() => {});
  const now = deps.nowFn ? deps.nowFn() : Date.now();

  const examined = rows.length;
  let alive = 0;
  const reconciled: string[] = [];
  const terminalizedViaCompletion: string[] = [];
  for (const row of rows) {
    if (isProcessAlive(row.session_id)) {
      alive++;
      continue;
    }

    const lastActivity =
      getSessionLastActivityMs(row.session_id) ?? row.started_at;
    if (now - lastActivity < LIVENESS_RECONCILE_GRACE_MS) {
      // Not yet clear of the process-race grace floor — neither confirmed
      // dead nor counted alive; the process check itself did not say alive.
      continue;
    }

    if (
      population === 'planning' &&
      deps.tryMarkPlanningTerminal?.(row.session_id)
    ) {
      evictSessionMapEntry(row.session_id);
      revokeStageCredential(
        row.session_id,
        'liveness_reconciler_process_not_found',
      );
      revokeRouteCredential(
        row.session_id,
        'liveness_reconciler_process_not_found',
      );
      terminalizedViaCompletion.push(row.session_id);
      logger.info(
        `[sessionLivenessReconciler] session ${row.session_id.slice(0, 8)} had no live OS process but its staged work had already settled — reconciled to done rather than killed`,
      );
      continue;
    }

    updateSessionStatus(row.session_id, 'killed', now);
    evictSessionMapEntry(row.session_id);
    revokeStageCredential(
      row.session_id,
      'liveness_reconciler_process_not_found',
    );
    revokeRouteCredential(
      row.session_id,
      'liveness_reconciler_process_not_found',
    );
    reconciled.push(row.session_id);
    logger.warn(
      `[sessionLivenessReconciler] session ${row.session_id.slice(0, 8)} (status=${row.status}) has no live OS process — reconciled to killed`,
    );
  }

  if (reconciled.length > 0) {
    recordEvent({
      event_type:
        population === 'planning'
          ? 'planning_sessions_liveness_reconciled'
          : 'non_planning_sessions_liveness_reconciled',
      actor_type: 'system',
      payload: {
        reconciled_count: reconciled.length,
        session_ids: reconciled,
        reason: 'process_not_found',
      },
    });
    logger.info(
      `[sessionLivenessReconciler] reconciled ${reconciled.length} ${population} session(s) with no live OS process`,
    );
  }

  return {
    reconciled: [...reconciled, ...terminalizedViaCompletion],
    examined,
    alive,
  };
}

export interface OrphanProcessReconcilerDeps {
  /** Overridable for tests; defaults to the real `ps`-backed scan. */
  scanProcesses?: () => ClaudeSessionProcess[];
  /** Overridable for tests; defaults to the real DB row lookup. */
  getSessionRow?: (sessionId: string) => Session | undefined;
  /** Overridable for tests; defaults to a real `process.kill(pid, 'SIGTERM')`. */
  killProcess?: (pid: number) => void;
  /** Drops the session's stale in-memory entry, if any — SessionManager wires this to evictDeadSessionEntry. */
  evictSessionMapEntry?: (sessionId: string) => void;
  nowFn?: () => number;
}

export interface OrphanProcessReconcileResult {
  /** Candidate processes examined — those carrying a resolvable session uuid. */
  examined: number;
  /** Processes terminated because their row was terminal/missing, past the grace floor. */
  reaped: number;
  /** Candidates that resolved to a reapable state but were held back by the grace floor. */
  skippedByGrace: number;
}

function defaultKillProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    // ESRCH (already exited) is the expected/common case here — the sweep
    // still counts the candidate as reaped, since the outcome (no such
    // process) is what it was trying to achieve.
    logger.warn(
      `[sessionLivenessReconciler] kill(${pid}) failed (likely already exited): ${(err as Error).message}`,
    );
  }
}

/**
 * OS → DB reconciliation sweep: the fourth cell in the reconciler coverage
 * matrix. reconcileSessionsMap (memory → DB) only iterates in-memory map
 * entries; the liveness sweeps above (DB → OS) only iterate non-terminal
 * rows. A claude OS process whose session row is already terminal is
 * invisible to all three — this sweep enumerates the OS process table
 * directly and closes that gap.
 *
 * Deliberately writes no session status: the row is already terminal, so
 * the only correct action is terminating the orphaned process and dropping
 * any stale in-memory map entry — never re-terminalizing a row, which could
 * stomp a status another path had legitimately written.
 *
 * A process with no resolvable `--session-id`/`--resume` uuid (e.g. `claude
 * remote-control`, the operator's own console) is never a candidate, under
 * any circumstance — there is nothing to resolve it against. Nor is a
 * process whose uuid resolves to no row at all: ownership ("is this row
 * mine?") is the invariant, and a process this sweep does not own must
 * never be reaped, even if it looks orphaned — see e.g. Remote Control
 * sessions, whose cloud session ids never have a row in this DB. A process
 * whose uuid resolves to a non-terminal row is never reaped either; that
 * case belongs to the liveness sweeps above, which reconcile the row
 * instead of touching the process.
 */
export function reconcileOrphanProcesses(
  deps: OrphanProcessReconcilerDeps = {},
): OrphanProcessReconcileResult {
  // API-mode sessions have no OS subprocess by design — see runLivenessSweep's
  // identical guard above.
  if (runtimeSettings.session_mode === 'api') {
    return { examined: 0, reaped: 0, skippedByGrace: 0 };
  }

  const scanProcesses = deps.scanProcesses ?? scanClaudeSessionProcesses;
  const getSessionRow = deps.getSessionRow ?? getSession;
  const killProcess = deps.killProcess ?? defaultKillProcess;
  const evictSessionMapEntry = deps.evictSessionMapEntry ?? (() => {});
  const now = deps.nowFn ? deps.nowFn() : Date.now();

  let examined = 0;
  let reaped = 0;
  let skippedByGrace = 0;

  for (const proc of scanProcesses()) {
    // Hard safety constraint: a process with no resolvable session uuid
    // (e.g. `claude remote-control`) must never be a reap candidate.
    if (!proc.sessionId) continue;
    examined++;

    const row = getSessionRow(proc.sessionId);
    if (!row) {
      // No row means it's not ours — e.g. a Remote Control session with a
      // cloud session id. Never reap what we don't own.
      continue;
    }
    if (!TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED.has(row.status)) {
      // Belongs to the liveness sweeps (they reconcile the row); not ours.
      continue;
    }

    // Grace floor, measured from the row's own ended_at — the row may still
    // be mid-teardown. A terminal row should always carry ended_at; fall
    // back to now (i.e. always within grace) in the fail-safe direction if
    // it somehow doesn't.
    const referenceMs = row.ended_at ?? now;
    if (now - referenceMs < LIVENESS_RECONCILE_GRACE_MS) {
      skippedByGrace++;
      continue;
    }

    killProcess(proc.pid);
    evictSessionMapEntry(proc.sessionId);
    reaped++;
    logger.warn(
      `[sessionLivenessReconciler] reaped orphaned process pid=${proc.pid} for session ${proc.sessionId.slice(0, 8)} (status=${row.status})`,
    );
  }

  if (reaped > 0) {
    recordEvent({
      event_type: 'orphan_processes_reaped',
      actor_type: 'system',
      payload: { reaped_count: reaped, reason: 'terminal_row' },
    });
    logger.info(
      `[sessionLivenessReconciler] reaped ${reaped} orphaned process(es) with a terminal session row`,
    );
  }

  return { examined, reaped, skippedByGrace };
}
