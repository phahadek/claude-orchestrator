import type { NotionTask } from '../notion/types';

/**
 * Candidate predicates for DispatchTriggerEvaluator, one per flow. Only the
 * groom predicate is implemented here — ops/design predicates land in the
 * sibling task and are expected to follow the same shape (a pure `is<Flow>Candidate`
 * over a task + a small deps bag, so the evaluator's scan loop stays flow-agnostic).
 * Flow-armed status ((milestone, flow) via getArm) is checked by the evaluator
 * before it even fetches a flow's candidate pool — it is not re-checked per task.
 */

const BACKLOG_TOKEN = 'Backlog';
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
