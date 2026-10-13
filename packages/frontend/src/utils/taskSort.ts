import type { DisplayStatus, TaskView } from '../types/taskView';

const PRIORITY_RANK: Record<string, number> = {
  '🔴 High': 0,
  '🟡 Medium': 1,
  '🟢 Low': 2,
};

export function priorityRank(p: string): number {
  return PRIORITY_RANK[p] ?? 99;
}

/**
 * Returns a new array sorted by priority (High → Medium → Low → unset), with a
 * stable id tiebreak so equal-priority items keep a deterministic order across
 * re-fetches instead of whatever order the input happened to arrive in.
 */
export function sortByPriority<T extends TaskView>(tasks: T[]): T[] {
  return [...tasks].sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      a.taskId.localeCompare(b.taskId),
  );
}

function compareSortKey(
  a: (number | string)[],
  b: (number | string)[],
): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Sorts by the backend's execution-rank sortKey (dispatch order). Tasks without
 * a sortKey go after ranked ones, ordered by assigned priority then id.
 */
export function sortByExecutionRank<T extends TaskView>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    const ka = a.executionRank?.sortKey;
    const kb = b.executionRank?.sortKey;
    if (ka && kb) {
      const d = compareSortKey(ka, kb);
      if (d !== 0) return d;
    } else if (ka) return -1;
    else if (kb) return 1;
    return (
      priorityRank(a.priority) - priorityRank(b.priority) ||
      a.taskId.localeCompare(b.taskId)
    );
  });
}

export type CodeCategory = 'in_progress' | 'ready' | 'backlog' | 'done';

/** Code-panel category, keyed on Notion status (not displayStatus) except merged-PR Done. */
export function codeCategory(task: TaskView): CodeCategory {
  if (task.displayStatus === 'done') return 'done';
  const s = task.notionStatus;
  if (s.includes('In Progress') || s.includes('In Review'))
    return 'in_progress';
  if (s.includes('Ready')) return 'ready';
  if (s.includes('Backlog') || s.includes('Blocked')) return 'backlog';
  switch (task.displayStatus) {
    case 'ready':
      return 'ready';
    case 'backlog':
    case 'blocked':
    case 'deferred':
      return 'backlog';
    default:
      return 'in_progress';
  }
}

export const STATUS_EMOJI: Record<DisplayStatus, string> = {
  needs_attention: '⚠️',
  auto_recovering: '🔁',
  ready_to_merge: '✅',
  in_progress: '🔄',
  in_review: '👀',
  ready: '🗂️',
  done: '✔️',
  backlog: '🔲',
  blocked: '🚫',
  deferred: '⏭️',
};

/** Strips emoji/whitespace from a Type label (e.g. "📐 Design") for use as a stable test id / key. */
export function typeSlug(type: string): string {
  return type.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}
