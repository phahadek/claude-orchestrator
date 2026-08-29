import { getTaskBackend } from './TaskBackend';
import { normalizeBoardId, normalizeTaskId } from './taskId';
import { resolveProjectDepStatus } from '../orchestration/DispatchTriggerEvaluator';

/** Thrown when a task id supplied by a caller doesn't resolve to an existing, live task. */
export class TaskReferenceValidationError extends Error {
  constructor(message: string) {
    super(`[taskReferenceValidation] ${message}`);
    this.name = 'TaskReferenceValidationError';
  }
}

/** Thrown when a dependsOn write would close a dependency cycle (or self-dependency). */
export class DependencyCycleError extends Error {
  constructor(public readonly cycle: readonly string[]) {
    super(
      `[taskReferenceValidation] dependsOn write rejected: would close a dependency ` +
        `cycle: ${cycle.join(' -> ')} -> ${cycle[0]}`,
    );
    this.name = 'DependencyCycleError';
  }
}

/**
 * Rejects a dependsOn write that closes a cycle back through `subjectId`
 * (self-dependency is the degenerate one-node case — a dep entry equal to
 * `subjectId` itself). `subjectId` is null for a `task.create`, which names
 * no pre-existing task to close a cycle through; in that case this instead
 * rejects the write if the declared dependencies already reach an existing
 * cycle in their own reachable closure, since attaching a brand-new task to
 * an already-cyclic subgraph leaves it just as permanently undispatchable as
 * a direct cycle would.
 *
 * Walks reverse edges via `resolveProjectDepStatus` (project-wide, backed by
 * `task_cache` board rows only — zero Notion network calls, matching the
 * no-round-trip constraint this runs under on an interactive write path). A
 * board with no cache row makes the walk down that branch inconclusive
 * rather than "no cycle" — it only stops that branch, it never grounds a
 * rejection, so an incomplete graph fails open rather than guessing.
 */
export function assertNoDependencyCycle(
  projectId: string,
  subjectId: string | null,
  dependsOn: readonly string[],
): void {
  const normalizedSubject = subjectId ? normalizeBoardId(subjectId) : null;
  const visited = new Set<string>();
  const onStack = new Set<string>();

  function dfs(nodeId: string, path: readonly string[]): string[] | null {
    const norm = normalizeBoardId(nodeId);
    if (normalizedSubject !== null && norm === normalizedSubject) {
      return [...path, nodeId];
    }
    if (onStack.has(norm)) {
      const idx = path.findIndex((id) => normalizeBoardId(id) === norm);
      return [...path.slice(idx), nodeId];
    }
    if (visited.has(norm)) return null;

    onStack.add(norm);
    let result: string[] | null = null;
    const resolution = resolveProjectDepStatus(projectId, nodeId);
    if (resolution.status === 'found') {
      for (const next of resolution.task.dependsOn) {
        result = dfs(next, [...path, nodeId]);
        if (result) break;
      }
    }
    onStack.delete(norm);
    visited.add(norm);
    return result;
  }

  for (const dep of dependsOn) {
    const rawPath = dfs(dep, []);
    if (!rawPath) continue;

    // Board rows carry bare external ids (see resolveProjectDepStatus) —
    // canonicalize every id in the reported cycle to the same prefixed form
    // `subjectId` already arrives in, so the message names ids consistently.
    if (normalizedSubject !== null && subjectId) {
      throw new DependencyCycleError(
        [subjectId, ...rawPath.slice(0, -1)].map((id) => normalizeTaskId(id)),
      );
    }
    const closingNorm = normalizeBoardId(rawPath[rawPath.length - 1]);
    const idx = rawPath.findIndex(
      (id) => normalizeBoardId(id) === closingNorm,
    );
    throw new DependencyCycleError(
      rawPath.slice(idx, rawPath.length - 1).map((id) => normalizeTaskId(id)),
    );
  }
}

/**
 * Live-existence check for a normalized task id. Always issues a live
 * backend call — never trusts a task cache row, since a row populated
 * before an archive action survives it, which would otherwise let a dead id
 * silently pass.
 *
 * Prefers `fetchTaskSummary`, which reports `archived` for backends that
 * track it (Notion) — a page that exists but is archived is rejected, not
 * treated as resolved. Falls back to the coarser `fetchTaskPage`-based
 * "some page came back" check only when the backend has no
 * `fetchTaskSummary` implementation.
 */
export async function assertTaskIdResolves(
  taskId: string,
  projectId: string,
): Promise<void> {
  const backend = getTaskBackend(projectId);

  if (typeof backend.fetchTaskSummary === 'function') {
    const summary = await backend.fetchTaskSummary(taskId).catch(() => null);
    if (summary !== null && summary.archived !== true) return;
  } else {
    try {
      const page = await backend.fetchTaskPage(taskId);
      if (page !== null && page !== undefined) return;
    } catch {
      // falls through to the rejection below
    }
  }

  throw new TaskReferenceValidationError(
    `task id "${taskId}" does not resolve to an existing task`,
  );
}
