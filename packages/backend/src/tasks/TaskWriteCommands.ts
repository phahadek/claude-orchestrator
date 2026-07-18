import type {
  TaskBackend,
  NewTaskFields,
  TaskWriteOptions,
  TaskPropertiesPatch,
} from './TaskBackend';
import type { TaskBodySections } from './bodyRender';
import { getTaskCache, deleteTaskCacheRow } from '../db/queries';
import { checkReadiness, ReadinessGateError } from './readinessGate';
import {
  checkGroomingPromotionGate,
  GroomingGateError,
} from '../groom/groomGate';
import {
  insertItem as insertGateItem,
  recordAccretionMarker,
  rehomeItemsBySourceTask as rehomeGateItems,
  type GateAccretionMarker,
} from '../gate/gateStore';
import {
  insertItem as insertSeedItem,
  recordAccretionMarker as recordSeedAccretionMarker,
  rehomeItemsBySourceTask as rehomeSeedItems,
  type SeedAccretionMarker,
} from '../seed/seedStore';
import type { GateItemClassification } from '../db/types';
import { recordEvent } from '../audit/AuditLog';
import { planMove, type MoveGraphTask } from '../orchestration/moveTask';
import { normalizeTaskId, toExternalId } from './taskId';
import { resolveMilestoneForProject } from '../projects/milestoneResolver';
import {
  toCanonicalStatus,
  isValidTransition,
  STATUS_DISPLAY,
  type TaskStatus,
} from './statusCanonical';

export { isValidTransition, STATUS_DISPLAY, type TaskStatus };

/** Reads the last-known status for a task from the task cache. */
function getCachedStatus(taskId: string): TaskStatus | null {
  const row = getTaskCache(taskId);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.raw_json) as { status?: string };
    return parsed.status ? toCanonicalStatus(parsed.status) : null;
  } catch {
    return null;
  }
}

/**
 * Canonical Type vocabulary (task-writing.md: "each task is exactly one
 * Type"). Type decides what a Ready task triggers — 💻 Code auto-dispatches;
 * 📐 Design / 🔧 Operational / 🔎 Investigation are interactive — and each
 * Type's body grammar is mutually exclusive with the others.
 */
export type TaskType =
  | '💻 Code'
  | '📐 Design'
  | '🔧 Operational'
  | '🔎 Investigation';

const TASK_TYPES: readonly TaskType[] = [
  '💻 Code',
  '📐 Design',
  '🔧 Operational',
  '🔎 Investigation',
];

function isValidTaskType(type: string): type is TaskType {
  return (TASK_TYPES as readonly string[]).includes(type);
}

/**
 * Count non-empty list items under an "Open Questions" heading in the task
 * body. Used to gate 💻 Code reclassification (a Code task must carry no
 * open / to-be-investigated items) and 🔎 Investigation reclassification (an
 * Investigation task's deliverable is the open investigation itself).
 */
function countOpenQuestions(body: string): number {
  let inSection = false;
  let count = 0;
  for (const line of body.split('\n')) {
    const heading = line.match(/^#{1,6}\s*(.+)$/);
    if (heading) {
      inSection = /open question/i.test(heading[1]);
      continue;
    }
    if (!inSection) continue;
    const trimmed = line.trim();
    if (!trimmed || /^none$/i.test(trimmed)) continue;
    if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) count++;
  }
  return count;
}

/**
 * Validate that `type` is consistent with the task body's grammar before it
 * lands. Like setStatus → Ready, setType → 💻 Code is liveness-bearing, so it
 * validates before it lands.
 */
function validateTypeBodyConsistency(type: TaskType, body: string): void {
  const openQuestions = countOpenQuestions(body);
  if (type === '💻 Code' && openQuestions > 0) {
    throw new Error(
      `[TaskWriteCommands] cannot set type to 💻 Code: task body has ${openQuestions} open/to-be-investigated item(s)`,
    );
  }
  if (type === '🔎 Investigation' && openQuestions === 0) {
    throw new Error(
      `[TaskWriteCommands] cannot set type to 🔎 Investigation: task body has no open investigation`,
    );
  }
}

const ALLOWED_PROPERTY_KEYS: readonly (keyof TaskPropertiesPatch)[] = [
  'priority',
  'title',
];

/** A milestone reference carrying the ordering info moveTask needs to pick a direction. */
export interface MoveTaskMilestoneRef {
  /** Internal DB milestone id. */
  id: string;
  displayOrder: number;
}

