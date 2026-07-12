/**
 * Merge-session planning: given an operator-nominated survivor and
 * merged-away task set, compute the command-layer staged intents that stage
 * a merge for human apply — union the survivor, archive the merged-away
 * tasks, and re-point every inbound Depends On at the survivor.
 *
 * Pure and deterministic — no I/O, no Notion/backend calls. Detection
 * (finding candidate merge sets) is out of scope; this module only composes
 * the intents once an operator has nominated a survivor + merged-away set.
 *
 * The load-bearing step is the inbound-dependent rewrite: an archived task
 * never completes, so any dependent still pointing at a merged-away task
 * would block forever without this rewiring.
 */

import type { TaskBodySections } from '../tasks/bodyRender';

/** Minimal task shape needed to compute inbound Depends On references. */
export interface MergeGraphTask {
  id: string;
  dependsOn: string[];
}

/** A task being merged, carrying the content needed to compose the survivor's union. */
export interface MergeTaskContent extends MergeGraphTask {
  sections: TaskBodySections;
  /** Display-format priority, e.g. '🔴 High'. */
  priority?: string;
}

export interface MergePlanInput {
  /**
   * The full milestone task set (id + declared Depends On), used to find
   * every inbound dependent of the merged-away tasks. Must include the
   * merge-set tasks themselves.
   */
  milestoneTasks: MergeGraphTask[];
  /** The tasks being merged (survivor + merged-away), with body content for the union. */
  mergeSet: MergeTaskContent[];
  /**
   * Operator-nominated survivor task ID. When omitted, defaults to the
   * mergeSet task with the most inbound Depends On references (ties broken
   * by richer history — longer body — then by ID for determinism).
   */
  survivorId?: string;
}

interface SetPropertiesPayload {
  taskId: string;
  patch: { priority?: string };
}
interface UpdateBodyPayload {
  taskId: string;
  sections: TaskBodySections;
}
interface ArchivePayload {
  taskId: string;
}
interface SetDependsOnPayload {
  taskId: string;
  dependsOn: string[];
}

export type MergeStagedIntent =
  | { kind: 'task.updateBody'; payload: UpdateBodyPayload }
  | { kind: 'task.setProperties'; payload: SetPropertiesPayload }
  | { kind: 'task.archive'; payload: ArchivePayload }
  | { kind: 'task.setDependsOn'; payload: SetDependsOnPayload };

export interface MergePlan {
  survivorId: string;
  mergedAwayIds: string[];
  intents: MergeStagedIntent[];
}

/** Strip hyphens so both dashed and dashless Notion UUIDs match. */
function stripHyphens(id: string): string {
  return id.replace(/-/g, '');
}

function bodyLength(sections: TaskBodySections): number {
  const contextLength = sections.context.reduce(
    (sum, block) => sum + block.text.length,
    0,
  );
  return (
    sections.summary.length +
    contextLength +
    sections.automatedCriteria.join('').length +
    sections.manualCriteria.join('').length
  );
}

const PRIORITY_RANK: Record<string, number> = {
  '🔴 High': 3,
  '🟡 Medium': 2,
  '🟢 Low': 1,
};

