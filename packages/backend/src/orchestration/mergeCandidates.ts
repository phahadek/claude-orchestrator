/**
 * Merge-candidate detection: a deterministic scope-overlap signal that
 * nominates pairs of non-Done milestone tasks as merge candidates.
 *
 * Pure and deterministic — no I/O, no Notion/backend calls, no LLM judgment.
 * Operates on each task's `## Files / paths affected` regions (from
 * codeWorklist.ts's resolveTaskRegions). Two steps:
 *
 *  1. Hub-file exclusion: files touched by more than `hubFrequencyCutoff` of
 *     the milestone's non-Done tasks are dropped before measuring overlap —
 *     otherwise a file every task happens to touch (e.g. a shared types
 *     module) would trip every pair.
 *  2. Containment ratio: over the hub-excluded file sets, a pair trips when
 *     sharedFiles / min(|A|, |B|) >= containmentThreshold. This is
 *     containment, not Jaccard — a small task fully contained in a larger
 *     task's scope is exactly the "these look like the same task" shape this
 *     signal targets.
 *
 * Shared packages are advisory context only, not part of the trip condition
 * — package granularity is too coarse to be a scope-overlap signal on its
 * own (see task spec). Title / acceptance-criteria semantics are out of
 * scope; this is a file-overlap heuristic, not a similarity judgment.
 *
 * Candidates are symmetric pairwise nominations, { taskIds, reason } — this
 * module computes no survivor. Advisory and operator-confirmed: a caller
 * surfaces candidates for confirmation, then passes a confirmed pair to
 * mergeSession.ts's planMerge as its mergeSet. Never auto-merged.
 */

const DONE_STATUSES = new Set(['✅ Done', '⏭️ Deferred']);

/** Default fraction of milestone tasks a file may appear in before being excluded as a hub file. */
const DEFAULT_HUB_FREQUENCY_CUTOFF = 0.25;
/** Default minimum containment ratio (sharedFiles / min(|A|, |B|)) to trip a candidate. */
const DEFAULT_CONTAINMENT_THRESHOLD = 0.5;

interface TaskRegionsInput {
  /** Coarse package paths this task's declared scope resolves to (advisory only). */
  packages: string[];
  /** Deduped, repo-validated file tokens declared in the task's scope text. */
  files: string[];
}

export interface MergeCandidateTaskInput {
  id: string;
  status: string;
  regions: TaskRegionsInput;
}

export interface MergeCandidate {
  taskIds: [string, string];
  reason: string;
}

export interface MergeCandidateOptions {
  /** Fraction of milestone tasks a file may appear in before being excluded as a hub file. */
  hubFrequencyCutoff?: number;
  /** Minimum containment ratio to trip a candidate. */
  containmentThreshold?: number;
}

/**
 * Compute the set of hub files: files present in more than
 * `hubFrequencyCutoff` of the given tasks. Presence is per-task (a file
 * counted once per task, regardless of how many tokens resolved to it).
 */
function computeHubFiles(
  tasks: MergeCandidateTaskInput[],
  hubFrequencyCutoff: number,
): Set<string> {
  const fileTaskCount = new Map<string, number>();
  for (const task of tasks) {
    for (const file of new Set(task.regions.files)) {
      fileTaskCount.set(file, (fileTaskCount.get(file) ?? 0) + 1);
    }
  }
  const hubFiles = new Set<string>();
  const total = tasks.length;
  for (const [file, count] of fileTaskCount) {
    if (count / total > hubFrequencyCutoff) hubFiles.add(file);
  }
  return hubFiles;
}

/**
 * Compute pairwise merge candidates for every non-Done task in `tasks`,
 * from each task's declared `## Files / paths affected` regions.
 */
export function computeMergeCandidates(
  tasks: MergeCandidateTaskInput[],
  options: MergeCandidateOptions = {},
): MergeCandidate[] {
  const hubFrequencyCutoff =
    options.hubFrequencyCutoff ?? DEFAULT_HUB_FREQUENCY_CUTOFF;
  const containmentThreshold =
    options.containmentThreshold ?? DEFAULT_CONTAINMENT_THRESHOLD;

  const activeTasks = tasks.filter((t) => !DONE_STATUSES.has(t.status));
  if (activeTasks.length < 2) return [];

  const hubFiles = computeHubFiles(activeTasks, hubFrequencyCutoff);

  const filteredFilesById = new Map<string, Set<string>>();
  for (const task of activeTasks) {
    filteredFilesById.set(
      task.id,
      new Set(task.regions.files.filter((f) => !hubFiles.has(f))),
    );
  }

  const candidates: MergeCandidate[] = [];
  for (let i = 0; i < activeTasks.length; i++) {
    for (let j = i + 1; j < activeTasks.length; j++) {
      const a = activeTasks[i];
      const b = activeTasks[j];
      const filesA = filteredFilesById.get(a.id)!;
      const filesB = filteredFilesById.get(b.id)!;
      if (filesA.size === 0 || filesB.size === 0) continue;

      const sharedFiles = [...filesA].filter((f) => filesB.has(f)).sort();
      if (!sharedFiles.length) continue;

      const ratio = sharedFiles.length / Math.min(filesA.size, filesB.size);
      if (ratio < containmentThreshold) continue;

      const [firstId, secondId] = [a.id, b.id].sort();
      candidates.push({
        taskIds: [firstId, secondId],
        reason: `shared file(s): ${sharedFiles.join(', ')} (containment ${ratio.toFixed(2)})`,
      });
    }
  }

  return candidates.sort(
    (x, y) =>
      x.taskIds[0].localeCompare(y.taskIds[0]) ||
      x.taskIds[1].localeCompare(y.taskIds[1]),
  );
}
