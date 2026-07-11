import type { TaskBackend, NewTaskFields, TaskWriteOptions } from './TaskBackend';
import { getTaskCache } from '../db/queries';

/**
 * Canonical task-write status vocabulary. Display strings (emoji-prefixed,
 * as stored in Notion's Status select) are derived via STATUS_DISPLAY —
 * callers of this module always use the plain canonical name.
 */
export type TaskStatus =
  | 'Backlog'
  | 'Ready'
  | 'In Progress'
  | 'In Review'
  | 'Blocked'
  | 'Deferred'
  | 'Done';

export const STATUS_DISPLAY: Record<TaskStatus, string> = {
  Backlog: '🔲 Backlog',
  Ready: '🗂️ Ready',
  'In Progress': '🔄 In Progress',
  'In Review': '👀 In Review',
  Blocked: '🚫 Blocked',
  Deferred: '⏭️ Deferred',
  Done: '✅ Done',
};

/**
 * Allowed status transitions. Done is terminal — a merged/closed task is not
 * reopened through this path. Every other status can retreat to Backlog so a
 * task can always be pulled back for rework.
 */
const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  Backlog: new Set(['Ready', 'Deferred']),
  Ready: new Set(['Backlog', 'In Progress', 'Deferred', 'Blocked']),
  'In Progress': new Set(['In Review', 'Blocked', 'Backlog', 'Deferred']),
  'In Review': new Set(['Done', 'In Progress', 'Blocked']),
  Blocked: new Set(['Backlog', 'Ready', 'In Progress', 'Deferred']),
  Deferred: new Set(['Backlog', 'Ready']),
  Done: new Set(),
};

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

function toCanonicalStatus(display: string): TaskStatus | null {
  for (const status of Object.keys(STATUS_DISPLAY) as TaskStatus[]) {
    if (STATUS_DISPLAY[status] === display) return status;
  }
  return null;
}

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
 * The sanctioned write path atop the store-agnostic TaskBackend port. This is
 * the single chokepoint for validation and provenance for orchestrator-launched
 * producers — panels and sessions submit intents here rather than calling the
 * backend port directly.
 */
export interface TaskWriteCommands {
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
}

export class BackendTaskWriteCommands implements TaskWriteCommands {
  constructor(private readonly backend: TaskBackend) {}

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
}
