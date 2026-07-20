/**
 * The grooming-integrity constraint catalog (FM1 — see the M12 design task
 * "Harden the /groom skill against grooming-integrity failure modes").
 *
 * Each entry is a non-negotiable already flagged on one of the fixed
 * architecture pages (Technical Architecture / Master Context), scoped to the
 * code regions it binds via `appliesTo` — deterministic region globs, no LLM
 * judgment involved. groomLoad.ts intersects a task's resolved regions
 * against `appliesTo` to derive that task's `bindingConstraints`; groomGate.ts
 * re-derives the same intersection server-side so a session can't clear a
 * constraint by omitting or misreporting it.
 */

export interface ConstraintCatalogEntry {
  id: string;
  title: string;
  /** Title of the fixed architecture page this constraint is sourced from. */
  page: string;
  /** Heading text of the section within `page` that states the constraint. */
  section: string;
  /** Region globs (repo-relative package/file paths, `/**` = subtree) this constraint binds. */
  appliesTo: string[];
  summary: string;
}

export const CONSTRAINT_CATALOG: readonly ConstraintCatalogEntry[] = [
  {
    id: 'authority-vs-drift',
    title:
      'Session credentials never substitute for the command-layer authority chain',
    page: 'Technical Architecture',
    section: 'Authority-vs-drift',
    appliesTo: [
      'packages/backend/src/routes/**',
      'packages/backend/src/tasks/**',
    ],
    summary:
      'Every write must resolve through the staged-intent surface — a session credential is not itself write authority.',
  },
  {
    id: 'command-vocabulary-closed',
    title: 'The task-write command vocabulary is closed',
    page: 'Technical Architecture',
    section: 'Task-Write Command Vocabulary & Transport',
    appliesTo: ['packages/backend/src/tasks/**'],
    summary:
      'TaskWriteCommands is the sole write chokepoint atop the backend port — no bypassing it with a direct backend call.',
  },
  {
    id: 'split-detect-confirm-route',
    title: 'Split follows detect → confirm → route',
    page: 'Technical Architecture',
    section: 'Split',
    appliesTo: [
      'packages/backend/src/split/**',
      'packages/backend/src/groom/**',
    ],
    summary:
      'A flagged size/type mismatch is never auto-split — a human/groomer must confirm and route it.',
  },
  {
    id: 'readiness-gate-deterministic-only',
    title: 'The readiness gate stays deterministic until Tier 3 ships',
    page: 'Master Context',
    section: 'Future Scope',
    appliesTo: ['packages/backend/src/tasks/readinessGate.ts'],
    summary:
      'Tiers 1–2 stay structural/lexical; semantic (LLM) classification is Future Scope, not to be added ad hoc.',
  },
  {
    id: 'gate-accretion-durable',
    title: 'gate_contribution reads a durable marker, not a cache field',
    page: 'Technical Architecture',
    section: 'Gate & Seed Accretion',
    appliesTo: ['packages/backend/src/gate/**'],
    summary:
      'gate_accretion must survive independent of whatever cache produced the Ready-flip intent.',
  },
  {
    id: 'seed-accretion-durable',
    title: 'seed_contribution reads a durable marker, not a cache field',
    page: 'Technical Architecture',
    section: 'Gate & Seed Accretion',
    appliesTo: ['packages/backend/src/seed/**'],
    summary:
      'seed_accretion mirrors gate_accretion — durable, keyed by source task.',
  },
  {
    id: 'dependency-candidates-not-autowired',
    title: 'Dependency candidates are surfaced, never auto-wired',
    page: 'Technical Architecture',
    section: 'Milestone Dependency Graph',
    appliesTo: ['packages/backend/src/orchestration/**'],
    summary:
      'Region-overlap and declared-dependency candidates require human confirmation before becoming a Depends On edge.',
  },
  {
    id: 'notion-single-writer',
    title: 'Notion access flows through NotionClient only',
    page: 'Technical Architecture',
    section: 'Notion Access',
    appliesTo: ['packages/backend/src/notion/**'],
    summary: 'No other module calls the Notion API directly.',
  },
  {
    id: 'ops-load-read-only',
    title: 'The ops loader stays read-only',
    page: 'Technical Architecture',
    section: 'Operational Load',
    appliesTo: ['packages/backend/src/ops/**'],
    summary:
      'ops-load never mutates state; writes go through the staged-intent surface.',
  },
  {
    id: 'deploy-gates-on-min-commit',
    title: 'Deploy gates on min_deployed_commit, not wall-clock time',
    page: 'Technical Architecture',
    section: 'Deploy Gate',
    appliesTo: ['packages/backend/src/deploy/**'],
    summary:
      'A gate/seed item is only safe to apply once its min_deployed_commit has actually landed.',
  },
  {
    id: 'design-signoff-required',
    title:
      'Design tasks require explicit signoff before downstream work starts',
    page: 'Technical Architecture',
    section: 'Design Signoff',
    appliesTo: ['packages/backend/src/design/**'],
    summary:
      'A non-Done Design task can still reshape its dependents — they must not promote around it.',
  },
  {
    id: 'session-credential-scope',
    title: 'Session credentials are scoped, not ambient',
    page: 'Technical Architecture',
    section: 'Session Stage Auth',
    appliesTo: [
      'packages/backend/src/auth/**',
      'packages/backend/src/session/**',
    ],
    summary:
      'Each staged intent gets a narrowly-scoped credential, never a broad ambient one.',
  },
  {
    id: 'permissions-least-privilege',
    title: 'Permission grants are least-privilege and explicit',
    page: 'Master Context',
    section: 'Permissions Model',
    appliesTo: ['packages/backend/src/permissions/**'],
    summary: 'No wildcard or implicit grants — every permission is enumerated.',
  },
  {
    id: 'security-review-gate',
    title: 'Security-sensitive surfaces require a security review pass',
    page: 'Master Context',
    section: 'Security Review Gate',
    appliesTo: ['packages/backend/src/security/**'],
    summary:
      'A new externally-reachable surface is not Ready until security-reviewed.',
  },
  {
    id: 'audit-log-append-only',
    title: 'The audit log is append-only',
    page: 'Technical Architecture',
    section: 'Audit Log',
    appliesTo: ['packages/backend/src/audit/**'],
    summary: 'recordEvent rows are never mutated or deleted after write.',
  },
  {
    id: 'ws-broadcast-non-authoritative',
    title: 'WS broadcasts are a projection, not a source of truth',
    page: 'Technical Architecture',
    section: 'WS Broadcast',
    appliesTo: ['packages/backend/src/ws/**'],
    summary:
      'Clients must reconcile against a REST fetch — the socket stream alone is not authoritative.',
  },
  {
    id: 'milestone-resolver-single-source',
    title: 'Milestone/project resolution has one source of truth',
    page: 'Technical Architecture',
    section: 'Milestone Resolver',
    appliesTo: ['packages/backend/src/projects/**'],
    summary:
      'resolveMilestoneForProject is the only place milestone/project mapping is computed.',
  },
  {
    id: 'db-migrations-forward-only',
    title: 'DB migrations are forward-only',
    page: 'Technical Architecture',
    section: 'Database Migrations',
    appliesTo: ['packages/backend/src/db/**'],
    summary: 'No destructive down-migrations against the durable store.',
  },
  {
    id: 'updater-no-self-modify-mid-run',
    title: 'The updater never modifies itself mid-run',
    page: 'Master Context',
    section: 'Self-Update Safety',
    appliesTo: ['packages/backend/src/updater/**'],
    summary:
      'Self-update swaps happen only at a safe checkpoint, never inside an in-flight request.',
  },
  {
    id: 'pr-no-self-merge',
    title: 'A session never merges its own PR',
    page: 'Master Context',
    section: 'PR Lifecycle',
    appliesTo: ['packages/backend/src/github/**'],
    summary:
      'Merge authority stays with the dashboard/reviewer, never the authoring session.',
  },
  {
    id: 'grooming-guards-server-derived',
    title: 'Grooming-integrity guards are re-derived server-side',
    page: 'Technical Architecture',
    section: 'Grooming Integrity Guards',
    appliesTo: ['packages/backend/src/groom/**'],
    summary:
      'Binding constraints, Files/paths resolution, and cite-or-route signals are recomputed by the gate, never trusted verbatim from a session payload.',
  },
] as const;

