import type { DisplayStatus, TaskView } from '../types/taskView';

const PRIORITY_RANK: Record<string, number> = {
  '🔴 High': 0,
  '🟡 Medium': 1,
  '🟢 Low': 2,
};

export function priorityRank(p: string): number {
  return PRIORITY_RANK[p] ?? 99;
}

/** Returns a new array sorted by priority (High → Medium → Low → unset). */
export function sortByPriority<T extends TaskView>(tasks: T[]): T[] {
  return [...tasks].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
  );
}

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
