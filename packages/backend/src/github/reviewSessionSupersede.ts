import {
  getPRByNumber,
  getSession,
  markSessionSuperseded,
  TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED,
} from '../db/queries';
import type { SessionManager } from '../session/SessionManager';

/**
 * Terminalize the review session a PR's review_session_id pointer is about
 * to abandon — either replaced by a fresh spawn (incomingSessionId set) or
 * cleared with nothing to replace it (incomingSessionId undefined). Kept in
 * its own module (rather than inline in PRReviewService, which pulls in a
 * much larger import graph) so both PRReviewService's own spawn/clear sites
 * and StalledPRReconciler's clearReviewSessionId site can call it without
 * either importing the other.
 *
 * Re-reads the PR row rather than trusting a caller-held value, so it also
 * catches a session set concurrently with the caller's own read. No-ops
 * when there is nothing to supersede: no prior id, the prior id is the one
 * about to be set, or the prior session is already terminal
 * (done/error/killed/superseded) — see archiveConcludedSessionsOlderThan's
 * doc comment (db/queries.ts) for why that reaper routes through
 * TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED to still archive these.
 */
export function supersedeReviewSession(
  sessionManager: Pick<SessionManager, 'endSession'>,
  prNumber: number,
  repo: string,
  reason: string,
  incomingSessionId?: string,
): void {
  const pr = getPRByNumber(prNumber, repo);
  const prev = pr?.review_session_id;
  if (!prev || prev === incomingSessionId) return;
  const session = getSession(prev);
  if (
    !session ||
    TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED.has(session.status)
  ) {
    return;
  }
  // markSessionSuperseded first: SessionManager.endSession() refuses to
  // touch a session whose DB row isn't already terminal (see its doc
  // comment), and 'superseded' only became a status endSession() accepts
  // once its own guard was widened to TERMINAL_SESSION_STATUSES_WITH_SUPERSEDED
  // (see SessionManager.ts) — calling endSession() first would find the row
  // still idle/running and no-op, leaking the live subprocess under the new
  // 'superseded' label instead of actually tearing it down.
  markSessionSuperseded(prev, Date.now(), reason);
  sessionManager.endSession(prev);
}
