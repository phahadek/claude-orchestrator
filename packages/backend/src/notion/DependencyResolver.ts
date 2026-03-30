import { NotionTask, ResolvedTask } from './types';

export class DependencyResolver {
  resolve(tasks: NotionTask[]): ResolvedTask[] {
    const byId = new Map(tasks.map((t) => [t.id, t]));

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
    if (visited.has(task.id)) return []; // cycle guard
    visited.add(task.id);

    const blockers: NotionTask[] = [];
    for (const depId of task.dependsOn) {
      const dep = byId.get(depId);
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