/** The target milestone also carries the board databaseId the new page is created under. */
export interface MoveTaskTargetMilestone extends MoveTaskMilestoneRef {
  databaseId: string;
}

/** Original task content copied onto the new page. */
export interface MoveTaskContent {
  title: string;
  sections: TaskBodySections;
  /** Display-format type, e.g. '💻 Code'. */
  type?: string;
  /** Display-format priority, e.g. '🔴 High'. */
  priority?: string;
  /** Canonical status to restore on the new page after it lands in Backlog. */
  status: TaskStatus;
}

export interface MoveTaskParams {
  taskId: string;
  content: MoveTaskContent;
  sourceMilestone: MoveTaskMilestoneRef;
  targetMilestone: MoveTaskTargetMilestone;
  originalDisposition: 'archive' | 'defer';
}

export interface MoveTaskResult {
  newTaskId: string;
  droppedEdges: { from: string; to: string }[];
  cascadeSet: string[];
}

/** The Code/Tooling task whose runtime items are being accreted onto the milestone gate. */
export interface GateContributionSourceTask {
  id: string;
  title: string;
  project: string;
  milestone: string;
}

/** One stripped runtime/launch-and-observe item to mint as a gate_item. */
export interface GateContributionItemInput {
  text: string;
}

/**
 * The classification recorded on every minted gate_item when the source task
 * has items to contribute, or the gate_accretion decision itself when it has
 * none ('none') or is exempt from the check entirely ('n/a').
 */
export type GateContributionDecision = GateItemClassification | 'none' | 'n/a';

export interface AccreteGateContributionResult {
  itemIds: string[];
  marker: GateAccretionMarker;
}

/** The Code/Tooling task whose config-change seeds are being staged onto the milestone seed store. */
export interface SeedContributionSourceTask {
  id: string;
  title: string;
  project: string;
  milestone: string;
}

/** One operational data/config seed (config-change spec) to mint as a seed_item. */
export interface SeedContributionItemInput {
  spec: string;
}

/**
 * The seed_accretion decision: 'seeds' when the source task has config-change
 * seeds to contribute, or 'none'/'n/a' when it has none or is exempt from the
 * check entirely.
 */
export type SeedContributionDecision = 'seeds' | 'none' | 'n/a';

export interface StageSeedContributionResult {
  itemIds: string[];
  marker: SeedAccretionMarker;
}

/**
 * The sanctioned write path atop the store-agnostic TaskBackend port. This is
 * the single chokepoint for validation and provenance for orchestrator-launched
 * producers — panels and sessions submit intents here rather than calling the
 * backend port directly.
 */
interface TaskWriteCommands {
  createTask(
    fields: NewTaskFields,
    options?: TaskWriteOptions,
  ): Promise<string>;
  setStatus(
    taskId: string,
    status: TaskStatus,
    options?: TaskWriteOptions,
  ): Promise<void>;
  setDependsOn(
    taskId: string,
    dependsOn: string[],
    options?: TaskWriteOptions,
  ): Promise<void>;
  updateBody(
    taskId: string,
    sections: TaskBodySections,
    options?: TaskWriteOptions,
  ): Promise<void>;
  setType(
    taskId: string,
    type: TaskType,
    options?: TaskWriteOptions,
  ): Promise<void>;
  setProperties(
    taskId: string,
    patch: TaskPropertiesPatch,
    options?: TaskWriteOptions,
  ): Promise<void>;
  archive(taskId: string, options?: TaskWriteOptions): Promise<void>;
  /**
   * Mints gate_item + gate_item_source rows for the source task's stripped
   * runtime items (min_deployed_commit left empty — filled at source-task
   * merge) and records a per-source gate_accretion marker distinguishing
   * items / none / n/a, the marker checkGroomingPromotionGate's
   * gate_contribution check reads before allowing a Ready flip.
   */
  accreteGateContribution(
    sourceTask: GateContributionSourceTask,
    items: GateContributionItemInput[],
    classification: GateContributionDecision,
  ): Promise<AccreteGateContributionResult>;
  /**
   * Mints seed_item + seed_item_source rows for the source task's
   * config-change seeds (min_deployed_commit left empty — filled at
   * source-task merge) and records a per-source seed_accretion marker
   * distinguishing seeds / none / n/a, the marker checkGroomingPromotionGate's
   * seed_contribution check reads before allowing a Ready flip.
   */
  stageSeedContribution(
    sourceTask: SeedContributionSourceTask,
    seeds: SeedContributionItemInput[],
    decision: SeedContributionDecision,
  ): Promise<StageSeedContributionResult>;
  moveTask(
    params: MoveTaskParams,
    options?: TaskWriteOptions,
  ): Promise<MoveTaskResult>;
}

