/**
 * Cross-milestone move planning: given the task being moved and the source
 * milestone's full task graph, compute how the intra-milestone Depends On
 * edges must be resolved so the move stays consistent with the milestone
 * ordering invariant (milestones strictly ordered; a later-milestone task
 * assumes all earlier ones complete).
 *
 * Pure and deterministic — no I/O, no Notion/backend calls, mirroring
 * mergeSession.ts. The caller (TaskWriteCommands.moveTask) fetches the
 * source milestone's task graph, calls planMove to resolve dependency
 * edges, then performs the actual create/restore/rewrite/dispose sequence,
 * including the gate_item/seed_item accretion carry (re-homing rows sourced
 * from the moved task onto the target milestone via gateStore/seedStore).
 */

/** Minimal task shape needed to resolve Depends On edges. */
export interface MoveGraphTask {
  id: string;
  dependsOn: string[];
}

export interface MovePlanInput {
  /** The task being moved. Must be present in sourceMilestoneTasks. */
  taskId: string;
  /**
   * The full source milestone task set (id + declared Depends On), used to
   * resolve inbound/outbound edges. Must include the moved task itself.
   */
  sourceMilestoneTasks: MoveGraphTask[];
  /**
   * True when the target milestone comes after the source milestone in
   * strict execution order (a "later move"); false for an "earlier move".
   */
  isLaterMove: boolean;
}

interface DroppedEdge {
  from: string;
  to: string;
}

export interface MovePlan {
  /**
   * Depends On to set on the new (moved) page. Always [] — a later move's
   * own deps are satisfied by milestone order; an earlier move is refused
   * outright when the moved task carries any outbound deps.
   */
  newDependsOn: string[];
  /**
   * Source-milestone tasks whose Depends On must be rewritten to drop their
   * direct edge to the moved task.
   */
  dependentRewrites: { taskId: string; dependsOn: string[] }[];
  /** Every edge dropped as part of the move, for the audit payload. */
  droppedEdges: DroppedEdge[];
  /**
   * Transitive inbound-dependent closure of the moved task within the
   * source milestone, for the audit payload. Empty for an earlier move.
   */
  cascadeSet: string[];
}

/** Thrown when a move cannot be planned — refused outbound deps or a malformed graph. */
export class MoveTaskError extends Error {}

/** Strip hyphens so both dashed and dashless Notion UUIDs match. */
function stripHyphens(id: string): string {
  return id.replace(/-/g, '');
}

/**
 * Validate only the part of the source milestone graph that the move
 * actually touches: the moved task itself (its own dependency subtree, used
 * for cascade / refusal analysis) plus the tasks whose Depends On edges are
 * inspected or rewritten by planMove (the cascade set for a later move, the
 * direct dependents for an earlier move).
 *
 * Dangling Depends On entries on tasks OUTSIDE that relevant set are
 * pre-existing data issues unrelated to this move and must not block it —
 * only edges belonging to relevant tasks are required to resolve, and only
 * cycles reachable from relevant tasks abort the move.
 */
