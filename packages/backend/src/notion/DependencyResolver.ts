import type { NotionTask } from './types';
import type { ResolvedTask } from '../tasks/types';

/** Strip hyphens so both dashed and dashless Notion UUIDs match. */
function stripHyphens(id: string): string {
  return id.replace(/-/g, '');
}

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