export class BackendTaskWriteCommands implements TaskWriteCommands {
  constructor(
    private readonly backend: TaskBackend,
    private readonly projectId?: string,
  ) {}

  async createTask(
    fields: NewTaskFields,
    options?: TaskWriteOptions,
  ): Promise<string> {
    if (!this.backend.createTask) {
      throw new Error(
        `[TaskWriteCommands] createTask is not supported by backend type "${this.backend.type}"`,
      );
    }
    // Status is intentionally not accepted here — createTask always lands in
    // Backlog, enforced by the backend/adapter regardless of any field a
    // caller might try to pass.
    return this.backend.createTask(fields, options);
  }

  async setStatus(
    taskId: string,
    status: TaskStatus,
    options?: TaskWriteOptions,
  ): Promise<void> {
    const current = getCachedStatus(taskId);
    if (current && !isValidTransition(current, status)) {
      throw new Error(
        `[TaskWriteCommands] invalid status transition for ${taskId}: ${current} -> ${status}`,
      );
    }
    if (status === 'Ready' && options?.groomingGate) {
      const gateResult = checkGroomingPromotionGate(
        options.groomingGate,
        taskId,
      );
      if (!gateResult.allowed) {
        throw new GroomingGateError(gateResult.reasons);
      }
    }
    if (status === 'Ready') {
      const body = (await this.backend.fetchTaskPage(taskId)) ?? '';
      const violations = checkReadiness(body);
      if (violations.length > 0) {
        if (!options?.readinessOverride) {
          throw new ReadinessGateError(violations);
        }
        recordEvent({
          event_type: 'readiness_override',
          actor_type: 'human',
          actor_id: options.sessionId ?? null,
          project_id: this.projectId ?? null,
          task_id: taskId,
          payload: {
            reason: options.readinessOverride.reason,
            tiers: violations.map((v) => v.tier),
            violations,
          },
        });
      }
    }
    await this.backend.updateStatus(taskId, STATUS_DISPLAY[status], options);
  }

  async setDependsOn(
    taskId: string,
    dependsOn: string[],
    options?: TaskWriteOptions,
  ): Promise<void> {
    if (!this.backend.setDependsOn) {
      throw new Error(
        `[TaskWriteCommands] setDependsOn is not supported by backend type "${this.backend.type}"`,
      );
    }
    await this.backend.setDependsOn(taskId, dependsOn, options);
  }

  async updateBody(
    taskId: string,
    sections: TaskBodySections,
    options?: TaskWriteOptions,
  ): Promise<void> {
    if (!this.backend.updateBody) {
      throw new Error(
        `[TaskWriteCommands] updateBody is not supported by backend type "${this.backend.type}"`,
      );
    }
    await this.backend.updateBody(taskId, sections, options);
  }

  async setType(
    taskId: string,
    type: TaskType,
    options?: TaskWriteOptions,
  ): Promise<void> {
    if (!this.backend.setType) {
      throw new Error(
        `[TaskWriteCommands] setType is not supported by backend type "${this.backend.type}"`,
      );
    }
    if (!isValidTaskType(type)) {
      throw new Error(
        `[TaskWriteCommands] illegal reclassification for ${taskId}: unknown type "${type}"`,
      );
    }
    const body = await this.backend.fetchTaskPage(taskId);
    validateTypeBodyConsistency(type, body);
    await this.backend.setType(taskId, type, options);
  }

  async setProperties(
    taskId: string,
    patch: TaskPropertiesPatch,
    options?: TaskWriteOptions,
  ): Promise<void> {
    const disallowed = Object.keys(patch).filter(
      (key) =>
        !ALLOWED_PROPERTY_KEYS.includes(key as keyof TaskPropertiesPatch),
    );
    if (disallowed.length > 0) {
      throw new Error(
        `[TaskWriteCommands] setProperties does not support: ${disallowed.join(', ')} — use setStatus/setType/setDependsOn`,
      );
    }
    if (!this.backend.setProperties) {
      throw new Error(
        `[TaskWriteCommands] setProperties is not supported by backend type "${this.backend.type}"`,
      );
    }
    await this.backend.setProperties(taskId, patch, options);
  }

  async archive(taskId: string, options?: TaskWriteOptions): Promise<void> {
    if (!this.backend.archive) {
      throw new Error(
        `[TaskWriteCommands] archive is not supported by backend type "${this.backend.type}"`,
      );
    }
    await this.backend.archive(taskId, options);
  }

