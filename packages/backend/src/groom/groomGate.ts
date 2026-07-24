/**
 * In-backend grooming promotion gate — the enforcement point the /groom
 * skill's gate usage rewires to as grooming state moves off the file-cache
 * PreToolUse hook (scripts/groom-gate.mjs) and into the orchestrator. Covers
 * the size_check, type_check, gate_contribution, seed_contribution,
 * bindingConstraints (FM1), Files/paths resolve-in-artifact (FM2), and
 * cite-or-route (FM3) artifacts; the hook's other checks (signoff,
 * repo_assignment) migrate here in follow-on tasks as their state moves
 * backend-side.
 *
 * size_check / type_check are "present-and-dispositioned" gates, not
 * correctness gates: the groomer must have recorded a decision, but a
 * flagged type_check never hard-blocks promotion on its own — see
 * typeCheck.ts. gate_contribution and seed_contribution instead read a
 * durable marker (gate_accretion / seed_accretion, written by
 * accreteGateContribution / stageSeedContribution) rather than a field on the
 * grooming-state entry, since it must survive independent of whatever cache
 * produced the Ready-flip intent.
 *
 * bindingConstraints (FM1), Files/paths resolution (FM2), and the
 * Design/Planning Depends On + cite-or-route signals (FM3) are re-derived
 * from `entry.regions` / `entry.filesPathsEntries` / `entry.dependsOnTasks`
 * rather than trusted as a caller-asserted "this is fine" — a session can
 * misreport a disposition's shape, but it can't misreport which constraints
 * apply (CONSTRAINT_CATALOG × regions is computed here) or launder a hedge
 * token out of a Files/paths entry (the hedge scan re-runs here too).
 *
 * For interactive (📐 Design / 📋 Planning) types, one further gate applies:
 * approve-by-standard promotion (planning/triage.ts) — a recorded triage
 * verdict that floors to 'clean', re-derived server-side from the same
 * `dependsOnTasks` / `constraintsDispositioned` facts above rather than
 * trusted as a caller-asserted final verdict. Auto-dispatched types
 * (💻 Code) are unaffected and keep the unchanged per-task human gate.
 */

import { getAccretionMarker as getGateAccretionMarker } from '../gate/gateStore';
import { getAccretionMarker as getSeedAccretionMarker } from '../seed/seedStore';
import {
  bindingConstraintIdsForRegions,
  type RegionsLike,
} from './constraintCatalog';
import {
  applyTriageFloor,
  isInteractiveTaskType,
  INTERACTIVE_TASK_TYPES,
  type TriageVerdict,
} from '../planning/triage';

const SIZE_CHECK_DECISIONS = new Set([
  'no_split',
  'split_now',
  'unsplittable',
  'n/a',
]);

/** Task types that require a gate_contribution accretion marker before Ready. */
const GATE_CONTRIBUTION_TYPES = new Set(['💻 Code']);

/** Task types that require a seed_contribution accretion marker before Ready. */
const SEED_CONTRIBUTION_TYPES = new Set(['💻 Code']);

/** Statuses that clear a Depends On edge / a cited Design task as "settled". */
const DONE_STATUSES = new Set(['✅ Done', '⏭️ Deferred']);

/**
 * Types whose non-Done presence in Depends On blocks promotion (FM3 signal
 * a): their outcome may still reshape the task and invalidate the grooming
 * already recorded against it. Same set as approve-by-standard's
 * INTERACTIVE_TASK_TYPES (planning/triage.ts) — both signals key off
 * "not auto-dispatched".
 */
const DESIGN_GATE_TYPES = INTERACTIVE_TASK_TYPES;

/** and/or is a Files/paths-section hedge token only — see readinessGate.ts's Tier-2 class for the general-prose scan, which deliberately excludes it. */
const FILES_PATHS_HEDGE_TOKENS = ['and/or', 'confirm', 'tbd', 'exact file'];

/** One parsed `## Files / paths affected` list item (groomLoad.ts produces these with git-validated `existsInRepo`). */
export interface FilesPathsEntry {
  /** The raw list-item text as it appeared in the task body. */
  raw: string;
  /** True when the entry explicitly marks a not-yet-created path via `*(new)*`. */
  isNew: boolean;
  /** True when the entry's path resolves to an existing tracked file in the repo. */
  existsInRepo: boolean;
}

