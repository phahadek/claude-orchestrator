/**
 * Matches the leading M<n> / m<n> / M<n>a token off a milestone's full
 * display name (e.g. "M11 — Orchestrator-Owned Planning" -> "M11"). Used at
 * registration time (ProjectService.createMilestone) to derive-once the
 * stored canonical_short_id — not on the read path. Returns undefined for
 * milestones whose name doesn't start with such a token.
 */
export function extractMilestoneToken(name: string): string | undefined {
  const match = name.match(/^([Mm]\d+[A-Za-z]?)(?=[\s—:-]|$)/);
  return match?.[1];
}