  /**
   * Store-only — writes gate_item/gate_item_source rows and the
   * gate_accretion marker directly via gateStore, no TaskBackend port call.
   * "none"/"n/a" mint no items (the marker alone records the decision); any
   * other classification requires at least one item and mints each as a
   * gate_item sourced to this task, with the marker recorded as "items".
   */
  async accreteGateContribution(
    sourceTask: GateContributionSourceTask,
    items: GateContributionItemInput[],
    classification: GateContributionDecision,
  ): Promise<AccreteGateContributionResult> {
    const isBareDecision =
      classification === 'none' || classification === 'n/a';
    if (isBareDecision && items.length > 0) {
      throw new Error(
        `[TaskWriteCommands] accreteGateContribution: classification "${classification}" requires an empty items array`,
      );
    }
    if (!isBareDecision && items.length === 0) {
      throw new Error(
        `[TaskWriteCommands] accreteGateContribution: at least one item is required unless classification is "none" or "n/a"`,
      );
    }

    const accretedAt = new Date().toISOString();
    const itemIds = items.map(
      (item) =>
        insertGateItem({
          project: sourceTask.project,
          milestone: sourceTask.milestone,
          text: item.text,
          classification: classification as GateItemClassification,
          sources: [
            {
              sourceTaskId: sourceTask.id,
              sourceTaskTitle: sourceTask.title,
            },
          ],
          updatedAt: accretedAt,
        }).id,
    );

    const marker: GateAccretionMarker = {
      sourceTaskId: sourceTask.id,
      project: sourceTask.project,
      milestone: sourceTask.milestone,
      decision: isBareDecision ? classification : 'items',
      accretedAt,
    };
    recordAccretionMarker(marker);

    return { itemIds, marker };
  }

  /**
   * Store-only — writes seed_item/seed_item_source rows and the
   * seed_accretion marker directly via seedStore, no TaskBackend port call.
   * "none"/"n/a" mint no items (the marker alone records the decision); a
   * "seeds" decision requires at least one seed and mints each as its own
   * seed_item sourced to this task, with the marker recorded as "seeds".
   */
  async stageSeedContribution(
    sourceTask: SeedContributionSourceTask,
    seeds: SeedContributionItemInput[],
    decision: SeedContributionDecision,
  ): Promise<StageSeedContributionResult> {
    const isBareDecision = decision === 'none' || decision === 'n/a';
    if (isBareDecision && seeds.length > 0) {
      throw new Error(
        `[TaskWriteCommands] stageSeedContribution: decision "${decision}" requires an empty seeds array`,
      );
    }
    if (!isBareDecision && seeds.length === 0) {
      throw new Error(
        `[TaskWriteCommands] stageSeedContribution: at least one seed is required unless decision is "none" or "n/a"`,
      );
    }

    const accretedAt = new Date().toISOString();
    const itemIds = seeds.map(
      (seed) =>
        insertSeedItem({
          project: sourceTask.project,
          milestone: sourceTask.milestone,
          spec: seed.spec,
          sources: [
            {
              sourceTaskId: sourceTask.id,
              sourceTaskTitle: sourceTask.title,
            },
          ],
          updatedAt: accretedAt,
        }).id,
    );

    const marker: SeedAccretionMarker = {
      sourceTaskId: sourceTask.id,
      project: sourceTask.project,
      milestone: sourceTask.milestone,
      decision,
      accretedAt,
    };
    recordSeedAccretionMarker(marker);

    return { itemIds, marker };
  }