/**
 * Deterministic region-glob match: `<prefix>/**` matches `prefix` itself and
 * anything under it; a glob with no `/**` suffix matches only that literal
 * region. No wildcard segments beyond the trailing `/**` — deliberately
 * simple since `appliesTo` only ever needs subtree-or-exact matching.
 */
export function matchesRegionGlob(glob: string, region: string): boolean {
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -3);
    return region === prefix || region.startsWith(`${prefix}/`);
  }
  return region === glob;
}

export interface RegionsLike {
  packages: string[];
  files: string[];
}

/**
 * Intersect a task's resolved regions against every catalog entry's
 * `appliesTo`, returning the sorted, deduped set of binding constraint ids.
 * Pure and deterministic — the same function groomLoad.ts (to seed a task's
 * `bindingConstraints`) and groomGate.ts (to re-derive it at promotion time)
 * both call, so the two can never silently drift.
 */
export function bindingConstraintIdsForRegions(regions: RegionsLike): string[] {
  const paths = [...(regions.packages ?? []), ...(regions.files ?? [])];
  const ids = new Set<string>();
  for (const entry of CONSTRAINT_CATALOG) {
    if (
      entry.appliesTo.some((glob) =>
        paths.some((p) => matchesRegionGlob(glob, p)),
      )
    ) {
      ids.add(entry.id);
    }
  }
  return [...ids].sort();
}

function normalizeHeadingText(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .toLowerCase();
}

export interface ArchPageLike {
  title: string;
  markdown: string;
}

/** True when `entry.page`/`entry.section` resolves to a live heading among `pages`. */
export function resolvesCatalogEntry(
  entry: ConstraintCatalogEntry,
  pages: ArchPageLike[],
): boolean {
  const page = pages.find((p) => p.title === entry.page);
  if (!page) return false;
  const target = normalizeHeadingText(entry.section);
  return page.markdown.split('\n').some((line) => {
    const m = line.match(/^#{1,6}\s*(.+)$/);
    return !!m && normalizeHeadingText(m[1]) === target;
  });
}

/** The keep-honest surface: catalog entries whose page/section fails to resolve against `pages`. */
export function unresolvedCatalogEntries(
  pages: ArchPageLike[],
): ConstraintCatalogEntry[] {
  return CONSTRAINT_CATALOG.filter(
    (entry) => !resolvesCatalogEntry(entry, pages),
  );
}