function validateGraph(tasks: MoveGraphTask[], relevantIds: Set<string>): void {
  const byId = new Map(tasks.map((t) => [stripHyphens(t.id), t]));

  for (const task of tasks) {
    if (!relevantIds.has(stripHyphens(task.id))) continue;
    for (const dep of task.dependsOn) {
      if (!byId.has(stripHyphens(dep))) {
        throw new MoveTaskError(
          `[planMove] task "${task.id}" depends on unresolvable task "${dep}"`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string, path: string[]): void {
    const norm = stripHyphens(id);
    if (visited.has(norm)) return;
    if (visiting.has(norm)) {
      throw new MoveTaskError(
        `[planMove] dependency cycle detected: ${[...path, id].join(' -> ')}`,
      );
    }
    visiting.add(norm);
    const node = byId.get(norm);
    if (node) {
      for (const dep of node.dependsOn) visit(dep, [...path, id]);
    }
    visiting.delete(norm);
    visited.add(norm);
  }

  for (const norm of relevantIds) {
    const task = byId.get(norm);
    if (task) visit(task.id, []);
  }
}

/**
 * Transitive closure of every task that depends — directly or indirectly —
 * on `taskId`, within the given graph. Sorted for determinism.
 */
function transitiveInboundDependents(
  taskId: string,
  tasks: MoveGraphTask[],
): string[] {
  const normTarget = stripHyphens(taskId);
  const inbound = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      const normDep = stripHyphens(dep);
      const existing = inbound.get(normDep);
      if (existing) existing.push(task.id);
      else inbound.set(normDep, [task.id]);
    }
  }

  const seen = new Set<string>([normTarget]);
  const result: string[] = [];
  const queue = [...(inbound.get(normTarget) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const norm = stripHyphens(id);
    if (seen.has(norm)) continue;
    seen.add(norm);
    result.push(id);
    for (const next of inbound.get(norm) ?? []) queue.push(next);
  }
  return result.sort();
}

/**
 * Plan the intra-milestone dependency resolution for a cross-milestone move:
 *
 * - Later move: the moved task's own deps are dropped (implicitly satisfied
 *   by milestone order); every task in the transitive inbound-dependent
 *   cascade set has its direct edge to the moved task dropped too, since
 *   those dependents can no longer assume the moved task completes before
 *   they do.
 * - Earlier move: refused outright when the moved task carries any outbound
 *   deps (named in the error) — those deps are still in the source
 *   milestone, now scheduled after the moved task. Otherwise, every direct
 *   inbound edge to the moved task is dropped (the dependency is now
 *   implicit via milestone order, since the target milestone precedes the
 *   dependents' milestone).
 */
export function planMove(input: MovePlanInput): MovePlan {
  const { taskId, sourceMilestoneTasks, isLaterMove } = input;

  const moved = sourceMilestoneTasks.find((t) => t.id === taskId);
  if (!moved) {
    throw new MoveTaskError(
      `[planMove] task "${taskId}" not found in the source milestone task set`,
    );
  }

  const normTaskId = stripHyphens(taskId);

  if (isLaterMove) {
    const cascadeSet = transitiveInboundDependents(
      taskId,
      sourceMilestoneTasks,
    );
    const cascadeIds = new Set(cascadeSet);

    validateGraph(
      sourceMilestoneTasks,
      new Set([normTaskId, ...cascadeSet.map(stripHyphens)]),
    );

    const droppedEdges: DroppedEdge[] = moved.dependsOn.map((dep) => ({
      from: taskId,
      to: dep,
    }));

    const dependentRewrites: { taskId: string; dependsOn: string[] }[] = [];
    for (const task of sourceMilestoneTasks) {
      if (!cascadeIds.has(task.id)) continue;
      const hasDirectEdge = task.dependsOn.some(
        (dep) => stripHyphens(dep) === normTaskId,
      );
      if (!hasDirectEdge) continue;
      droppedEdges.push({ from: task.id, to: taskId });
      dependentRewrites.push({
        taskId: task.id,
        dependsOn: task.dependsOn.filter(
          (dep) => stripHyphens(dep) !== normTaskId,
        ),
      });
    }

    return { newDependsOn: [], dependentRewrites, droppedEdges, cascadeSet };
  }

  // Earlier move.
  if (moved.dependsOn.length > 0) {
    throw new MoveTaskError(
      `[planMove] cannot move "${taskId}" to an earlier milestone: it has outbound dependencies on ${moved.dependsOn.join(', ')}`,
    );
  }

  const directDependents = sourceMilestoneTasks.filter(
    (task) =>
      task.id !== taskId &&
      task.dependsOn.some((dep) => stripHyphens(dep) === normTaskId),
  );

  validateGraph(
    sourceMilestoneTasks,
    new Set([normTaskId, ...directDependents.map((t) => stripHyphens(t.id))]),
  );

  const dependentRewrites = directDependents.map((task) => ({
    taskId: task.id,
    dependsOn: task.dependsOn.filter((dep) => stripHyphens(dep) !== normTaskId),
  }));
  const droppedEdges = directDependents.map((task) => ({
    from: task.id,
    to: taskId,
  }));

  return { newDependsOn: [], dependentRewrites, droppedEdges, cascadeSet: [] };
}
