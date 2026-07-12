/**
 * Milestone dependency-candidate graph service.
 *
 * Computes, per non-Done milestone task, a deterministic set of dependency
 * *candidates* — never auto-wired Depends On edges. A per-task grooming
 * session confirms candidates against the hard-block-vs-soft-order test and
 * writes Depends On itself; this service only surfaces what to check.
 *
 * Two sources feed the candidate set, unioned:
 *  - region overlap: two tasks' declared `## Files / paths affected` regions
 *    (packages or files, from codeWorklist.ts's resolveTaskRegions) share a
 *    package or a file.
 *  - declared dependencies: edges already present in the task's own Depends
 *    On list (so grooming sessions see the full candidate picture, not just
 *    the deterministic-inference half).
 *
 * Region overlap is only as strong as `## Files / paths affected`, itself a
 * grooming output — a task with no parseable regions (typical for raw
 * 🔲 Backlog tasks that haven't been groomed yet) yields no overlap
 * candidates. That is expected, not an error; see the module doc for
 * groomLoad.ts and the task spec's "known limitation" note.
 */

const DONE_STATUSES = new Set(['✅ Done', '⏭️ Deferred']);

export interface TaskRegionsInput {
  /** Coarse package paths this task's declared scope resolves to. */
  packages: string[];
  /** Deduped, repo-validated file tokens declared in the task's scope text. */
  files: string[];
}

export interface MilestoneDependencyGraphTaskInput {
  id: string;
  status: string;
  /** Raw Depends On page/task IDs, as declared on the task (verbatim). */
  dependsOn: string[];
  regions: TaskRegionsInput;
}

export interface CandidateBlocker {
  taskId: string;
  reason: string;
}

export interface TaskDependencyCandidates {
  taskId: string;
  candidateBlockers: CandidateBlocker[];
  /** The task's own declared Depends On, returned verbatim. */
  declaredDeps: string[];
}

/** Strip hyphens so both dashed and dashless Notion UUIDs match. */
function stripHyphens(id: string): string {
  return id.replace(/-/g, '');
}

function intersect(a: string[], b: string[]): string[] {
  const bSet = new Set(b);
  return [...new Set(a)].filter((x) => bSet.has(x)).sort();
}

function buildReason(
  declared: boolean,
  sharedPackages: string[],
  sharedFiles: string[],
): string {
  const parts: string[] = [];
  if (declared) parts.push('declared dependency');
  if (sharedPackages.length)
    parts.push(`shared package(s): ${sharedPackages.join(', ')}`);
  if (sharedFiles.length)
    parts.push(`shared file(s): ${sharedFiles.join(', ')}`);
  return parts.join('; ');
}

/**
 * Compute the dependency-candidate set for every non-Done task in `tasks`.
 * Pure and deterministic — no I/O. Done/Deferred tasks are excluded both as
 * candidate subjects and as candidate blockers (a satisfied dependency isn't
 * a candidate to confirm).
 */
export function computeMilestoneDependencyCandidates(
  tasks: MilestoneDependencyGraphTaskInput[],
): TaskDependencyCandidates[] {
  const activeTasks = tasks.filter((t) => !DONE_STATUSES.has(t.status));
  const byNormId = new Map(
    activeTasks.map((t) => [stripHyphens(t.id), t] as const),
  );

  return activeTasks.map((task) => {
    const declaredNormIds = new Set(task.dependsOn.map(stripHyphens));
    const candidatesByNormId = new Map<string, CandidateBlocker>();

    for (const other of activeTasks) {
      if (other.id === task.id) continue;
      const otherNormId = stripHyphens(other.id);
      const declared =
        declaredNormIds.has(otherNormId) && byNormId.has(otherNormId);
      const sharedPackages = intersect(
        task.regions.packages,
        other.regions.packages,
      );
      const sharedFiles = intersect(task.regions.files, other.regions.files);
      if (!declared && !sharedPackages.length && !sharedFiles.length)
        continue;
      candidatesByNormId.set(otherNormId, {
        taskId: other.id,
        reason: buildReason(declared, sharedPackages, sharedFiles),
      });
    }

    return {
      taskId: task.id,
      candidateBlockers: [...candidatesByNormId.values()].sort((a, b) =>
        a.taskId.localeCompare(b.taskId),
      ),
      declaredDeps: [...task.dependsOn],
    };
  });
}
