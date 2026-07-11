import {
  getDeadSessionsAtBoot,
  getIdleSessionsWithResolvedPRs,
  getIdleReviewSessionsWithTerminalCodingOrPR,
  markSessionDone,
  updateSessionStatus,
} from '../db/queries';
import { logger } from '../logger';

/**
 * Boot-time reconciliation: scan for idle sessions whose linked PR is already
 * merged or closed, and apply the terminal DB transition immediately.
 *
 * Runs after runPRBootSweep so the pull_requests table is fully populated with
 * any closed/merged PRs that exist on GitHub. Without this pass, idle sessions
 * whose PRs resolved while the server was offline remain stuck at status='idle'.
 *
 * Pass 0 — dead sessions (starting/running at boot, not live):
 *   resumeOrphanSessions() runs before this pass and is the sole owner of
 *   'running' sessions at boot: it either respawns them (live in
 *   SessionManager.sessions, DB stays 'running') or drives an unresumable one
 *   to a terminal state itself, flagging the task needs_attention rather than
 *   silently erroring it (see SessionManager.flagResumeFailure). Pass 0 must
 *   never re-touch a session resume just adopted — it only disposes sessions
 *   that are NOT live, e.g. ones stuck at 'starting' from a crash mid-launch,
 *   which resume never sees. (Incident 2026-07-02: Pass 0 raced resume and
 *   clobbered a freshly-respawned session, stranding task relaunch.)
 *
 * Pass 1 — idle coding sessions with resolved PRs:
 *   idle + merged PR → done  (PR merged while server was down)
 *   idle + closed PR → error (PR closed without merge while server was down)
 *
 * Pass 2 — idle review sessions with terminal coding session or resolved PR:
 *   review idle + coding done  → done
 *   review idle + coding error/killed → error
 *   review idle + merged PR (no terminal coding) → done
 *   review idle + closed PR (no terminal coding) → error
 * Mirrors the coding session's terminal status; defaults to done if absent.
 */
export function runBootIdleReconciliation(
  isSessionLive: (sessionId: string) => boolean = () => false,
): void {
  _runPass0(isSessionLive);
  _runPass1();
  _runPass2();
}

function _runPass0(isSessionLive: (sessionId: string) => boolean): void {
  const rows = getDeadSessionsAtBoot().filter(
    (row) => !isSessionLive(row.session_id),
  );
  if (rows.length === 0) return;

  logger.info(
    `[BootIdleReconciliation] ${rows.length} session(s) at starting/running at boot and not live — process tree gone, marking error`,
  );

  const now = Date.now();
  for (const row of rows) {
    updateSessionStatus(row.session_id, 'error', now);
    logger.info(
      `[BootIdleReconciliation] ${row.session_id.slice(0, 8)} ${row.status}→error (dead at boot)`,
    );
  }
}

function _runPass1(): void {
  const rows = getIdleSessionsWithResolvedPRs();
  if (rows.length === 0) return;

  logger.info(
    `[BootIdleReconciliation] ${rows.length} idle session(s) with resolved PRs — applying terminal transitions`,
  );

  const now = Date.now();
  for (const row of rows) {
    if (row.pr_state === 'merged') {
      markSessionDone(row.session_id, now, row.pr_url, 'boot_idle_merged_pr');
      logger.info(
        `[BootIdleReconciliation] ${row.session_id.slice(0, 8)} idle→done (PR #${row.pr_number} ${row.repo} merged)`,
      );
      if (row.review_session_id) {
        markSessionDone(
          row.review_session_id,
          now,
          row.pr_url,
          'boot_idle_merged_pr',
        );
        logger.info(
          `[BootIdleReconciliation] review ${row.review_session_id.slice(0, 8)} idle→done (PR #${row.pr_number} ${row.repo} merged)`,
        );
      }
    } else {
      updateSessionStatus(row.session_id, 'error', now);
      logger.info(
        `[BootIdleReconciliation] ${row.session_id.slice(0, 8)} idle→error (PR #${row.pr_number} ${row.repo} closed)`,
      );
      if (row.review_session_id) {
        updateSessionStatus(row.review_session_id, 'error', now);
        logger.info(
          `[BootIdleReconciliation] review ${row.review_session_id.slice(0, 8)} idle→error (PR #${row.pr_number} ${row.repo} closed)`,
        );
      }
    }
  }
}

function _runPass2(): void {
  const rows = getIdleReviewSessionsWithTerminalCodingOrPR();
  if (rows.length === 0) return;

  logger.info(
    `[BootIdleReconciliation] ${rows.length} idle review session(s) with terminal coding/PR — applying terminal transitions`,
  );

  const now = Date.now();
  for (const row of rows) {
    const terminal = _resolveReviewTerminalStatus(
      row.coding_session_status,
      row.pr_state,
    );
    if (terminal === 'done') {
      markSessionDone(
        row.session_id,
        now,
        row.pr_url,
        'boot_idle_orphan_review',
      );
      logger.info(
        `[BootIdleReconciliation] review ${row.session_id.slice(0, 8)} idle→done (coding=${row.coding_session_status ?? 'none'} pr=${row.pr_state})`,
      );
    } else {
      updateSessionStatus(row.session_id, 'error', now);
      logger.info(
        `[BootIdleReconciliation] review ${row.session_id.slice(0, 8)} idle→error (coding=${row.coding_session_status ?? 'none'} pr=${row.pr_state})`,
      );
    }
  }
}

function _resolveReviewTerminalStatus(
  codingSessionStatus: string | null,
  prState: string,
): 'done' | 'error' {
  if (codingSessionStatus === 'done') return 'done';
  if (codingSessionStatus === 'error' || codingSessionStatus === 'killed')
    return 'error';
  // No terminal coding session — use PR state
  if (prState === 'merged') return 'done';
  if (prState === 'closed') return 'error';
  // Default to done per spec
  return 'done';
}
