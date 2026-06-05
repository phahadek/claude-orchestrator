import {
  getIdleSessionsWithResolvedPRs,
  markSessionDone,
  updateSessionStatus,
} from '../db/queries';

/**
 * Boot-time reconciliation: scan for idle sessions whose linked PR is already
 * merged or closed, and apply the terminal DB transition immediately.
 *
 * Runs after runPRBootSweep so the pull_requests table is fully populated with
 * any closed/merged PRs that exist on GitHub. Without this pass, idle sessions
 * whose PRs resolved while the server was offline remain stuck at status='idle'.
 *
 * Transitions:
 *   idle + merged PR → done  (PR merged while server was down)
 *   idle + closed PR → error (PR closed without merge while server was down)
 */
export function runBootIdleReconciliation(): void {
  const rows = getIdleSessionsWithResolvedPRs();
  if (rows.length === 0) return;

  console.log(
    `[BootIdleReconciliation] ${rows.length} idle session(s) with resolved PRs — applying terminal transitions`,
  );

  const now = Date.now();
  for (const row of rows) {
    if (row.pr_state === 'merged') {
      markSessionDone(row.session_id, now, row.pr_url);
      console.log(
        `[BootIdleReconciliation] ${row.session_id.slice(0, 8)} idle→done (PR #${row.pr_number} ${row.repo} merged)`,
      );
    } else {
      updateSessionStatus(row.session_id, 'error', now);
      console.log(
        `[BootIdleReconciliation] ${row.session_id.slice(0, 8)} idle→error (PR #${row.pr_number} ${row.repo} closed)`,
      );
    }
  }
}
