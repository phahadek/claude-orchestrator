import { ProjectService } from './ProjectService';
import type { ProjectMilestone } from './ProjectService';
import { getTaskCache, getGateItem } from '../db/queries';
import { normalizeTaskId } from '../tasks/taskId';
import type { NotionTask } from '../notion/types';
import {
  isGateVerifySession,
  isInvestigateSession,
} from '../session/sessionPredicates';
import { getReportsForBatchTaskId } from '../investigation/reportStore';

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
 * True once the milestone a gate item belongs to has been wrapped
 * (milestones.wrapped_at set — see /milestone-wrap). Resolves through the
 * same id/name/canonical-short-id matching as resolveMilestoneRowForProject,
 * so a gate_item row that still holds a raw milestone UUID (the shadow
 * key-space documented in context.md) resolves to the same row — and the
 * same wrapped/unwrapped answer — as its canonical-short-id counterpart,
 * rather than silently missing the match. An unresolvable milestone
 * (unknown project, typo, stale reference) is treated as NOT wrapped —
 * the safe default that keeps it in scope exactly as before this predicate
 * existed, rather than excluding it on a lookup failure.
 */
export function isMilestoneWrapped(projectId: string, milestone: string): boolean {
  const project = ProjectService.getById(projectId);
  if (!project) return false;
  const match = findMilestone(project.milestones, milestone);
  return match?.wrappedAt != null;
}

/**
 * A cached variant of isMilestoneWrapped for hot loops that check many gate
 * items against the same small set of projects/milestones within a single
 * pass (the reconciler tick) — memoizes ProjectService.getById per project
 * so checking N items costs at most one DB round-trip per distinct project,
 * not one per item.
 */
export function createWrappedMilestoneChecker(): (
  project: string,
  milestone: string,
) => boolean {
  const cache = new Map<
    string,
    ReturnType<typeof ProjectService.getById>
  >();
  return (project, milestone) => {
    let proj = cache.get(project);
    if (proj === undefined && !cache.has(project)) {
      proj = ProjectService.getById(project);
      cache.set(project, proj);
    }
    if (!proj) return false;
    const match = findMilestone(proj.milestones, milestone);
    return match?.wrappedAt != null;
  };
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
 * Same as resolveMilestoneForTaskId, but aware of a gate-verify session's
 * sentinel task id (`gate-item:<uuid>`, see isGateVerifySession) — a value
 * that never matches any milestone board cache row. For that case, reads
 * the milestone straight off the referenced gate_item row instead (the same
 * untransformed field AgentSession.recordGateVerifyDisposition's gate.verify
 * fix already stages with no conversion step); otherwise delegates
 * unchanged to resolveMilestoneForTaskId. Returns null — never throws — when
 * the gate item is missing or itself carries no milestone.
 *
 * Mirrors that carve-out for an investigate session's sentinel task id
 * (`report-batch:<batchId>`, see isInvestigateSession): resolves the
 * dispatched batch's report(s) via getReportsForBatchTaskId and reads
 * reports[0].milestone_id, matching launchInvestigateBatch's own
 * first-report rule for a batch that spans multiple reports. That id is in
 * the milestones.id UUID key space (investigation_report.milestone_id), so
 * it is normalized through resolveMilestoneForProject to the canonical
 * short-form key staged_intent.milestone stores — never the raw UUID.
 * Returns null — never throws — for a batch with no dispatch row, no
 * report, a report whose milestone is unset, or a milestone id that no
 * longer resolves for the project.
 */
export function resolveMilestoneForSessionTask(
  projectId: string,
  taskId: string,
): string | null {
  if (isGateVerifySession(taskId)) {
    const itemId = taskId.slice('gate-item:'.length);
    return getGateItem(itemId)?.milestone ?? null;
  }
  if (isInvestigateSession(taskId)) {
    const milestoneId = getReportsForBatchTaskId(taskId)[0]?.milestone_id;
    if (!milestoneId) return null;
    try {
      return resolveMilestoneForProject(projectId, milestoneId);
    } catch (err) {
      if (err instanceof UnknownMilestoneError) return null;
      throw err;
    }
  }
  return resolveMilestoneForTaskId(projectId, taskId);
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

/**
 * Same as resolveMilestoneRowForProject, without a project scope — for read
 * surfaces (e.g. the investigation_report list filter) that accept a bare
 * `milestone` query param with no `project` alongside it.
 */
export function resolveMilestoneRowAnyProject(
  milestone: string,
): ProjectMilestone {
  for (const project of ProjectService.list()) {
    const match = findMilestone(project.milestones, milestone);
    if (match) return match;
  }
  throw new UnknownMilestoneError(
    `"${milestone}" is not a known milestone display name for any project`,
  );
}
