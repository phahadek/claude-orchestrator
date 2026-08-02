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
 *   planning concurrency pool with groom/design rather than a dedicated cap;
 *   target task is mechanically moved to In Progress on start, like design.
 * - split: the dedicated split session — the "route" half of the split
 *   detect -> confirm -> route flow (see split/splitCandidate.ts,
 *   split/splitSession.ts). Dispatched by groomFlip.ts on a confirmed
 *   split_now nomination; stage-only/read-only, no worktree, no PR, same as
 *   groom — the target task stays put (it isn't archived/moved, only
 *   narrowed via a staged task.updateBody) while its siblings are staged as
 *   new task.create intents for human apply.
 * - docs: documentation-authoring planning session — shares the planning
 *   concurrency pool, target task is mechanically moved to In Progress on
 *   start like design/ops, but unlike them it can open its own PR; every PR
 *   it opens is forced human_merge_only (see AgentSession.handlePRDetected)
 *   since its injected procedure — not buildOrchestratorClaudeMd's
 *   code-session lifecycle — governs its PR timing, so isCodeSession stays
 *   false for it.
 * - depth_review: a second, separate review pass dispatched only after a
 *   PR's conformance verdict (session type 'review') reaches approved —
 *   judges security/concurrency/reliability/data-integrity/size-
 *   proportionality beyond spec-conformance. Same operational shape as
 *   'review': no worktree branch of its own work, no PR of its own, does
 *   not touch task status, excluded from code-session concurrency
 *   accounting. Gets its own restricted tool allowlist (no git-push, no
 *   GitHub write-MCP) — see getSessionAllowedTools.
 */

/**
 * The closed set of session types. Anywhere a new type is added, every
 * exhaustive switch over this union (e.g. sessionDidWork in
 * session/sessionLifecycle.ts) must gain a matching branch or the build
 * fails — see the `const _exhaustive: never = ...` pattern used there and in
 * ws/router.ts.
 */
export type SessionType =
  | 'standard'
  | 'review'
  | 'groom'
  | 'design'
  | 'ops'
  | 'split'
  | 'docs'
  | 'depth_review';

/** True for session types that plan (groom/design/ops/split): stage-only base profile, no worktree, no PR. */
export function isPlanningSession(sessionType: string): boolean {
  return (
    sessionType === 'groom' ||
    sessionType === 'design' ||
    sessionType === 'ops' ||
    sessionType === 'split' ||
    sessionType === 'docs'
  );
}

/** True only for sessions that write code and open their own PR. */
export function isCodeSession(sessionType: string): boolean {
  return sessionType === 'standard';
}

/** True for session types that can open a pull request against the base branch. */
export function opensPr(sessionType: string): boolean {
  return sessionType === 'standard' || sessionType === 'docs';
}

/** True for session types that count against the shared code+planning concurrency accounting (excludes review/depth_review). */
export function countsAgainstConcurrency(sessionType: string): boolean {
  return sessionType !== 'review' && sessionType !== 'depth_review';
}

/**
 * True for session types that count against the max-concurrent-code-sessions
 * cap specifically — excludes both review sessions and planning session
 * types (groom/design/ops/split), which draw from their own separate
 * concurrency pool (see max_concurrent_planning_sessions). This is the one
 * predicate the code-session admission check and the orphan-resume budget
 * must both use so they cannot drift onto different counts.
 */
export function countsAgainstCodeSessionConcurrency(
  sessionType: string,
): boolean {
  return (
    countsAgainstConcurrency(sessionType) && !isPlanningSession(sessionType)
  );
}

/** True for session types that author task status changes (e.g. Blocked/Ready on error). */
export function writesTaskStatus(sessionType: string): boolean {
  return sessionType === 'standard';
}

/** True for session types that mechanically move their target task to In Progress on start. */
export function movesTargetInProgress(sessionType: string): boolean {
  return (
    sessionType === 'standard' ||
    sessionType === 'design' ||
    sessionType === 'ops' ||
    sessionType === 'docs'
  );
}

/**
 * True for a gate-item verification session — a one-shot 'ops' session
 * dispatched by SessionGateItemVerifier (task_id `gate-item:<id>`). Unlike
 * parked groom/design/ops planning sessions, it has no resume purpose once
 * it has reported its disposition: a re-verify is a fresh session, not a
 * resume of this one, so it should conclude done/archived rather than park
 * idle.
 */
export function isGateVerifySession(
  taskId: string | null | undefined,
): boolean {
  return typeof taskId === 'string' && taskId.startsWith('gate-item:');
}
