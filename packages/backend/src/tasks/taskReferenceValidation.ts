import { getTaskBackend } from './TaskBackend';

/** Thrown when a task id supplied by a caller doesn't resolve to an existing, live task. */
export class TaskReferenceValidationError extends Error {
  constructor(message: string) {
    super(`[taskReferenceValidation] ${message}`);
    this.name = 'TaskReferenceValidationError';
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
