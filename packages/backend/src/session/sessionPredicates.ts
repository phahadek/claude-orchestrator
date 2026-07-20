/**
 * Intent-named predicates over `session_type`, replacing scattered raw
 * `sessionType === '...'` comparisons across AgentSession/SessionManager/
 * sessionRecovery. Each predicate is defined once here and consumed at every
 * call site so a new session type only needs its truth value added in one
 * place.
 *
 * Session types:
 * - standard: a code session — writes code, opens a PR, moves its task to
 *   In Progress, counts against code-session concurrency.
 * - review: reviews an existing PR — no worktree branch of its own work, no
 *   PR of its own, does not touch task status.
 * - groom: deterministic backlog-grooming session — stage-only/read-only,
 *   no worktree, no PR; target task stays in Backlog (dedup via an
 *   active-session check rather than a status move).
 * - design: investigative planning session — stage-only/read-only, no
 *   worktree, no PR; target task is mechanically moved to In Progress on
 *   start, same as a standard session.
 * - ops: operational/investigation session — base profile is read + stage +
 *   the safe live-data/audited-read surface, no worktree, no PR; write
 *   capability into prod-mutating tools is earned per-session via
 *   grant-on-re-dispatch, never granted in the base profile. Shares the
 *   planning concurrency pool with groom/design rather than a dedicated cap.
 */

/** True for session types that plan (groom/design/ops): stage-only base profile, no worktree, no PR. */
export function isPlanningSession(sessionType: string): boolean {
  return (
    sessionType === 'groom' || sessionType === 'design' || sessionType === 'ops'
  );
}

/** True only for sessions that write code and open their own PR. */
export function isCodeSession(sessionType: string): boolean {
  return sessionType === 'standard';
}

/** True for session types that can open a pull request against the base branch. */
export function opensPr(sessionType: string): boolean {
  return sessionType === 'standard';
}

/** True for session types that count against the max-concurrent-code-sessions limit. */
export function countsAgainstConcurrency(sessionType: string): boolean {
  return sessionType !== 'review';
}

/** True for session types that author task status changes (e.g. Blocked/Ready on error). */
export function writesTaskStatus(sessionType: string): boolean {
  return sessionType === 'standard';
}

/** True for session types that mechanically move their target task to In Progress on start. */
export function movesTargetInProgress(sessionType: string): boolean {
  return sessionType === 'standard' || sessionType === 'design';
}