/** A Depends On task's last-known type/status, as resolved by groomLoad.ts against the board/neighbour boards. */
export interface DependsOnTaskRef {
  id: string;
  type?: string;
  status?: string;
}

/**
 * The groomer's recorded disposition for one binding constraint:
 *  - complies: the task's regions comply with the constraint as written.
 *    `citedDesignTaskId`, when present, instead cites an already-✅-Done
 *    Design task as the locked decision the task complies against (FM3
 *    cite-a-locked-decision) — it must resolve or the disposition doesn't
 *    clear the constraint.
 *  - n/a: the constraint doesn't actually bind this task despite the region
 *    match; `why` is mandatory.
 *  - conflict_route: the task's scope conflicts with the constraint;
 *    `routedTaskId` must name a recorded 📐 Design Depends On task (FM3
 *    route-to-/design).
 */
type ConstraintDisposition =
  | { disposition: 'complies'; citedDesignTaskId?: string }
  | { disposition: 'n/a'; why: string }
  | { disposition: 'conflict_route'; routedTaskId: string };

export interface GroomingGateEntry {
  size_check?: { decision?: unknown; [key: string]: unknown } | null;
  type_check?: {
    decision?: unknown;
    disposition?: unknown;
    [key: string]: unknown;
  } | null;
  /** Display-format Task Type, e.g. '💻 Code' — decides whether gate_contribution is required. */
  type?: string;
  /** This task's resolved code regions (codeWorklist.ts's resolveTaskRegions) — drives bindingConstraints re-derivation. */
  regions?: RegionsLike;
  /** Per-binding-constraint-id disposition recorded during grooming (grooming-state.json's constraints_dispositioned). */
  constraintsDispositioned?: Record<string, ConstraintDisposition>;
  /** For 💻 Code tasks: parsed `## Files / paths affected` entries — the resolve-in-artifact check (FM2). */
  filesPathsEntries?: FilesPathsEntry[];
  /** This task's declared Depends On, resolved to type/status — drives FM3's Design/Planning liveness + cite-or-route signals. */
  dependsOnTasks?: DependsOnTaskRef[];
  /**
   * Approve-by-standard triage input for an interactive (📐 Design /
   * 📋 Planning) task — see planning/triage.ts. Required for those types
   * before promotion; ignored for auto-dispatched types (💻 Code stays
   * per-task-gated). `proposedVerdict` is the groomer's judgment-primary
   * call; `hasOpenQuestionsHeading` is a structural fact groomLoad.ts
   * computes from the task body. The deterministic floor is re-applied here
   * from server-derived facts (hard-block Depends On, routed constraint
   * conflicts) rather than trusting a caller-asserted final verdict.
   */
  triage?: {
    proposedVerdict: TriageVerdict;
    hasOpenQuestionsHeading: boolean;
  };
}

export interface GroomingGateResult {
  allowed: boolean;
  reasons: string[];
}

/**
 * Lets a caller that already knows a matching gate.accrete/seed.stage intent
 * will apply for real (same task, same intent group, ordered ahead of the
 * arming task.setStatus -> Ready — see stagedIntents.ts's group-commit
 * ordering) skip re-deriving that specific durable-marker check ahead of
 * time. This never substitutes a durable marker for the check: the real
 * commit-time call (TaskWriteCommands.setStatus, reached only after the
 * group's gate.accrete/seed.stage intents have actually applied and written
 * their markers) is always made without these flags, so the marker remains
 * the sole source of truth for whether the flip is actually allowed to land.
 */
export interface AccretionCheckOptions {
  skipGateContributionCheck?: boolean;
  skipSeedContributionCheck?: boolean;
}

function isSizeCheckClassified(entry: GroomingGateEntry): boolean {
  const sc = entry.size_check;
  return (
    !!sc &&
    typeof sc === 'object' &&
    typeof sc.decision === 'string' &&
    SIZE_CHECK_DECISIONS.has(sc.decision)
  );
}