/** Highest-ranked priority among the given values, or undefined if none are set. */
function highestPriority(priorities: (string | undefined)[]): string | undefined {
  let best: string | undefined;
  let bestRank = -1;
  for (const p of priorities) {
    if (!p) continue;
    const rank = PRIORITY_RANK[p] ?? 0;
    if (rank > bestRank) {
      best = p;
      bestRank = rank;
    }
  }
  return best;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

/**
 * Default survivor selection: the mergeSet task with the most inbound
 * Depends On references (from the full milestone task set). Ties broken by
 * richer history (longer body), then by ID for determinism.
 */
function pickDefaultSurvivor(
  mergeSet: MergeTaskContent[],
  milestoneTasks: MergeGraphTask[],
): string {
  const inboundCounts = new Map<string, number>();
  for (const task of mergeSet) {
    const normId = stripHyphens(task.id);
    let count = 0;
    for (const other of milestoneTasks) {
      if (other.id === task.id) continue;
      if (other.dependsOn.some((dep) => stripHyphens(dep) === normId)) count++;
    }
    inboundCounts.set(task.id, count);
  }

  return [...mergeSet].sort((a, b) => {
    const countDiff =
      (inboundCounts.get(b.id) ?? 0) - (inboundCounts.get(a.id) ?? 0);
    if (countDiff !== 0) return countDiff;
    const lengthDiff = bodyLength(b.sections) - bodyLength(a.sections);
    if (lengthDiff !== 0) return lengthDiff;
    return a.id.localeCompare(b.id);
  })[0].id;
}

/** Union the body sections of every task in the merge set. */
function unionSections(tasks: MergeTaskContent[]): TaskBodySections {
  const summary = dedupe(tasks.map((t) => t.sections.summary.trim())).join(
    '\n\n',
  );
  const dependencies = dedupe(tasks.flatMap((t) => t.sections.dependencies));
  const context = tasks.flatMap((t) => t.sections.context);
  const automatedCriteria = dedupe(
    tasks.flatMap((t) => t.sections.automatedCriteria),
  );
  const manualCriteria = dedupe(tasks.flatMap((t) => t.sections.manualCriteria));
  const filesAffected = dedupe(
    tasks.flatMap((t) => t.sections.filesAffected ?? []),
  ).sort();
  const notionPagesAffected = dedupe(
    tasks.flatMap((t) => t.sections.notionPagesAffected ?? []),
  ).sort();

  const sections: TaskBodySections = {
    summary,
    dependencies,
    context,
    automatedCriteria,
    manualCriteria,
  };
  if (filesAffected.length) sections.filesAffected = filesAffected;
  if (notionPagesAffected.length) sections.notionPagesAffected = notionPagesAffected;
  return sections;
}

/**
 * Compose the staged intents for a merge: survivor union (updateBody +
 * setProperties), archive of each merged-away task, and setDependsOn on
 * every dependent that referenced a merged-away task — re-pointed at the
 * survivor with no dangling reference left behind.
 */
export function planMerge(input: MergePlanInput): MergePlan {
  const { milestoneTasks, mergeSet } = input;
  if (mergeSet.length < 2) {
    throw new Error('[planMerge] mergeSet must contain at least two tasks');
  }

  const mergeSetIds = new Set(mergeSet.map((t) => t.id));
  if (input.survivorId !== undefined && !mergeSetIds.has(input.survivorId)) {
    throw new Error(
      `[planMerge] survivorId "${input.survivorId}" is not a member of the merge set`,
    );
  }

  const survivorId =
    input.survivorId ?? pickDefaultSurvivor(mergeSet, milestoneTasks);
  const mergedAwayIds = mergeSet
    .map((t) => t.id)
    .filter((id) => id !== survivorId)
    .sort();
  const mergedAwayNormIds = new Set(mergedAwayIds.map(stripHyphens));

  const unionedSections = unionSections(mergeSet);
  const unionedPriority = highestPriority(mergeSet.map((t) => t.priority));

  const intents: MergeStagedIntent[] = [];

  intents.push({
    kind: 'task.updateBody',
    payload: { taskId: survivorId, sections: unionedSections },
  });
  if (unionedPriority) {
    intents.push({
      kind: 'task.setProperties',
      payload: { taskId: survivorId, patch: { priority: unionedPriority } },
    });
  }

  for (const id of mergedAwayIds) {
    intents.push({ kind: 'task.archive', payload: { taskId: id } });
  }

  const rewrites = milestoneTasks
    .filter((task) => !mergeSetIds.has(task.id))
    .filter((task) =>
      task.dependsOn.some((dep) => mergedAwayNormIds.has(stripHyphens(dep))),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const dependent of rewrites) {
    const rewritten = dependent.dependsOn.map((dep) =>
      mergedAwayNormIds.has(stripHyphens(dep)) ? survivorId : dep,
    );
    const deduped = dedupe(rewritten);
    intents.push({
      kind: 'task.setDependsOn',
      payload: { taskId: dependent.id, dependsOn: deduped },
    });
  }

  return { survivorId, mergedAwayIds, intents };
}
