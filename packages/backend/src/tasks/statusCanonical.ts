/**
 * Canonical task-write status vocabulary. Display strings (emoji-prefixed,
 * as stored in Notion's Status select) are derived via STATUS_DISPLAY —
 * callers of this module always use the plain canonical name.
 *
 * This module is dependency-free by design — it is imported directly by
 * frontend code (see TaskMoveDialog.tsx) and must never pull in Node
 * built-ins or backend runtime modules (db/*, better-sqlite3, etc).
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

export function toCanonicalStatus(display: string): TaskStatus | null {
  for (const status of Object.keys(STATUS_DISPLAY) as TaskStatus[]) {
    if (STATUS_DISPLAY[status] === display) return status;
  }
  return null;
}
