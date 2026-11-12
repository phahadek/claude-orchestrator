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

interface TaskRegionsInput {
  /** Coarse package paths this task's declared scope resolves to. */
  packages: string[];
  /** Deduped, repo-validated file tokens declared in the task's scope text. */
  files: string[];
}

export interface MilestoneDependencyGraphTaskInput {
  id: string;
  title?: string;
  type?: string;
  status: string;
  /** Task ids named in this task's own body, verbatim. */
  mentionedTaskIds?: string[];
  /** Raw Depends On page/task IDs, as declared on the task (verbatim). */
  dependsOn: string[];
  regions: TaskRegionsInput;
}

interface CandidateBlocker {
  taskId: string;
  reason: string;
  title?: string;
  type?: string;
  status?: string;
}

/** A task staged (task.create) in the same group or batch but not yet filed — it has no real id yet. */
export interface StagedSiblingInput {
  /** The `staged-intent:<id>` placeholder id. */
  id: string;
  title: string;
  type?: string;
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
  mentioned: boolean,
  sharedPackages: string[],
  sharedFiles: string[],
): string {
  const parts: string[] = [];
  if (declared) parts.push('declared dependency');
  if (mentioned) parts.push('named in task body');
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
  stagedSiblings: StagedSiblingInput[] = [],
): TaskDependencyCandidates[] {
  const activeTasks = tasks.filter((t) => !DONE_STATUSES.has(t.status));
  const byNormId = new Map(
    activeTasks.map((t) => [stripHyphens(t.id), t] as const),
  );

  return activeTasks.map((task) => {
    const declaredNormIds = new Set(task.dependsOn.map(stripHyphens));
    const mentionedNormIds = new Set(
      (task.mentionedTaskIds ?? []).map(stripHyphens),
    );
    const candidatesByNormId = new Map<string, CandidateBlocker>();
    const rankByNormId = new Map<string, number>();

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
      const mentioned = mentionedNormIds.has(otherNormId);
      if (
        !declared &&
        !mentioned &&
        !sharedPackages.length &&
        !sharedFiles.length
      )
        continue;
      candidatesByNormId.set(otherNormId, {
        taskId: other.id,
        reason: buildReason(declared, mentioned, sharedPackages, sharedFiles),
        title: other.title,
        type: other.type,
        status: other.status,
      });
      rankByNormId.set(
        otherNormId,
        declared ? 0 : sharedFiles.length ? 1 : mentioned ? 2 : 3,
      );
    }

    for (const sibling of stagedSiblings) {
      const siblingNormId = stripHyphens(sibling.id);
      if (siblingNormId === stripHyphens(task.id)) continue;
      candidatesByNormId.set(siblingNormId, {
        taskId: sibling.id,
        reason: 'sibling staged in the same group or batch',
        title: sibling.title,
        type: sibling.type,
        status: 'staged (not yet filed)',
      });
      rankByNormId.set(siblingNormId, 4);
    }

    return {
      taskId: task.id,
      candidateBlockers: [...candidatesByNormId.entries()]
        .sort(
          ([aKey, a], [bKey, b]) =>
            (rankByNormId.get(aKey) ?? 9) - (rankByNormId.get(bKey) ?? 9) ||
            a.taskId.localeCompare(b.taskId),
        )
        .map(([, c]) => c),
      declaredDeps: [...task.dependsOn],
    };
  });
}
