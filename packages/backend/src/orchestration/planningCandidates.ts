import type { NotionTask } from '../notion/types';
import { isOpsEligibleType, computeOpsBlockingDeps } from '../ops/opsLoad';

/**
 * Candidate predicates for DispatchTriggerEvaluator, one per flow: a pure
 * `is<Flow>Candidate` over a task + a small deps bag, so the evaluator's scan
 * loop stays flow-agnostic. Flow-armed status ((milestone, flow) via getArm)
 * is checked by the evaluator before it even fetches a flow's candidate pool
 * — it is not re-checked per task, except for design, whose predicate also
 * takes an `armed` flag directly (see isDesignCandidate) so the arm gate is
 * independently unit-testable at the predicate level.
 */

const BACKLOG_TOKEN = 'Backlog';
const READY_TOKEN = 'Ready';
const DONE_TOKEN = 'Done';
const DESIGN_TOKEN = 'Design';
const PLANNING_TOKEN = 'Planning';
const INVESTIGATION_TOKEN = 'Investigation';
const DEFERRED_TOKEN = 'Deferred';

/**
 * Groom dep-gate: a Depends-On that is a decision-producing Type (📐 Design /
 * 📋 Planning / 🔎 Investigation) must be ✅ Done — grooming against an
 * unresolved decision means grooming against an unanswered question. Any
 * other-Type Depends-On must be groomed past 🔲 Backlog (at 🗂️ Ready or
 * beyond) and must not be ⏭️ Deferred, which blocks regardless of Type. A
 * dependency absent from `tasksById` can't be verified as cleared, so it
 * fails the gate closed rather than assuming clearance.
 */