/**
 * type_check must be present with a recognized decision. A 'flagged' decision
 * additionally requires a non-empty `disposition` — the groomer's recorded
 * resolution (a split-off task id, or a dismissal reason) — recording the
 * flag without a disposition doesn't clear the gate.
 */
function isTypeCheckDispositioned(entry: GroomingGateEntry): boolean {
  const tc = entry.type_check;
  if (!tc || typeof tc !== 'object' || typeof tc.decision !== 'string')
    return false;
  if (tc.decision === 'none' || tc.decision === 'n/a') return true;
  if (tc.decision === 'flagged')
    return typeof tc.disposition === 'string' && tc.disposition.trim() !== '';
  return false;
}

/**
 * gate_contribution requires a durable gate_accretion marker for the task
 * being promoted (accreteGateContribution writes it, keyed by source task id
 * — the task being promoted is its own source). Absent a resolved type, or a
 * type outside Code, fail-open (allow) — mirrors groom-gate.mjs's
 * needsGate check.
 */
function isGateContributionRecorded(
  type: string | undefined,
  taskId: string,
): boolean {
  if (!type || !GATE_CONTRIBUTION_TYPES.has(type)) return true;
  return getGateAccretionMarker(taskId) !== undefined;
}

/**
 * seed_contribution requires a durable seed_accretion marker for the task
 * being promoted (stageSeedContribution writes it, keyed by source task id —
 * the task being promoted is its own source). Absent a resolved type, or a
 * type outside Code, fail-open (allow) — mirrors gate_contribution's
 * treatment and groom-gate.mjs's needsSeed check.
 */
function isSeedContributionRecorded(
  type: string | undefined,
  taskId: string,
): boolean {
  if (!type || !SEED_CONTRIBUTION_TYPES.has(type)) return true;
  return getSeedAccretionMarker(taskId) !== undefined;
}

function filesPathsHedgeTokens(raw: string): string[] {
  const lower = raw.toLowerCase();
  return FILES_PATHS_HEDGE_TOKENS.filter((t) => lower.includes(t));
}

/**
 * FM2 — resolve-in-artifact. For 💻 Code tasks, every Files/paths entry must
 * be free of hedge tokens and resolve to a concrete file: either
 * git-validated existing, or explicitly marked `*(new)*`. Non-Code types
 * fail-open (not the artifact this check governs).
 */
