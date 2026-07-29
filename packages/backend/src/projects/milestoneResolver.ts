import { ProjectService } from './ProjectService';
import type { ProjectMilestone } from './ProjectService';
import { getTaskCache } from '../db/queries';
import { normalizeTaskId } from '../tasks/taskId';
import type { NotionTask } from '../notion/types';

/**
 * Thrown when a milestone reference doesn't resolve to exactly one known
 * milestone — the guard against the mis-key class of bug where a UUID (or
 * any other non-canonical value) silently spawns a shadow gate/seed
 * key-space instead of erroring.
 */
export class UnknownMilestoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownMilestoneError';
  }
}

/** The canonical short-form key for a milestone — its stored canonical_short_id, falling back to its full name. */
export function canonicalMilestoneKey(milestone: {
  name: string;
  canonicalShortId?: string | null;
}): string {
  return milestone.canonicalShortId ?? milestone.name;
}

function findMilestone<
  M extends { id: string; name: string; canonicalShortId?: string | null },
>(milestones: M[], milestone: string): M | undefined {
  return milestones.find(
    (m) =>
      m.id === milestone ||
      m.name === milestone ||
      canonicalMilestoneKey(m).toLowerCase() === milestone.toLowerCase(),
  );
}

/**
 * Resolves a milestone reference — its canonical short-form key (e.g. "M11"),
 * its full display name, or its DB id — to the canonical short-form key that
 * gate_item/seed_item key on, scoped to one project. Throws
 * UnknownMilestoneError for anything else (a UUID from a different
 * key-space, a typo, an unrelated string).
 */
export function resolveMilestoneForProject(
  projectId: string,
  milestone: string,
): string {
  const project = ProjectService.getById(projectId);
  if (!project) {
    throw new UnknownMilestoneError(`unknown project "${projectId}"`);
  }
  const match = findMilestone(project.milestones, milestone);
  if (!match) {
    const known = project.milestones.map((m) => m.name).join(', ');
    throw new UnknownMilestoneError(
      `"${milestone}" is not a known milestone for project "${projectId}"` +
        (known
          ? ` — expected one of: ${known}`
          : ' — project has no milestones configured'),
    );
  }
  return canonicalMilestoneKey(match);
}

/**
 * Resolves a milestone reference (its DB id, display name, or canonical
 * short-form key) to the board's raw Notion database ID — the same
 * resolution the move path already gets for free via
 * MoveTaskTargetMilestone.databaseId, made available to the create path so a
 * caller only ever supplies a milestone reference, never a raw Notion id.
 * Throws UnknownMilestoneError (not an opaque Notion parent error) for an
 * unresolvable milestone or one with no source_id configured.
 */
export function resolveMilestoneDatabaseId(
  projectId: string,
  milestone: string,
): string {
  const project = ProjectService.getById(projectId);
  if (!project) {
    throw new UnknownMilestoneError(`unknown project "${projectId}"`);
  }
  const match = findMilestone(project.milestones, milestone);
  if (!match) {
    const known = project.milestones.map((m) => m.name).join(', ');
    throw new UnknownMilestoneError(
      `"${milestone}" is not a known milestone for project "${projectId}"` +
        (known
          ? ` — expected one of: ${known}`
          : ' — project has no milestones configured'),
    );
  }
  if (!match.sourceId) {
    throw new UnknownMilestoneError(
      `milestone "${milestone}" (project "${projectId}") has no source_id — ` +
        "set it to the board's Notion database ID before creating tasks under it",
    );
  }
  return match.sourceId;
}

/**
 * Resolves a milestone reference to its full milestones row — the
 * convergence read-surface's single resolution point (task-writing §
 * "skill-first scoping of an orchestrator surface"): gate/seed/ops key on
 * canonical_short_id, the task axis on source_id, and both need the row.
 */
export function resolveMilestoneRowForProject(
  projectId: string,
  milestone: string,
): ProjectMilestone {
  const project = ProjectService.getById(projectId);
  if (!project) {
    throw new UnknownMilestoneError(`unknown project "${projectId}"`);
  }
  const match = findMilestone(project.milestones, milestone);
  if (!match) {
    const known = project.milestones.map((m) => m.name).join(', ');
    throw new UnknownMilestoneError(
      `"${milestone}" is not a known milestone for project "${projectId}"` +
        (known
          ? ` — expected one of: ${known}`
          : ' — project has no milestones configured'),
    );
  }
  return match;
}

/**
 * Best-effort task -> milestone attribution: scans each of the project's
 * milestone board caches (the same `board:${milestone.id}` task_cache rows
 * getMilestoneConvergence's task axis reads) for the given task id, and
 * returns the owning milestone's canonical short-form key. Used to attribute
 * a staged_intent to a milestone at stage time when the caller doesn't
 * already know it explicitly (e.g. a dispatched planning session).
 * Returns null — never throws — when the project is unknown, the task isn't
 * found in any cached board, or a board cache is missing/stale/unparseable;
 * the caller falls back to the "unattributed" bucket in that case.
 */
export function resolveMilestoneForTaskId(
  projectId: string,
  taskId: string,
): string | null {
  const project = ProjectService.getById(projectId);
  if (!project) return null;
  const normalized = normalizeTaskId(taskId);
  for (const milestone of project.milestones) {
    if (!milestone.sourceId) continue;
    const row = getTaskCache(`board:${milestone.id}`);
    if (!row) continue;
    let tasks: NotionTask[];
    try {
      tasks = JSON.parse(row.raw_json) as NotionTask[];
    } catch {
      continue;
    }
    if (tasks.some((t) => normalizeTaskId(t.id) === normalized)) {
      return canonicalMilestoneKey(milestone);
    }
  }
  return null;
}

/**
 * Same resolution without a project scope, for the multi-project gate/seed
 * read routes (readiness/next) that key purely by milestone short-form key
 * across every project's items.
 */
export function resolveMilestoneAnyProject(milestone: string): string {
  for (const project of ProjectService.list()) {
    const match = findMilestone(project.milestones, milestone);
    if (match) return canonicalMilestoneKey(match);
  }
  throw new UnknownMilestoneError(
    `"${milestone}" is not a known milestone display name for any project`,
  );
}
