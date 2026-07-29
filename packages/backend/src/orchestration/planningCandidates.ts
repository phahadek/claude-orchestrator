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

/**
 * Groom dep-gate: a Depends-On that is 📐 Design/📋 Planning must be ✅ Done;
 * any other-Type Depends-On must be groomed past 🔲 Backlog (at 🗂️ Ready or
 * beyond). A dependency absent from `tasksById` can't be verified as
 * cleared, so it fails the gate closed rather than assuming clearance.
 */
export function passesGroomDepGate(
  task: NotionTask,
  tasksById: Map<string, NotionTask>,
): boolean {
  for (const depId of task.dependsOn) {
    const dep = tasksById.get(depId);
    if (!dep) return false;
    const isDesignOrPlanning =
      dep.type.includes(DESIGN_TOKEN) || dep.type.includes(PLANNING_TOKEN);
    if (isDesignOrPlanning) {
      if (!dep.status.includes(DONE_TOKEN)) return false;
    } else if (dep.status.includes(BACKLOG_TOKEN)) {
      return false;
    }
  }
  return true;
}

export interface GroomCandidateDeps {
  /** Every task on the same board, keyed by id — used to read each dep's Type+Status. */
  tasksById: Map<string, NotionTask>;
  /** True when a non-terminal session already handles this task id. */
  hasActiveSession: (taskId: string) => boolean;
  /** True while this task id is within its crash-budget cooldown window. */
  inCrashCooldown: (taskId: string) => boolean;
}

/**
 * A task is a groom candidate when it's still 🔲 Backlog (any Type), no
 * non-terminal session is already handling it, it isn't within its
 * crash-budget cooldown, and every Depends-On clears the groom dep-gate.
 */
export function isGroomCandidate(
  task: NotionTask,
  deps: GroomCandidateDeps,
): boolean {
  if (!task.status.includes(BACKLOG_TOKEN)) return false;
  if (deps.hasActiveSession(task.id)) return false;
  if (deps.inCrashCooldown(task.id)) return false;
  return passesGroomDepGate(task, deps.tasksById);
}

export interface OpsCandidateDeps {
  /** Every task on the same board, keyed by id — feeds the dep-gate's status/title lookup. */
  tasksById: Map<string, NotionTask>;
  /** True when a non-terminal session already handles this task id. */
  hasActiveSession: (taskId: string) => boolean;
  /** True while this task id is within its crash-budget cooldown window. */
  inCrashCooldown: (taskId: string) => boolean;
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
 * non-terminal session already handles it, it isn't within its crash-budget
 * cooldown, and every Depends-On clears the ops dep-gate (Done + deployed).
 */
export async function isOpsCandidate(
  task: NotionTask,
  deps: OpsCandidateDeps,
): Promise<boolean> {
  if (!task.status.includes(READY_TOKEN)) return false;
  if (!isOpsEligibleType(task.type)) return false;
  if (deps.hasActiveSession(task.id)) return false;
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
  /** True when a non-terminal session already handles this task id. */
  hasActiveSession: (taskId: string) => boolean;
  /** True while this task id is within its crash-budget cooldown window. */
  inCrashCooldown: (taskId: string) => boolean;
  /** Effective getArm(milestone.id, 'design') result — design defaults off. */
  armed: boolean;
}

/**
 * A task is a design candidate when the design flow is armed, it's 🗂️ Ready
 * and a 📐 Design / 📋 Planning Type, no non-terminal session already
 * handles it, it isn't within its crash-budget cooldown, and every
 * Depends-On clears the design dep-gate.
 */
export function isDesignCandidate(
  task: NotionTask,
  deps: DesignCandidateDeps,
): boolean {
  if (!deps.armed) return false;
  if (!task.status.includes(READY_TOKEN)) return false;
  if (!isDesignEligibleType(task.type)) return false;
  if (deps.hasActiveSession(task.id)) return false;
  if (deps.inCrashCooldown(task.id)) return false;
  return passesDesignDepGate(task, deps.tasksById);
}