function isFilesPathsResolved(
  type: string | undefined,
  entries: FilesPathsEntry[] | undefined,
): { ok: boolean; reasons: string[] } {
  if (type !== '💻 Code') return { ok: true, reasons: [] };
  const reasons: string[] = [];
  if (!entries || entries.length === 0) {
    return {
      ok: false,
      reasons: [
        'Files / paths affected has no parseable entries for a 💻 Code task — every entry must resolve ' +
          'to a concrete existing file or an explicit *(new)* file.',
      ],
    };
  }
  for (const e of entries) {
    const hedges = filesPathsHedgeTokens(e.raw);
    if (hedges.length) {
      reasons.push(
        `Files/paths entry "${e.raw}" contains hedge token(s) [${hedges.join(', ')}] — pin a concrete path before promotion.`,
      );
      continue;
    }
    if (!e.isNew && !e.existsInRepo) {
      reasons.push(
        `Files/paths entry "${e.raw}" does not resolve to an existing tracked file and is not marked *(new)*.`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * FM3 signal (a) — a non-Done 📐 Design / 📋 Planning Depends On task can
 * still reshape this task's scope, invalidating whatever was groomed against
 * it. Blocks promotion until that dependency reaches ✅ Done (or is
 * ⏭️ Deferred).
 */
function isDependsOnDesignClear(
  dependsOnTasks: DependsOnTaskRef[] | undefined,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const dep of dependsOnTasks ?? []) {
    if (
      dep.type &&
      DESIGN_GATE_TYPES.has(dep.type) &&
      !(dep.status && DONE_STATUSES.has(dep.status))
    ) {
      reasons.push(
        `Depends On task "${dep.id}" is a non-Done ${dep.type} task — its outcome may reshape this task's ` +
          'scope; it must reach ✅ Done before this task can promote.',
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * FM1 + FM3 signal (b)/(c) — re-derive this task's binding constraints from
 * `regions` (never trust a caller-supplied id list), require a disposition
 * per constraint, and validate each disposition's shape: n/a needs a reason,
 * conflict_route needs a recorded routed 📐 Design Depends On task, and a
 * complies citing a Design decision needs that citation to resolve to
 * ✅ Done.
 */
function isConstraintsDispositioned(entry: GroomingGateEntry): {
  ok: boolean;
  reasons: string[];
} {
  const ids = bindingConstraintIdsForRegions(
    entry.regions ?? { packages: [], files: [] },
  );
  const dispositioned = entry.constraintsDispositioned ?? {};
  const dependsOnTasks = entry.dependsOnTasks ?? [];
  const reasons: string[] = [];

  for (const id of ids) {
    const d = dispositioned[id];
    if (!d) {
      reasons.push(
        `binding constraint "${id}" has no recorded disposition — comply / n-a (+why) / conflict→route is ` +
          'required before promotion.',
      );
      continue;
    }
    if (d.disposition === 'n/a' && !d.why?.trim()) {
      reasons.push(
        `binding constraint "${id}" is dispositioned n/a without a reason.`,
      );
    }
    if (d.disposition === 'conflict_route') {
      const routed = dependsOnTasks.find((t) => t.id === d.routedTaskId);
      if (!d.routedTaskId || !routed || routed.type !== '📐 Design') {
        reasons.push(
          `binding constraint "${id}" is dispositioned conflict→route without a recorded, routed 📐 Design ` +
            'Depends On task.',
        );
      }
    }
    if (d.disposition === 'complies' && d.citedDesignTaskId) {
      const cited = dependsOnTasks.find((t) => t.id === d.citedDesignTaskId);
      if (!cited || cited.status !== '✅ Done') {
        reasons.push(
          `binding constraint "${id}" cites Design task "${d.citedDesignTaskId}" as its locked decision, but ` +
            'that task does not resolve to a ✅ Done Depends On task.',
        );
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Approve-by-standard promotion path for interactive (📐 Design /
 * 📋 Planning) types — the per-task server-enforced records above stay
 * required and type-agnostic; this is the one additional gate that stands in
 * for the per-item human decision those types no longer carry. An
 * interactive-type task promotes only once its triage input floors to
 * 'clean'. 💻 Code (and any other non-interactive type) fails open — this
 * check does not apply to it, so auto-dispatched promotion is unaffected.
 */
function isInteractiveTriageClean(
  type: string | undefined,
  entry: GroomingGateEntry,
): { ok: boolean; reasons: string[] } {
  if (!isInteractiveTaskType(type)) return { ok: true, reasons: [] };
  if (!entry.triage) {
    return {
      ok: false,
      reasons: [
        `interactive task type "${type}" requires a recorded triage verdict before promotion — see planning/triage.ts.`,
      ],
    };
  }
  const dependsOnTasks = entry.dependsOnTasks ?? [];
  const hardBlockDepNotDone = dependsOnTasks.some(
    (dep) =>
      dep.type &&
      DESIGN_GATE_TYPES.has(dep.type) &&
      !(dep.status && DONE_STATUSES.has(dep.status)),
  );
  const hasRoutedConstraintConflict = Object.values(
    entry.constraintsDispositioned ?? {},
  ).some((d) => d.disposition === 'conflict_route');

  const floored = applyTriageFloor({
    proposedVerdict: entry.triage.proposedVerdict,
    hardBlockDepNotDone,
    hasOpenQuestionsHeading: entry.triage.hasOpenQuestionsHeading,
    hasRoutedConstraintConflict,
  });

  if (floored.verdict !== 'clean') {
    return {
      ok: false,
      reasons: [
        `triage verdict is "${floored.verdict}" (${floored.reasons.join('; ') || 'not proposed as clean'}) — ` +
          `an interactive (${type}) task promotes without a per-item sign-off only once triaged clean.`,
      ],
    };
  }
  return { ok: true, reasons: [] };
}

/**
 * Checks the size_check / type_check / gate_contribution / seed_contribution
 * artifacts of a grooming-state entry ahead of a Ready promotion.
 *
 * `authoritativeType` is the task's real, server-derived display-format Type
 * (e.g. read from the task cache by the command layer). It takes precedence
 * over `entry.type` — the caller-supplied payload — when deciding whether
 * gate_contribution / seed_contribution are required, since `entry.type`
 * alone is not trustworthy: a caller can omit it to dodge accretion
 * enforcement. `entry.type` is only used as a fallback when no authoritative
 * type could be resolved.
 */
export function checkGroomingPromotionGate(
  entry: GroomingGateEntry,
  taskId: string,
  authoritativeType?: string,
  accretionOpts?: AccretionCheckOptions,
): GroomingGateResult {
  const reasons: string[] = [];
  const resolvedType = authoritativeType ?? entry.type;

  if (!isSizeCheckClassified(entry)) {
    reasons.push(
      'size_check is missing or malformed — every Code/Tooling task must have an explicit size ' +
        'classification recorded before promotion. Expected {"decision": "no_split"|"split_now"|"unsplittable"|"n/a"}.',
    );
  }

  if (!isTypeCheckDispositioned(entry)) {
    reasons.push(
      'type_check is missing or undispositioned — the groomer must record {"decision":"none"} or ' +
        '{"decision":"n/a"} (exempt type), or, when the smuggle-scan flags the body, ' +
        '{"decision":"flagged","disposition":"split-filed:<id>"|"dismissed:<reason>"} before promotion.',
    );
  }

  reasons.push(
    ...checkAccretionContributions(entry, taskId, resolvedType, accretionOpts)
      .reasons,
  );

  reasons.push(
    ...isFilesPathsResolved(resolvedType, entry.filesPathsEntries).reasons,
  );
  reasons.push(...isDependsOnDesignClear(entry.dependsOnTasks).reasons);
  reasons.push(...isConstraintsDispositioned(entry).reasons);
  reasons.push(...isInteractiveTriageClean(resolvedType, entry).reasons);

  return { allowed: reasons.length === 0, reasons };
}

/**
 * The gate_contribution/seed_contribution subset of checkGroomingPromotionGate
 * — every other artifact (size_check, type_check, Files/paths, constraints,
 * triage) is only knowable from the full grooming-state entry a dispatched
 * session builds up over a turn, but the accretion markers are durable
 * cross-turn state a session can (and does) skip recording. Run at stage time
 * (POST /staged-intents) so a session that stages a Ready flip with no
 * gate/seed accretion sees the gap in-turn instead of discovering it only
 * when a human later tries to apply — that eager check never blocks staging
 * itself; checkGroomingPromotionGate at commit time remains the sole hard
 * authority.
 */
export function checkAccretionContributions(
  entry: GroomingGateEntry,
  taskId: string,
  authoritativeType?: string,
  opts?: AccretionCheckOptions,
): GroomingGateResult {
  const reasons: string[] = [];
  const resolvedType = authoritativeType ?? entry.type;

  if (
    !opts?.skipGateContributionCheck &&
    !isGateContributionRecorded(resolvedType, taskId)
  ) {
    reasons.push(
      'gate_contribution is not recorded — for 💻 Code tasks, accreteGateContribution ' +
        'must record a gate_accretion marker (items appended to the milestone gate, or an explicit ' +
        '"none"/"n/a" decision) for this task before promotion.',
    );
  }

  if (
    !opts?.skipSeedContributionCheck &&
    !isSeedContributionRecorded(resolvedType, taskId)
  ) {
    reasons.push(
      'seed_contribution is not recorded — for 💻 Code tasks, stageSeedContribution ' +
        'must record a seed_accretion marker (config-change seeds minted onto the milestone seed store, ' +
        'or an explicit "none"/"n/a" decision) for this task before promotion.',
    );
  }

  return { allowed: reasons.length === 0, reasons };
}

/**
 * Thrown by the command layer (TaskWriteCommands.setStatus) when a Ready
 * transition carrying a grooming-gate entry fails checkGroomingPromotionGate.
 * This is the enforcement point that replaces the groom-gate.mjs PreToolUse
 * hook now that the Ready-flip goes through the staged-intent surface instead
 * of a direct notion-update-page call the hook could intercept.
 */
export class GroomingGateError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`grooming promotion gate blocked: ${reasons.join('; ')}`);
    this.name = 'GroomingGateError';
  }
}
