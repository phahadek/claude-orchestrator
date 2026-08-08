import {
  listLivePlanningSessionRows,
  getSessionLastActivityMs,
  updateSessionStatus,
} from '../db/queries';
import { revokeStageCredential } from '../auth/SessionStageAuth';
import { recordEvent } from '../audit/AuditLog';
import { runtimeSettings } from '../config';
import { isSessionProcessAlive } from './processLiveness';
import { logger } from '../logger';

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
}

export interface SessionLivenessReconcileResult {
  reconciled: string[];
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
  // API-mode sessions have no OS subprocess by design — a "no process
  // found" verdict would be true for every live session in that mode, not
  // just dead ones, so this reconciler does not apply to it.
  if (runtimeSettings.session_mode === 'api') {
    return { reconciled: [] };
  }

  const isProcessAlive = deps.isProcessAlive ?? isSessionProcessAlive;
  const evictSessionMapEntry = deps.evictSessionMapEntry ?? (() => {});
  const now = deps.nowFn ? deps.nowFn() : Date.now();

  const reconciled: string[] = [];
  for (const row of listLivePlanningSessionRows()) {
    if (isProcessAlive(row.session_id)) continue;

    const lastActivity =
      getSessionLastActivityMs(row.session_id) ?? row.started_at;
    if (now - lastActivity < LIVENESS_RECONCILE_GRACE_MS) continue;

    updateSessionStatus(row.session_id, 'killed', now);
    evictSessionMapEntry(row.session_id);
    revokeStageCredential(
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
      event_type: 'planning_sessions_liveness_reconciled',
      actor_type: 'system',
      payload: {
        reconciled_count: reconciled.length,
        session_ids: reconciled,
        reason: 'process_not_found',
      },
    });
    logger.info(
      `[sessionLivenessReconciler] reconciled ${reconciled.length} planning session(s) with no live OS process`,
    );
  }

  return { reconciled };
}
