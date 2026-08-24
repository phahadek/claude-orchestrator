/**
 * One-off backfill: derives sessions.terminal_completion_reason for
 * historical killed sessions from their session_errored audit payload.
 *
 * terminal_completion_reason was only ever written by
 * setSessionTerminalCompletionReason's two historical call sites — it is
 * NULL for effectively every session that predates this task's stop-path
 * writes (markSessionDone/markSessionErrored/markSessionSuperseded/
 * abortSession, see db/queries.ts and session/SessionManager.ts). For a
 * killed session, the audit_log 'session_errored' row recorded at the time
 * (payload: { sessionId, status, reason }, see SessionManager.ts's
 * markSessionErrored/flagResumeFailure) is the only durable record of why —
 * this backfill recovers it where that row exists. Sessions with no
 * session_errored row at all (recorded separately as unattributable) are
 * skipped, not guessed at.
 *
 * Run manually: npx ts-node packages/backend/scripts/backfill-terminal-completion-reason.ts
 */
import { db } from '../src/db/db';
import { setSessionTerminalCompletionReason } from '../src/db/queries';

export interface KilledSessionMissingReason {
  session_id: string;
}

/** Killed sessions with no terminal_completion_reason recorded yet. */
export function getKilledSessionsMissingTerminalCompletionReason(): KilledSessionMissingReason[] {
  return db
    .prepare(
      `SELECT session_id FROM sessions
       WHERE status = 'killed' AND terminal_completion_reason IS NULL`,
    )
    .all() as KilledSessionMissingReason[];
}

/**
 * The reason field from the most recent session_errored audit row for the
 * given session, if one exists. Returns undefined when no such row exists
 * or its payload has no reason (matches session_errored's payload shape at
 * SessionManager.ts:1497/3166).
 */
export function getLatestSessionErroredReason(
  sessionId: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT payload FROM audit_log
       WHERE event_type = 'session_errored' AND actor_id = ?
       ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .get(sessionId) as { payload: string } | undefined;
  if (!row) return undefined;
  try {
    const payload = JSON.parse(row.payload) as { reason?: string };
    return payload.reason;
  } catch {
    return undefined;
  }
}

export interface BackfillTerminalCompletionReasonSummary {
  backfilled: number;
  skippedNoAuditRow: number;
}

/** Runs the backfill against every killed session missing a reason. */
export function backfillTerminalCompletionReason(): BackfillTerminalCompletionReasonSummary {
  const sessions = getKilledSessionsMissingTerminalCompletionReason();

  let backfilled = 0;
  let skippedNoAuditRow = 0;
  for (const { session_id } of sessions) {
    const reason = getLatestSessionErroredReason(session_id);
    if (!reason) {
      skippedNoAuditRow++;
      continue;
    }
    setSessionTerminalCompletionReason(session_id, reason);
    backfilled++;
  }

  return { backfilled, skippedNoAuditRow };
}

if (require.main === module) {
  const summary = backfillTerminalCompletionReason();
  // eslint-disable-next-line no-console
  console.log(
    `[backfill-terminal-completion-reason] backfilled=${summary.backfilled} ` +
      `skippedNoAuditRow=${summary.skippedNoAuditRow}`,
  );
}