export function passesGroomDepGate(
  task: NotionTask,
  tasksById: Map<string, NotionTask>,
): boolean {
  for (const depId of task.dependsOn) {
    const dep = tasksById.get(depId);
    if (!dep) return false;
    const isDecisionType =
      dep.type.includes(DESIGN_TOKEN) ||
      dep.type.includes(PLANNING_TOKEN) ||
      dep.type.includes(INVESTIGATION_TOKEN);
    if (isDecisionType) {
      if (!dep.status.includes(DONE_TOKEN)) return false;
    } else if (
      dep.status.includes(BACKLOG_TOKEN) ||
      dep.status.includes(DEFERRED_TOKEN)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Same per-dep Type+Status logic as passesGroomDepGate, but returns the
 * titles of the deps that fail the gate rather than a single boolean — feeds
 * the TaskView `groomDepBlockedReason` surfaced to the frontend. A dep
 * missing from `tasksById` is reported by its raw id, since there's no title
 * to show.
 */
export function groomBlockingDepTitles(
  task: NotionTask,
  tasksById: Map<string, NotionTask>,
): string[] {
  const titles: string[] = [];
  for (const depId of task.dependsOn) {
    const dep = tasksById.get(depId);
    if (!dep) {
      titles.push(depId);
      continue;
    }
    const isDecisionType =
      dep.type.includes(DESIGN_TOKEN) ||
      dep.type.includes(PLANNING_TOKEN) ||
      dep.type.includes(INVESTIGATION_TOKEN);
    if (isDecisionType) {
      if (!dep.status.includes(DONE_TOKEN)) titles.push(dep.title);
    } else if (
      dep.status.includes(BACKLOG_TOKEN) ||
      dep.status.includes(DEFERRED_TOKEN)
    ) {
      titles.push(dep.title);
    }
  }
  return titles;
}

export interface GroomCandidateDeps {
  /** Every task on the same board, keyed by id — used to read each dep's Type+Status. */
  tasksById: Map<string, NotionTask>;
  /** True when a non-terminal *standard* session already handles this task id. */
  hasActiveSession: (taskId: string) => boolean;
  /** True while this task id is within its crash-budget cooldown window. */
  inCrashCooldown: (taskId: string) => boolean;
  /**
   * True when a non-terminal (running OR parked idle) groom session already
   * handles this task id. idle is an active-but-waiting status — a parked
   * session can be resumed at any moment (pushback/decline) or driven
   * terminal directly (approve), so it blocks re-dispatch unconditionally,
   * the same as a running one; there is no idle-specific carve-out.
   */
  hasActiveGroomSession: (taskId: string) => boolean;
  /**
   * True while the task's most recent planning.noOp is a still-standing
   * committed decision ("nothing about this task needs a decision right
   * now") — a deliberate choice to leave the task at Backlog, not an
   * oversight, so auto-dispatch must not immediately override it. Derived
   * from the committed intent, not the staging session's status: it holds
   * after that session goes terminal. An operator-initiated groom launch
   * doesn't go through isGroomCandidate at all, so it's never blocked by
   * this. See isGroomNoOpSuppressed in db/queries.ts.
   */
  isNoOpSuppressed: (taskId: string) => boolean;
}

/**
 * A task is a groom candidate when it's still 🔲 Backlog (any Type), no
 * non-terminal standard session is already handling it, no non-terminal
 * (running or parked idle) groom session already handles it, it isn't
 * within its crash-budget cooldown, its most recent planning.noOp (if any)
 * isn't a still-standing committed suppression, and every Depends-On clears
 * the groom dep-gate.
 */
export function isGroomCandidate(
  task: NotionTask,
  deps: GroomCandidateDeps,
): boolean {
  if (!task.status.includes(BACKLOG_TOKEN)) return false;
  if (deps.hasActiveSession(task.id)) return false;
  if (deps.hasActiveGroomSession(task.id)) return false;
  if (deps.inCrashCooldown(task.id)) return false;
  if (deps.isNoOpSuppressed(task.id)) return false;
  return passesGroomDepGate(task, deps.tasksById);
}

export interface OpsCandidateDeps {
  /** Every task on the same board, keyed by id — feeds the dep-gate's status/title lookup. */
  tasksById: Map<string, NotionTask>;
  /** True when a non-terminal *standard* session already handles this task id. */
  hasActiveSession: (taskId: string) => boolean;
  /** True while this task id is within its crash-budget cooldown window. */
  inCrashCooldown: (taskId: string) => boolean;
  /**
   * True when a non-terminal (running or parked idle) ops session already
   * handles this task id. Unlike groom, ops has no undispositioned-intent
   * nuance: a done gate-verify session is already excluded (it's terminal,
   * see isGateVerifySession), so a fresh re-verify is never suppressed.
   */
  hasActiveOpsSession: (taskId: string) => boolean;
  /** Project id the dep-gate's deploy check runs against (getProjectDeployedSha). */
  projectId: string;
}

/**
 * Ops dep-gate: every Depends-On must resolve ✅ Done AND have its merge
 * commit deployed. Reuses opsLoad's blockingDepsFor (via the exported
 * computeOpsBlockingDeps) rather than reimplementing it — ops tasks run
 * against live/prod state, so a merged-but-undeployed dep must still block,
 * same as the /ops loader's own classification loop. Uses the fast
 * (local-branches-only) merge-commit lookup since this predicate runs on
 * every scan tick, not on a human-triggered load.
 */
export async function passesOpsDepGate(
  task: NotionTask,
  tasksById: Map<string, NotionTask>,
  projectId: string,
): Promise<boolean> {
  const allTasks = [...tasksById.values()].map((t) => ({
    id: t.id,
    status: t.status,
    title: t.title,
  }));
  const result = await computeOpsBlockingDeps(
    allTasks,
    [{ id: task.id, dependsOn: task.dependsOn }],
    projectId,
    { fast: true },
  );
  const info = result.get(task.id);
  return !info || info.blockingDepIds.length === 0;
}

/**
 * A task is an ops candidate when it's 🗂️ Ready and a 🔧 Operational /
 * 🔎 Investigation / 🧪 Testing Type (per opsLoad's isOpsEligibleType), no
 * non-terminal standard or ops session already handles it, it isn't within
 * its crash-budget cooldown, and every Depends-On clears the ops dep-gate
 * (Done + deployed).
 */
export async function isOpsCandidate(
  task: NotionTask,
  deps: OpsCandidateDeps,
): Promise<boolean> {
  if (!task.status.includes(READY_TOKEN)) return false;
  if (!isOpsEligibleType(task.type)) return false;
  if (deps.hasActiveSession(task.id)) return false;
  if (deps.hasActiveOpsSession(task.id)) return false;
  if (deps.inCrashCooldown(task.id)) return false;
  return passesOpsDepGate(task, deps.tasksById, deps.projectId);
}

/** True for a Type value the design flow dispatches: 📐 Design or 📋 Planning. */
function isDesignEligibleType(type: string): boolean {
  return type.includes(DESIGN_TOKEN) || type.includes(PLANNING_TOKEN);
}

/**
 * Design dep-gate: every Depends-On must be ✅ Done (any Type) — unlike the
 * ops dep-gate, design work isn't run against live/prod state, so there's no
 * deploy check here. A dependency absent from `tasksById` fails the gate
 * closed, mirroring passesGroomDepGate.
 */
export function passesDesignDepGate(
  task: NotionTask,
  tasksById: Map<string, NotionTask>,
): boolean {
  for (const depId of task.dependsOn) {
    const dep = tasksById.get(depId);
    if (!dep) return false;
    if (!dep.status.includes(DONE_TOKEN)) return false;
  }
  return true;
}

export interface DesignCandidateDeps {
  /** Every task on the same board, keyed by id — used to read each dep's Type+Status. */
  tasksById: Map<string, NotionTask>;
  /** True when a non-terminal *standard* session already handles this task id. */
  hasActiveSession: (taskId: string) => boolean;
  /** True while this task id is within its crash-budget cooldown window. */
  inCrashCooldown: (taskId: string) => boolean;
  /**
   * True when a non-terminal (running or parked idle) design session
   * already handles this task id. Design has its own terminal lifecycle
   * (PlanningOrchestrator.markTerminal closes the task via
   * completeDesignTask on a natural terminal) rather than groom's
   * undispositioned-intent hold, so a plain non-terminal check is its own
   * eligibility rule rather than reusing groom's.
   */
  hasActiveDesignSession: (taskId: string) => boolean;
  /** Effective getArm(milestone.id, 'design') result — design defaults off. */
  armed: boolean;
}

/**
 * A task is a design candidate when the design flow is armed, it's 🗂️ Ready
 * and a 📐 Design / 📋 Planning Type, no non-terminal standard or design
 * session already handles it, it isn't within its crash-budget cooldown,
 * and every Depends-On clears the design dep-gate.
 */
export function isDesignCandidate(
  task: NotionTask,
  deps: DesignCandidateDeps,
): boolean {
  if (!deps.armed) return false;
  if (!task.status.includes(READY_TOKEN)) return false;
  if (!isDesignEligibleType(task.type)) return false;
  if (deps.hasActiveSession(task.id)) return false;
  if (deps.hasActiveDesignSession(task.id)) return false;
  if (deps.inCrashCooldown(task.id)) return false;
  return passesDesignDepGate(task, deps.tasksById);
}
