import { NotionTask, ResolvedTask } from './types';

/** Strip hyphens so both dashed and dashless Notion UUIDs match. */
function stripHyphens(id: string): string {
  return id.replace(/-/g, '');
}

export class DependencyResolver {
  resolve(tasks: NotionTask[]): ResolvedTask[] {
    // Key by dashless ID so deps stored without hyphens still match page IDs with hyphens
    const byId = new Map(tasks.map((t) => [stripHyphens(t.id), t]));

    return tasks.map((task) => {
      const blockers = this.findBlockers(task, byId, new Set());
      return {
        task,
        blocked: blockers.length > 0,
        blockers,
        nonCode: task.type === '📋 Planning' || task.type === '🧪 Testing',
      };
    });
  }

  private findBlockers(
    task: NotionTask,
    byId: Map<string, NotionTask>,
    visited: Set<string>
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
