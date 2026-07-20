import { ProjectService } from './ProjectService';

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

/**
 * Matches the leading M<n> / m<n> / M<n>a token off a milestone's full
 * display name (e.g. "M11 — Orchestrator-Owned Planning" -> "M11"). This is
 * the short form gate_item/seed_item and every loader/manifest/CLI flag key
 * on — the canonical milestone key. Returns undefined for milestones whose
 * name doesn't start with such a token.
 */
function extractMilestoneToken(name: string): string | undefined {
  const match = name.match(/^([Mm]\d+[A-Za-z]?)(?=[\s—:-]|$)/);
  return match?.[1];
}

/** The canonical short-form key for a milestone — its leading M<n> token, or its full name if it has none. */
function canonicalMilestoneKey(milestone: { name: string }): string {
  return extractMilestoneToken(milestone.name) ?? milestone.name;
}

function findMilestone<M extends { id: string; name: string }>(
  milestones: M[],
  milestone: string,
): M | undefined {
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
