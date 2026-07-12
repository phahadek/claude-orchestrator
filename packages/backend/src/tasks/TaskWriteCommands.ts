import type {
  TaskBackend,
  NewTaskFields,
  TaskWriteOptions,
  TaskPropertiesPatch,
} from './TaskBackend';
import type { TaskBodySections } from './bodyRender';
import { getTaskCache } from '../db/queries';
import { checkReadiness, ReadinessGateError } from './readinessGate';
import { recordEvent } from '../audit/AuditLog';

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
}