  /**
   * Cross-milestone move — one atomic, human-applied sequence: create the
   * task on the target board, restore its original status (exempt from the
   * transition state machine but still readiness-gated for a Ready
   * restore), resolve intra-milestone Depends On edges via planMove,
   * dispose of the original (archive, or Deferred with a successor
   * pointer), write an origin back-reference on the new page, carry the
   * moved task's gate_item/seed_item accretions onto the target milestone,
   * record one task_moved audit event, and invalidate both boards'
   * task_cache.
   *
   * Depends On resolution is planned by moveTask.ts's planMove — see its
   * module doc. The accretion carry re-homes gate_item/seed_item rows
   * sourced from the original task id by UPDATE-ing their milestone;
   * min_deployed_commit is untouched (commit-based and project-scoped, not
   * milestone-scoped).
   */
  async moveTask(
    params: MoveTaskParams,
    options?: TaskWriteOptions,
  ): Promise<MoveTaskResult> {
    if (
      !this.backend.createTask ||
      !this.backend.updateBody ||
      !this.backend.setDependsOn ||
      !this.backend.archive
    ) {
      throw new Error(
        `[TaskWriteCommands] moveTask is not supported by backend type "${this.backend.type}"`,
      );
    }
    const { taskId, content, sourceMilestone, targetMilestone } = params;

    if (targetMilestone.id === sourceMilestone.id) {
      throw new Error(
        `[TaskWriteCommands] moveTask: source and target milestone are the same (${sourceMilestone.id})`,
      );
    }

    const sourceGraph: MoveGraphTask[] = (
      await this.backend.fetchReadyTasks(sourceMilestone.id, true)
    ).map((r) => ({ id: r.task.id, dependsOn: r.task.dependsOn }));

    const plan = planMove({
      taskId,
      sourceMilestoneTasks: sourceGraph,
      isLaterMove: targetMilestone.displayOrder > sourceMilestone.displayOrder,
    });

    const newTaskId = await this.backend.createTask(
      {
        databaseId: targetMilestone.databaseId,
        title: content.title,
        type: content.type,
        priority: content.priority,
        dependsOn: plan.newDependsOn,
      },
      options,
    );

    await this.backend.updateBody(newTaskId, content.sections, options);

    if (content.status !== 'Backlog') {
      await this.restoreStatus(newTaskId, content.status, options);
    }

    for (const rewrite of plan.dependentRewrites) {
      await this.backend.setDependsOn(
        rewrite.taskId,
        rewrite.dependsOn,
        options,
      );
    }

    const rehomedAt = new Date().toISOString();
    if (this.projectId) {
      const sourceTaskId = toExternalId(normalizeTaskId(taskId));
      const targetMilestoneName = resolveMilestoneForProject(
        this.projectId,
        targetMilestone.id,
      );
      rehomeGateItems(
        this.projectId,
        sourceTaskId,
        targetMilestoneName,
        rehomedAt,
      );
      rehomeSeedItems(
        this.projectId,
        sourceTaskId,
        targetMilestoneName,
        rehomedAt,
      );
    }

    if (params.originalDisposition === 'archive') {
      await this.backend.archive(taskId, options);
    } else {
      await this.restoreStatus(taskId, 'Deferred', options);
      await this.backend.appendImplementationNote(
        taskId,
        `Moved to ${newTaskId} (milestone ${targetMilestone.id}).`,
      );
    }

    await this.backend.appendImplementationNote(
      newTaskId,
      `Moved from ${taskId} (milestone ${sourceMilestone.id}).`,
    );

    recordEvent({
      event_type: 'task_moved',
      actor_type: 'human',
      actor_id: options?.sessionId ?? null,
      project_id: this.projectId ?? null,
      task_id: taskId,
      payload: {
        sourceMilestone: sourceMilestone.id,
        targetMilestone: targetMilestone.id,
        originalTaskId: taskId,
        newTaskId,
        originalDisposition: params.originalDisposition,
        droppedEdges: plan.droppedEdges,
        cascadeSet: plan.cascadeSet,
      },
    });

    deleteTaskCacheRow(`board:${sourceMilestone.id}`);
    deleteTaskCacheRow(`board:${targetMilestone.id}`);

    return {
      newTaskId,
      droppedEdges: plan.droppedEdges,
      cascadeSet: plan.cascadeSet,
    };
  }

  /**
   * Authoritative status restore — bypasses isValidTransition (the moved
   * page just landed in Backlog and the original status may not be a legal
   * transition from it), but still runs the readiness gate when restoring
   * Ready, honoring the same override + audit path as setStatus.
   */
  private async restoreStatus(
    taskId: string,
    status: TaskStatus,
    options?: TaskWriteOptions,
  ): Promise<void> {
    if (status === 'Ready') {
      const body = (await this.backend.fetchTaskPage(taskId)) ?? '';
      const violations = checkReadiness(body);
      if (violations.length > 0) {
        if (!options?.readinessOverride) {
          throw new ReadinessGateError(violations);
        }
        recordEvent({
          event_type: 'readiness_override',
          actor_type: 'human',
          actor_id: options.sessionId ?? null,
          project_id: this.projectId ?? null,
          task_id: taskId,
          payload: {
            reason: options.readinessOverride.reason,
            tiers: violations.map((v) => v.tier),
            violations,
          },
        });
      }
    }
    await this.backend.updateStatus(taskId, STATUS_DISPLAY[status], options);
  }
}
