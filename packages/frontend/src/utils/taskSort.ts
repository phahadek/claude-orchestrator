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

/** Alias for sortByPriority — deterministic total-order sort with an id tiebreak. */
export const sortStable = sortByPriority;

export const STATUS_EMOJI: Record<DisplayStatus, string> = {
  needs_attention: '⚠️',
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
