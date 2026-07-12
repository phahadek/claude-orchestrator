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
 * edges, then performs the actual create/restore/rewrite/dispose sequence.
 *
 * Accretion carry (re-homing gate_contribution / seed_contribution across
 * milestones) is explicitly excised — see task 39b22f91-52f3-81c3.
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

export interface DroppedEdge {
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
 * Validate the source milestone graph before planning a move: every declared
 * Depends On must resolve within the graph, and the graph must be acyclic.
 * Both are "malformed / unresolvable dependency trees" and refuse the move.
 */
function validateGraph(tasks: MoveGraphTask[]): void {
  const byId = new Map(tasks.map((t) => [stripHyphens(t.id), t]));

  for (const task of tasks) {
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

  for (const task of tasks) visit(task.id, []);
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

  validateGraph(sourceMilestoneTasks);

  const normTaskId = stripHyphens(taskId);

  if (isLaterMove) {
    const droppedEdges: DroppedEdge[] = moved.dependsOn.map((dep) => ({
      from: taskId,
      to: dep,
    }));

    const cascadeSet = transitiveInboundDependents(
      taskId,
      sourceMilestoneTasks,
    );
    const cascadeIds = new Set(cascadeSet);

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
