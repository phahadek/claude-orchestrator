import type { NotionTask } from './types';
import type { ResolvedTask } from '../tasks/types';
import { normalizeBoardId } from '../tasks/taskId';

/** Strip hyphens so both dashed and dashless Notion UUIDs match. */
function stripHyphens(id: string): string {
  return id.replace(/-/g, '');
}

/**
 * Statuses a dependent can't be silently wedged out of — it's already done,
 * or it isn't going anywhere itself, so surfacing it as a stranded dependent
 * would be noise.
 */
const TERMINAL_DEPENDENT_STATUSES = new Set(['✅ Done', '⏭️ Deferred']);

export class DependencyResolver {
  resolve(
    tasks: NotionTask[],
    source: ResolvedTask['source'] = 'notion',
  ): ResolvedTask[] {
    // Key by dashless ID so deps stored without hyphens still match page IDs with hyphens
    const byId = new Map(tasks.map((t) => [stripHyphens(t.id), t]));
    const waveCache = new Map<string, number>();

    return tasks.map((task) => {
      const blockers = this.findBlockers(task, byId, new Set());
      const wave = this.computeWave(task, byId, waveCache);
      return {
        task,
        source,
        blocked: blockers.length > 0,
        blockers,
        nonCode:
          task.type === '📋 Planning' ||
          task.type === '🧪 Testing' ||
          task.type === '🚦 Gate',
        wave,
      };
    });
  }

  /**
   * Compute the dispatch wave for a task.
   * Wave 1 = no unmet dependencies (immediately launchable).
   * Wave N = max wave of unmet dependencies + 1.
   */
  private computeWave(
    task: NotionTask,
    byId: Map<string, NotionTask>,
    cache: Map<string, number>,
  ): number {
    const normId = stripHyphens(task.id);
    if (cache.has(normId)) return cache.get(normId)!;

    // Temporarily mark as wave 1 to break cycles
    cache.set(normId, 1);

    let maxDepWave = 0;
    for (const depId of task.dependsOn) {
      const dep = byId.get(stripHyphens(depId));
      if (!dep || dep.status === '✅ Done') continue; // satisfied deps don't affect wave
      const depWave = this.computeWave(dep, byId, cache);
      if (depWave > maxDepWave) maxDepWave = depWave;
    }

    const wave = maxDepWave + 1;
    cache.set(normId, wave);
    return wave;
  }

  /**
   * Reverse of findBlockers: every task in `tasks` whose Depends On names
   * `taskId`, excluding taskId itself and dependents already at a terminal
   * status. Used to surface who gets silently wedged when a task is moved to
   * a permanently-unsatisfiable status (⏭️ Deferred) — the blocking predicate
   * in findBlockers/computeWave is unchanged; this only adds visibility.
   *
   * Ids compare via normalizeBoardId, which strips the `source:` prefix and
   * hyphenation on both sides, so a `notion:`-prefixed dependsOn entry still
   * matches a bare-uuid task id and vice versa.
   */
  findDependents<T extends Pick<NotionTask, 'id' | 'status' | 'dependsOn'>>(
    taskId: string,
    tasks: T[],
  ): T[] {
    const normTarget = normalizeBoardId(taskId);
    return tasks.filter((t) => {
      if (normalizeBoardId(t.id) === normTarget) return false;
      if (TERMINAL_DEPENDENT_STATUSES.has(t.status)) return false;
      return t.dependsOn.some(
        (depId) => normalizeBoardId(depId) === normTarget,
      );
    });
  }

  private findBlockers(
    task: NotionTask,
    byId: Map<string, NotionTask>,
    visited: Set<string>,
  ): NotionTask[] {
    const normId = stripHyphens(task.id);
    if (visited.has(normId)) return []; // cycle guard
    visited.add(normId);

    const blockers: NotionTask[] = [];
    for (const depId of task.dependsOn) {
      const dep = byId.get(stripHyphens(depId));
      if (!dep) continue; // dependency outside this board — treat as satisfied
      if (dep.status !== '✅ Done') {
        blockers.push(dep);
        // recurse — a blocker's own blockers are also blockers
        blockers.push(...this.findBlockers(dep, byId, visited));
      }
    }
    return blockers;
  }
}
