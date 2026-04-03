import type { ResolvedTask } from '@claude-dashboard/backend/src/notion/types';
import type { TaskView } from '../types/taskView';

export interface TaskViewWaveResult {
  waves: TaskView[][];
  statusCounts: Record<string, number>;
  deferredCount: number;
  totalNonDeferred: number;
  doneCount: number;
}

/**
 * Computes progress bar data from a TaskView array (the REST /api/tasks/active data source).
 * Uses the pre-computed `wave` field from the backend rather than re-deriving from dependsOn.
 * Deferred tasks are excluded from the counts and wave display.
 */
export function computeProgressFromTaskViews(tasks: TaskView[]): TaskViewWaveResult {
  const DEFERRED = '⏭️ Deferred';
  const DONE = '✅ Done';

  const deferred = tasks.filter((t) => t.notionStatus === DEFERRED);
  const nonDeferred = tasks.filter((t) => t.notionStatus !== DEFERRED);

  const statusCounts: Record<string, number> = {};
  for (const t of nonDeferred) {
    statusCounts[t.notionStatus] = (statusCounts[t.notionStatus] ?? 0) + 1;
  }

  const doneCount = statusCounts[DONE] ?? 0;

  // Group non-done non-deferred tasks by their pre-computed wave number
  const nonDoneNonDeferred = nonDeferred.filter((t) => t.notionStatus !== DONE);
  const waveMap = new Map<number, TaskView[]>();
  for (const t of nonDoneNonDeferred) {
    const w = t.wave ?? 1;
    if (!waveMap.has(w)) waveMap.set(w, []);
    waveMap.get(w)!.push(t);
  }
  const waves = Array.from(waveMap.keys())
    .sort((a, b) => a - b)
    .map((w) => waveMap.get(w)!);

  return {
    waves,
    statusCounts,
    deferredCount: deferred.length,
    totalNonDeferred: nonDeferred.length,
    doneCount,
  };
}

export interface WaveResult {
  waves: ResolvedTask[][];
  statusCounts: Record<string, number>;
  deferredCount: number;
  totalNonDeferred: number;
  doneCount: number;
}

/**
 * Groups tasks into dependency waves and computes status counts.
 * Wave 1 = tasks with no deps (or all deps are Done).
 * Wave N+1 = tasks whose deps are all in waves 1..N or Done.
 * Deferred tasks are excluded from waves and progress.
 */
export function computeWaves(tasks: ResolvedTask[]): WaveResult {
  const DEFERRED = '⏭️ Deferred';
  const DONE = '✅ Done';

  const deferred = tasks.filter((t) => t.task.status === DEFERRED);
  const nonDeferred = tasks.filter((t) => t.task.status !== DEFERRED);

  // Build status counts from non-deferred tasks
  const statusCounts: Record<string, number> = {};
  for (const t of nonDeferred) {
    statusCounts[t.task.status] = (statusCounts[t.task.status] ?? 0) + 1;
  }

  const doneCount = statusCounts[DONE] ?? 0;

  // Compute waves using topological BFS
  // A task is placed in wave N+1 if all its dependsOn IDs are either:
  //   - Done (status === DONE), or
  //   - Already placed in a previous wave
  const placed = new Set<string>(); // IDs of tasks already assigned to a wave
  const doneIds = new Set(nonDeferred.filter((t) => t.task.status === DONE).map((t) => t.task.id));
  const nonDoneNonDeferred = nonDeferred.filter((t) => t.task.status !== DONE);

  const waves: ResolvedTask[][] = [];

  // Mark done tasks as placed so they don't appear in waves but satisfy deps
  for (const id of doneIds) placed.add(id);

  let remaining = [...nonDoneNonDeferred];

  while (remaining.length > 0) {
    const wave: ResolvedTask[] = [];
    const nextRemaining: ResolvedTask[] = [];

    for (const t of remaining) {
      const allDepsSatisfied = t.task.dependsOn.every((depId) => placed.has(depId) || doneIds.has(depId));
      if (allDepsSatisfied) {
        wave.push(t);
      } else {
        nextRemaining.push(t);
      }
    }

    if (wave.length === 0) {
      // Circular dep or orphaned tasks — put all remaining in a final wave
      waves.push(remaining);
      break;
    }

    for (const t of wave) placed.add(t.task.id);
    waves.push(wave);
    remaining = nextRemaining;
  }

  return {
    waves,
    statusCounts,
    deferredCount: deferred.length,
    totalNonDeferred: nonDeferred.length,
    doneCount,
  };
}
