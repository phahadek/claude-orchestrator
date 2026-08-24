import {
  listLivePlanningSessionRows,
  listLiveSessionRows,
  getSessionLastActivityMs,
  updateSessionStatus,
  setSessionTerminalCompletionReason,
  getSession,
  hasUndispositionedStagedIntentsForSession,
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
  killWorktreeProcessTree,
  type ClaudeSessionProcess,
} from './processLiveness';
import { killSessionCgroup } from './sessionCgroup';
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

/**
 * Minimum time since *backend process boot* (not session activity) before
 * this reconciler will act on a process-not-found verdict at all. In the
 * first moments after a restart the in-memory session/process map is empty
 * or still rehydrating, so a failed process lookup is indistinguishable
 * from a process that genuinely exited — this settle window keeps the
 * reconciler from treating that rehydration gap as mass process death.
 * Measured independently of LIVENESS_RECONCILE_GRACE_MS, which is anchored
 * to the session's own last activity and says nothing about how long the
 * backend itself has been up.
 */
const LIVENESS_RECONCILE_SETTLE_MS = 2 * 60_000;

/**
 * Captured once at module load, which happens once per backend process
 * lifetime as part of server startup — this process's stand-in for "boot
 * time". Overridable per-call via deps.bootTimeMs for tests.
 */
const BACKEND_BOOT_MS = Date.now();

export interface SessionLivenessReconcilerDeps {
  /** Overridable for tests; defaults to the real `ps`-backed check. */
  isProcessAlive?: (sessionId: string) => boolean;
  /** Drops the session's stale in-memory entry, if any — SessionManager wires this to evictDeadSessionEntry. */
  evictSessionMapEntry?: (sessionId: string) => void;
  nowFn?: () => number;
  /** Overridable for tests; defaults to BACKEND_BOOT_MS (module-load time). */
  bootTimeMs?: number;
  /** Overridable for tests; defaults to the real staged_intent lookup. */
  hasUndispositionedStagedIntents?: (sessionId: string) => boolean;
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
  const bootTimeMs = deps.bootTimeMs ?? BACKEND_BOOT_MS;
  const hasUndispositionedStagedIntents =
    deps.hasUndispositionedStagedIntents ??
    hasUndispositionedStagedIntentsForSession;

  const examined = rows.length;
  let alive = 0;
  const reconciled: string[] = [];
  const terminalizedViaCompletion: string[] = [];

  if (now - bootTimeMs < LIVENESS_RECONCILE_SETTLE_MS) {
    // Backend hasn't been up long enough for the in-memory session/process
    // map to have rehydrated — a process-not-found verdict right now can't
    // be trusted for anyone, no matter how long any individual session has
    // been quiet. Skip the entire sweep rather than risk mass reap.
    return { reconciled: [], examined, alive: 0 };
  }

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

    if (hasUndispositionedStagedIntents(row.session_id)) {
      // Legitimately quiet by design: blocked on a staged intent (e.g. a
      // test.request) awaiting disposition. Event silence during that wait
      // is expected, not a liveness signal — never reap on it.
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
    setSessionTerminalCompletionReason(
      row.session_id,
      'liveness_reconciler_process_not_found',
    );
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
  /** Overridable for tests; defaults to a real `process.kill(pid, signal)`. */
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Overridable for tests; defaults to a real liveness check of a specific
   * pid via `process.kill(pid, 0)`. Used to confirm the SIGTERM/SIGKILL
   * escalation below actually terminated the process, rather than merely
   * having sent a signal — see defaultIsPidAlive.
   */
  isPidAlive?: (pid: number) => boolean;
  /**
   * Overridable for tests; defaults to a real `setTimeout`-backed delay.
   * Used to wait out the SIGTERM grace period (and a short post-SIGKILL
   * settle) before checking whether the process actually exited.
   */
  waitMs?: (ms: number) => Promise<void>;
  /**
   * Overridable for tests; defaults to the real cgroup-scoped kill
   * (sessionCgroup.ts's killSessionCgroup). Reaches a test-command tree
   * (pytest, `uv run task test`) the reaped `proc` itself carries no
   * --session-id/--resume for — cgroup-v2 membership is inherited at fork
   * regardless of that flag.
   */
  killSessionCgroup?: (sessionId: string) => void;
  /**
   * Overridable for tests; defaults to the real worktree-path-keyed kill
   * (processLiveness.ts's killWorktreeProcessTree) — the backstop for hosts
   * without cgroup-v2 delegation.
   */
  killWorktreeProcessTree?: (worktreePath: string) => number;
  /** Drops the session's stale in-memory entry, if any — SessionManager wires this to evictDeadSessionEntry. */
  evictSessionMapEntry?: (sessionId: string) => void;
  nowFn?: () => number;
}

export interface OrphanProcessReconcileResult {
  /** Candidate processes examined — those carrying a resolvable session uuid. */
  examined: number;
  /** Processes whose termination was confirmed (post-SIGTERM or post-SIGKILL verification). */
  reaped: number;
  /** Candidates that resolved to a reapable state but were held back by the grace floor. */
  skippedByGrace: number;
  /**
   * Candidates that were escalated all the way to SIGKILL and still could
   * not be confirmed dead (e.g. stuck in an uninterruptible D-state) — not
   * counted in `reaped`. The cgroup/worktree-tree backstops still ran for
   * these, and the next sweep will retry.
   */
  survivedEscalation: number;
}

/**
 * Same grace period CliSessionRunner.kill() waits after SIGTERM before
 * escalating to SIGKILL (its GRACEFUL_END_TIMEOUT_MS) — kept as an
 * independent constant rather than a cross-module import, since several
 * SessionManager tests `vi.mock` CliSessionRunner without re-exporting its
 * constants, and this reconciler module is pulled in transitively by
 * SessionManager.ts.
 */
const KILL_ESCALATION_WAIT_MS = 15_000;

/**
 * Short settle window after sending SIGKILL before checking liveness —
 * SIGKILL cannot be ignored, but the kernel needs a moment to reap the
 * process and update the process table.
 */
const POST_SIGKILL_SETTLE_MS = 500;

function defaultKillProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    // ESRCH (already exited) is the expected/common case here.
    logger.warn(
      `[sessionLivenessReconciler] kill(${pid}, ${signal}) failed (likely already exited): ${(err as Error).message}`,
    );
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // Any other error (e.g. EPERM) means the process exists but is not
    // signalable by us — fail safe and treat it as still alive.
    return true;
  }
}

function defaultWaitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SIGTERM → wait → verify → SIGKILL → wait → verify, mirroring
 * CliSessionRunner.kill()'s escalation. Returns true only once the
 * process's death is actually confirmed, not merely once a signal was
 * sent — a process ignoring SIGTERM (or unresponsive) must never be
 * silently counted as reaped.
 */
async function killProcessWithEscalation(
  pid: number,
  killProcess: (pid: number, signal: NodeJS.Signals) => void,
  isPidAlive: (pid: number) => boolean,
  waitMs: (ms: number) => Promise<void>,
): Promise<boolean> {
  killProcess(pid, 'SIGTERM');
  await waitMs(KILL_ESCALATION_WAIT_MS);
  if (!isPidAlive(pid)) return true;

  logger.warn(
    `[sessionLivenessReconciler] pid=${pid} did not exit within ${KILL_ESCALATION_WAIT_MS}ms of SIGTERM; escalating to SIGKILL`,
  );
  killProcess(pid, 'SIGKILL');
  await waitMs(POST_SIGKILL_SETTLE_MS);
  return !isPidAlive(pid);
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
export async function reconcileOrphanProcesses(
  deps: OrphanProcessReconcilerDeps = {},
): Promise<OrphanProcessReconcileResult> {
  // API-mode sessions have no OS subprocess by design — see runLivenessSweep's
  // identical guard above.
  if (runtimeSettings.session_mode === 'api') {
    return { examined: 0, reaped: 0, skippedByGrace: 0, survivedEscalation: 0 };
  }

  const scanProcesses = deps.scanProcesses ?? scanClaudeSessionProcesses;
  const getSessionRow = deps.getSessionRow ?? getSession;
  const killProcess = deps.killProcess ?? defaultKillProcess;
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const waitMs = deps.waitMs ?? defaultWaitMs;
  const killCgroup = deps.killSessionCgroup ?? killSessionCgroup;
  const killWorktreeTree =
    deps.killWorktreeProcessTree ?? killWorktreeProcessTree;
  const evictSessionMapEntry = deps.evictSessionMapEntry ?? (() => {});
  const now = deps.nowFn ? deps.nowFn() : Date.now();

  let examined = 0;
  let skippedByGrace = 0;

  // Candidates confirmed reapable by row/grace checks, escalated below —
  // concurrently, not one after another. Each escalation is dominated by a
  // fixed per-pid wait (KILL_ESCALATION_WAIT_MS, +POST_SIGKILL_SETTLE_MS on
  // the SIGKILL path); running the loop's `await` sequentially would make a
  // sweep's wall-clock scale with orphan count (16 orphans -> minutes) where
  // it used to be near-instant, and since this job is skip-if-running, that
  // also suppresses the next scheduled sweep. Promise.all keeps sweep
  // duration ~= one escalation, independent of how many orphans it covers.
  const candidates: Array<{ pid: number; sessionId: string; status: string }> =
    [];

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

    // Reach the session's whole test-command process tree, not just the
    // scanned pid — a pytest/`uv run task test` tree forked by this
    // session's own process carries no --session-id/--resume of its own,
    // so it would otherwise survive this sweep entirely. Run unconditionally
    // alongside the pid-level escalation below, since neither backstop can
    // see what the other reaches (see sessionCgroup.ts's documented no-op
    // when cgroup delegation was never set up).
    killCgroup(proc.sessionId);
    if (row.worktree_path) killWorktreeTree(row.worktree_path);

    candidates.push({
      pid: proc.pid,
      sessionId: proc.sessionId,
      status: row.status,
    });
  }

  const escalations = await Promise.all(
    candidates.map(async (candidate) => {
      const confirmedDead = await killProcessWithEscalation(
        candidate.pid,
        killProcess,
        isPidAlive,
        waitMs,
      );
      evictSessionMapEntry(candidate.sessionId);
      return { ...candidate, confirmedDead };
    }),
  );

  let reaped = 0;
  let survivedEscalation = 0;
  for (const { pid, sessionId, status, confirmedDead } of escalations) {
    if (confirmedDead) {
      reaped++;
      logger.warn(
        `[sessionLivenessReconciler] reaped orphaned process pid=${pid} for session ${sessionId.slice(0, 8)} (status=${status})`,
      );
    } else {
      survivedEscalation++;
      logger.error(
        `[sessionLivenessReconciler] pid=${pid} for session ${sessionId.slice(0, 8)} (status=${status}) survived SIGTERM and SIGKILL — will retry next sweep`,
      );
    }
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

  return { examined, reaped, skippedByGrace, survivedEscalation };
}
