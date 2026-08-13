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
 *   the safe live-data/audited-read surface; write capability into
 *   prod-mutating tools is earned per-session via grant-on-re-dispatch,
 *   never granted in the base profile. Unlike groom/design/split/docs it
 *   gets a real per-session worktree + branch (see usesWorktree) and can
 *   open its own PR (see opensPr) once an operator-approved PR-intent
 *   declaration earns it the PR-open tool grant — that PR is routed into
 *   the standard auto-review path rather than forced human_merge_only.
 *   Shares the planning concurrency pool with groom/design rather than a
 *   dedicated cap; target task is mechanically moved to In Progress on
 *   start, like design.
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
 *   false for it. Whether it gets a worktree + branch depends on its task's
 *   declared Target surface: a repo-file surface gets one (same as ops), a
 *   Notion-page surface (or an undeclared one) does not — see usesWorktree.
 * - depth_review: a second, separate review pass dispatched only after a
 *   PR's conformance verdict (session type 'review') reaches approved —
 *   judges security/concurrency/reliability/data-integrity/size-
 *   proportionality beyond spec-conformance. Same operational shape as
 *   'review': no worktree branch of its own work, no PR of its own, does
 *   not touch task status, excluded from code-session concurrency
 *   accounting. Gets its own restricted tool allowlist (no git-push, no
 *   GitHub write-MCP) — see getSessionAllowedTools.
 */

import { isRepoFileTargetSurface } from '../docs/targetSurface';

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

/**
 * The canonical set of planning session types — the single source of truth
 * isPlanningSession is built from. Anything that needs a SQL `IN` list of
 * planning types (e.g. db/queries.ts's ranked_planning CTE and
 * hasNonTerminalPlanningSessionForTask) must derive it from this constant
 * rather than restating it, so the two enumerations cannot drift apart.
 */
export const PLANNING_SESSION_TYPES: readonly SessionType[] = [
  'groom',
  'design',
  'ops',
  'split',
  'docs',
] as const;

/** True for session types that plan (groom/design/ops/split/docs): stage-only base profile, no worktree, no PR. */
export function isPlanningSession(sessionType: string): boolean {
  return (PLANNING_SESSION_TYPES as readonly string[]).includes(sessionType);
}

/** True only for sessions that write code and open their own PR. */
export function isCodeSession(sessionType: string): boolean {
  return sessionType === 'standard';
}

/**
 * True for session types that get a real per-session git worktree + branch,
 * as opposed to running directly against the shared project checkout
 * (cwd === projectDir, no branch of their own). Split out of
 * isPlanningSession so 'ops' can gain a worktree while staying in the
 * planning concurrency pool and keeping its stage-only base tool profile —
 * see the 'ops' entry in the session-types doc comment above.
 *
 * `docsTargetSurface` is the dispatched Docs task's declared Target surface
 * (see docs/targetSurface.ts) — a repo-file surface gets a worktree, same as
 * 'ops'; a Notion-page surface, or an undeclared one, does not. Omitted (or
 * called with a non-'docs' sessionType) has no effect on any other type.
 */
export function usesWorktree(
  sessionType: string,
  docsTargetSurface?: string,
): boolean {
  if (sessionType === 'standard' || sessionType === 'ops') return true;
  if (sessionType === 'docs') {
    return isRepoFileTargetSurface(docsTargetSurface ?? '');
  }
  return false;
}

/** True for session types that can open a pull request against the base branch. */
export function opensPr(sessionType: string): boolean {
  return (
    sessionType === 'standard' ||
    sessionType === 'docs' ||
    sessionType === 'ops'
  );
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

const CODE_TASK_TYPE = /code/i;
const DESIGN_OR_PLANNING_TASK_TYPE = /design|planning/i;
const OPS_ELIGIBLE_TASK_TYPE = /operational|investigation|testing/i;
const DOCS_OR_ASSETS_TASK_TYPE = /docs|assets/i;

/**
 * True when `sessionType` is a session dispatchable against a task whose
 * Notion Type is `taskType` — the guard PR #1069's now-removed opsLaunch.ts
 * lacked (it defaulted an unspecified sessionType to 'standard' with zero
 * Type validation). Tolerant of the emoji being stripped from `taskType`,
 * matching the style of opsLoad.ts's opsTypeMatcher/isOpsEligibleType.
 *
 * Per procedures.md's Task types table:
 * - standard: 💻 Code only.
 * - design: 📐 Design / 📋 Planning only.
 * - ops: 🔧 Operational / 🔎 Investigation / 🧪 Testing (mirrors
 *   isOpsEligibleType in ops/opsLoad.ts).
 * - docs: 📝 Docs / 🎨 Assets only.
 * - groom: type-agnostic — /groom brings every Type to 🗂️ Ready.
 * - review / depth_review: type-agnostic — these review an existing PR, not
 *   a task Type.
 * - split: type-agnostic — narrows whatever task groomFlip.ts nominated,
 *   regardless of its Type.
 */
export function isTaskTypeCompatibleWithSessionType(
  taskType: string,
  sessionType: string,
): boolean {
  switch (sessionType) {
    case 'standard':
      return CODE_TASK_TYPE.test(taskType);
    case 'design':
      return DESIGN_OR_PLANNING_TASK_TYPE.test(taskType);
    case 'ops':
      return OPS_ELIGIBLE_TASK_TYPE.test(taskType);
    case 'docs':
      return DOCS_OR_ASSETS_TASK_TYPE.test(taskType);
    case 'groom':
    case 'review':
    case 'depth_review':
    case 'split':
      return true;
    default:
      return false;
  }
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

/**
 * True for an investigate session — a one-shot 'ops' session dispatched
 * against a synthetic `report-batch:<batchId>` task_id rather than a real
 * board task, always batched (even for a single report). No new SessionType
 * literal is added for investigate — 'ops' is reused and this task_id-prefix
 * predicate mirrors isGateVerifySession's own pattern above.
 */
export function isInvestigateSession(
  taskId: string | null | undefined,
): boolean {
  return typeof taskId === 'string' && taskId.startsWith('report-batch:');
}
