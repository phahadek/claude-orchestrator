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
 * produced the Ready-flip intent. gate_contribution's per-candidate triage
 * (`entry.gateContributionCandidates` — runtime-observable /
 * config-or-code-determined / needs-triage, see procedureCore.ts's
 * accrete-gate-and-seed principle) is the one present-and-dispositioned check
 * that *is* a plain entry field rather than a durable marker: it fails open
 * when absent, same as the marker check does for a non-Code type.
 *
 * bindingConstraints (FM1), Files/paths resolution (FM2), and the
 * Design/Planning/Investigation Depends On + cite-or-route signals (FM3) are re-derived
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
  applyTriageFloorForType,
  isTriageEligibleType,
  INTERACTIVE_TASK_TYPES,
  TRIAGE_ELIGIBLE_TYPES,
  type TriageVerdict,
} from '../planning/triage';
import { ProjectService } from '../projects/ProjectService';
import type { SeedItemClassification } from '../db/types';
import { extractPathToken } from './groomLoad';
import type { TrackedFileSetCache } from './groomLoad';
import { getCachedStatus, getCachedType } from '../tasks/TaskWriteCommands';
import { STATUS_DISPLAY } from '../tasks/statusCanonical';

const SIZE_CHECK_DECISIONS = new Set([
  'no_split',
  'split_now',
  'unsplittable',
  'n/a',
]);

/**
 * Prose rendering of `TRIAGE_ELIGIBLE_TYPES` for in-band refusal text — a
 * single derivation point so the refusals below can never drift from the
 * set that actually gates promotion (see the "six/seven groomingGate
 * fields" completeness-claim drift this task fixes for the injected
 * procedure's copy of the same list).
 */
const TRIAGE_ELIGIBLE_TYPES_LIST = Array.from(TRIAGE_ELIGIBLE_TYPES).join(
  ' / ',
);

/** Task types that require a gate_contribution accretion marker before Ready. */
const GATE_CONTRIBUTION_TYPES = new Set(['💻 Code']);

/** Task types that require a seed_contribution accretion marker before Ready. */
const SEED_CONTRIBUTION_TYPES = new Set(['💻 Code']);

/** Statuses that clear a Depends On edge / a cited Design task as "settled". */
const DONE_STATUSES = new Set(['✅ Done', '⏭️ Deferred']);

/**
 * Types whose non-Done presence in Depends On blocks promotion (FM3 signal
 * a): their outcome may still reshape the task and invalidate the grooming
 * already recorded against it. Deliberately decoupled from
 * INTERACTIVE_TASK_TYPES (planning/triage.ts) — that set also gates
 * approve-by-standard eligibility, and widening it would silently grant a
 * new type approve-by-standard promotion as a side effect of fixing this
 * gate. 🔎 Investigation is included because it has the most direct
 * scope-reshaping mechanism after Design/Planning: "An Investigation
 * legitimately produces Code tasks as its output" (procedures.md § Task
 * types), so a task depending on a non-Done Investigation is groomed against
 * a scope the Investigation may reshape, supersede, or split. 🔧 Operational
 * is included for the same reason: its runtime/launch-and-observe outcome
 * (a backfill's actual reconciled state, a config authored against live
 * data) can reshape a dependent task's scope just as directly.
 */
const DEPENDS_ON_GATE_TYPES = new Set([
  ...INTERACTIVE_TASK_TYPES,
  '🔎 Investigation',
  '🔧 Operational',
]);

/** and/or is a Files/paths-section hedge token only — see readinessGate.ts's Tier-2 class for the general-prose scan, which deliberately excludes it. */
const FILES_PATHS_HEDGE_TOKENS = ['and/or', 'confirm', 'tbd', 'exact file'];

/**
 * One parsed `## Files / paths affected` list item. groomLoad.ts's own
 * loader output carries a git-validated `existsInRepo`, but the entries
 * `checkGroomingPromotionGate` actually receives here come from whatever a
 * dispatched session staged — a session can mislabel `existsInRepo` about
 * itself the same way it could mislabel `isNew`. Both Files/paths checks
 * below (`isFilesPathsResolved`, `isFilesPathsDeclaringRepoWork`) therefore
 * re-derive `existsInRepo` server-side from the project's tracked-file set
 * (`resolveFilesPathsEntriesServerSide`) before evaluating; the field on
 * this interface is advisory input only, never trusted as the final answer.
 */
export interface FilesPathsEntry {
  /** The raw list-item text as it appeared in the task body. */
  raw: string;
  /** True when the entry explicitly marks a not-yet-created path via `*(new)*`. */
  isNew: boolean;
  /**
   * Session-supplied claim that the entry's path resolves to an existing
   * tracked file in the repo — advisory only. `checkGroomingPromotionGate`
   * recomputes the authoritative value server-side rather than trusting this.
   */
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

/**
 * One line from the task body's pre-groom "### 👁️ Manual verification"
 * section, triaged before it is either accreted to the gate or relocated to
 * "### 🤖 Automated tests" — see procedureCore.ts's accrete-gate-and-seed
 * principle, which states the same three outcomes and the same deciding
 * question (behavioural trace vs code-only) as config-template/task-writing.md
 * § Manual Verification Gate.
 */
interface GateContributionCandidate {
  text: string;
  classification?:
    | 'runtime-observable'
    | 'config-or-code-determined'
    | 'needs-triage';
}

export interface GroomingGateEntry {
  /**
   * `files`/`loc`/`loc_method` are required alongside `decision` for the
   * numeric decisions (no_split/split_now/unsplittable) — see
   * `sizeCheckMissingNumericFields` below. `n/a` (Design/Planning, sized in
   * open-question count instead) carries no numbers to require.
   */
  size_check?: {
    decision?: unknown;
    files?: unknown;
    loc?: unknown;
    loc_method?: unknown;
    [key: string]: unknown;
  } | null;
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
   * Approve-by-standard triage input for a triage-eligible task (see
   * `isTriageEligibleType` / `TRIAGE_ELIGIBLE_TYPES` in planning/triage.ts).
   * Required for those types before promotion; rejected outright for
   * auto-dispatched/ineligible types (💻 Code stays per-task-gated).
   * `proposedVerdict` is the groomer's judgment-primary
   * call; `hasOpenQuestionsHeading` is a structural fact groomLoad.ts
   * computes from the task body. The deterministic floor is re-applied here
   * from server-derived facts (hard-block Depends On, routed constraint
   * conflicts) rather than trusting a caller-asserted final verdict.
   */
  triage?: {
    proposedVerdict: TriageVerdict;
    hasOpenQuestionsHeading: boolean;
  };
  /**
   * The per-line triage of the pre-groom "### 👁️ Manual verification"
   * section's candidates for gate_contribution, when the groomer recorded
   * one. Absent entirely, this check fails open (mirrors gate_contribution's
   * own durable-marker check) — a task with no Manual verification section
   * (or a caller that hasn't started passing this yet) records nothing here
   * and is unaffected.
   */
  gateContributionCandidates?: GateContributionCandidate[];
  /**
   * The groomer's declared operational data/config seeds for seed_contribution
   * — the assessment output stageSeedContribution's `seeds` array is supposed
   * to mint verbatim (see task-writing.md § Milestone config-seed). Now the
   * *trigger* for the content-match check, not one side of it: like
   * gate_contribution, seeds now have a real, persisted body section
   * (bodyRender.ts's `## Operational seed`, parsed back out via
   * readinessGate.ts's parseOperationalSeedItems) to re-derive server-side —
   * checkGroupArmingIntentCompleteness (stagedIntents.ts) fetches the real
   * stored task body and cross-checks its parsed items against the group's
   * live `seed.stage` intent's actual `seeds` array via
   * checkAccretionContentMatch, the same strip⇔accrete content-match posture
   * gate_contribution enforces, independent of this self-declared field.
   * Absent entirely, this check fails open (mirrors gate_contribution's own
   * candidates check) — a caller that hasn't started passing this yet records
   * nothing here and is unaffected.
   */
  seedContributionCandidates?: {
    spec: string;
    /** Mirrors GateContributionCandidate.classification — see SeedItemClassification. */
    classification?: SeedItemClassification;
  }[];
  /**
   * True when this task's pre-groom body (at Ready-flip staging time) still
   * carried a "### 👁️ Manual verification" section — a structural fact
   * groomLoad.ts computes from the body, same posture as
   * `triage.hasOpenQuestionsHeading`. Used by stagedIntents.ts's
   * group-liveness check (mirroring `hasGroupDependsOn` /
   * `DependsOnCompletenessError`) to require the intent group also carry a
   * live `task.patchBodySection` remove targeting that heading before the
   * Ready flip may commit — this field only signals the fact is worth
   * checking; the group-liveness check itself lives in stagedIntents.ts,
   * which alone knows about sibling staged intents.
   */
  hasManualVerificationSection?: boolean;
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

/** Decisions that size the actual code diff and so must carry files/loc/loc_method. */
const SIZE_CHECK_NUMERIC_DECISIONS = new Set([
  'no_split',
  'split_now',
  'unsplittable',
]);

/**
 * A numeric size_check decision (everything but Design/Planning's `n/a`)
 * must also record `files`/`loc`/`loc_method` — the estimate the decision
 * rests on, not merely the decision itself. Names each missing field rather
 * than a bare "malformed" so the groomer knows exactly what to add; never
 * judges whether the recorded numbers are plausible.
 */
function sizeCheckMissingNumericFields(entry: GroomingGateEntry): string[] {
  const sc = entry.size_check;
  if (
    !sc ||
    typeof sc !== 'object' ||
    typeof sc.decision !== 'string' ||
    !SIZE_CHECK_NUMERIC_DECISIONS.has(sc.decision)
  ) {
    return [];
  }
  const missing: string[] = [];
  if (typeof sc.files !== 'number') missing.push('files');
  if (typeof sc.loc !== 'number') missing.push('loc');
  if (typeof sc.loc_method !== 'string' || !sc.loc_method.trim())
    missing.push('loc_method');
  return missing;
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
 * needsGate check. A marker recording a bare 'none'/'n/a' decision must also
 * carry a substantive, non-empty `reason` — the judgement that the change's
 * behaviour was assessed and found to have nothing runtime-observable,
 * distinguishing an assessed none from one that fell out of an empty
 * pre-groom body section. An 'items' decision needs no reason: the items
 * themselves are the evidence of assessment.
 */
function isGateContributionRecorded(
  type: string | undefined,
  taskId: string,
): { ok: boolean; reasons: string[] } {
  if (!type || !GATE_CONTRIBUTION_TYPES.has(type))
    return { ok: true, reasons: [] };
  const marker = getGateAccretionMarker(taskId);
  if (!marker) return { ok: false, reasons: [] };
  if (
    (marker.decision === 'none' || marker.decision === 'n/a') &&
    !marker.reason?.trim()
  ) {
    return {
      ok: false,
      reasons: [
        `gate_contribution is recorded as "${marker.decision}" without a substantive reason — a none/n/a ` +
          "decision must record why the groomer's own assessment of the change's runtime-observable " +
          'behaviour found nothing gate-worthy, not merely that the input section was empty.',
      ],
    };
  }
  return { ok: true, reasons: [] };
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

/**
 * Present-and-dispositioned, same posture as size_check/type_check: every
 * gate_contribution candidate must carry a non-empty classification string,
 * but the content of that classification is never judged — a groomer's
 * "needs-triage" call is accepted exactly as readily as "runtime-observable".
 * Absent an `entry.gateContributionCandidates` array entirely, this check
 * fails open (nothing to disposition).
 */
function isGateContributionCandidatesClassified(
  candidates: GateContributionCandidate[] | undefined,
): { ok: boolean; reasons: string[] } {
  if (!candidates || candidates.length === 0) return { ok: true, reasons: [] };
  const reasons = candidates
    .filter((c) => !c.classification || !`${c.classification}`.trim())
    .map(
      (c) =>
        `gate_contribution candidate "${c.text}" has no recorded classification — every candidate ` +
        'must be triaged runtime-observable / config-or-code-determined / needs-triage before promotion.',
    );
  return { ok: reasons.length === 0, reasons };
}

/**
 * Present-and-dispositioned, same posture as isGateContributionCandidatesClassified:
 * every seed_contribution candidate must carry a non-empty classification
 * string, but the content of that classification is never judged — a
 * groomer's "needs-triage" call is accepted exactly as readily as
 * "operational-seed". Absent an `entry.seedContributionCandidates` array
 * entirely, this check fails open (nothing to disposition).
 */
function isSeedContributionCandidatesClassified(
  candidates: GroomingGateEntry['seedContributionCandidates'],
): { ok: boolean; reasons: string[] } {
  if (!candidates || candidates.length === 0) return { ok: true, reasons: [] };
  const reasons = candidates
    .filter((c) => !c.classification || !`${c.classification}`.trim())
    .map(
      (c) =>
        `seed_contribution candidate "${c.spec}" has no recorded classification — every candidate ` +
        'must be triaged operational-seed / in-pr / needs-triage before promotion.',
    );
  return { ok: reasons.length === 0, reasons };
}

/**
 * Word-boundary match, excluding hyphenated compounds (e.g. `confirm-gate`,
 * `confirm-restart`) — a bare `includes` flagged those StepKind/playbook step
 * ids alongside real hedges. `\b` alone still rejects `Confirmed` (no
 * boundary between the two word characters at `m`/`e`).
 */
function tokenToHedgeRegex(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // eslint-disable-next-line security/detect-non-literal-regexp -- token is always one of the fixed FILES_PATHS_HEDGE_TOKENS constants above, never external input.
  return new RegExp(`\\b${escaped}\\b(?!-)`, 'i');
}

function filesPathsHedgeTokens(raw: string): string[] {
  return FILES_PATHS_HEDGE_TOKENS.filter((t) => tokenToHedgeRegex(t).test(raw));
}

/**
 * Whether an entry's verdict can actually change based on the real
 * `existsInRepo` value — an entry hedged or `*(new)*`-marked never reaches
 * FM2's existence branch, and one that already parses as a plausible repo
 * path (has a path separator + extension) passes the non-repo-work check
 * regardless of existence. Only entries outside both of those are worth
 * resolving a tracked-file set for; this lets a Ready-flip whose Files/paths
 * entries are all hedge-blocked / *(new)* / well-formed skip project
 * resolution entirely; consulted a real project (and its correspondingly
 * higher chance of resolution failure) only when the verdict genuinely
 * depends on the git-validated fact.
 */
function entryNeedsTrackedFileResolution(entry: FilesPathsEntry): boolean {
  const neededForResolveInArtifact =
    !entry.isNew && filesPathsHedgeTokens(entry.raw).length === 0;
  const neededForRepoWorkCheck = !looksLikeRepoPath(entry.raw);
  return neededForResolveInArtifact || neededForRepoWorkCheck;
}

/**
 * Re-derives the Files/paths entry list from the task body itself — the fix
 * for the incident this module's docstring (:25-31) and the
 * isFilesPathsDeclaringRepoWork docstring below describe: a session that
 * hand-retypes its `groomingGate.filesPathsEntries` payload (dropping
 * backticks, reflowing text) can change the verdict without changing the
 * artifact. When `taskBody` is supplied, the `## Files / paths affected`
 * section is parsed and git-validated straight from that body
 * (groomLoad.ts's own `parseFilesPathsEntries`) and the session-supplied
 * `entries` are not consulted at all for existence. Only resolves for
 * 💻 Code tasks — the two checks that consume this both fail-open for other
 * types. When `taskBody` is absent (a caller that hasn't been updated, or a
 * unit test exercising the other gate mechanics directly), this falls back
 * to re-deriving `existsInRepo` on the session-supplied `entries`. Either
 * way, the tracked-file lookup itself is skipped whenever the verdict can't
 * change (`entryNeedsTrackedFileResolution`) — cheaply pre-checked against
 * the body's raw list items (`parseFilesPathsRawItems`, no git access) when
 * `taskBody` is supplied, so a Ready-flip whose entries are all hedge-blocked
 * / `*(new)*` / well-formed never pays for a repo resolution it doesn't need.
 *
 * Deliberately does NOT fail open when the tracked-file set can't be
 * resolved (no project, no repoRoot, git failure): an unavailable oracle
 * silently admitting every entry as "exists" would be the same defect one
 * layer up, so that case instead returns a single blocking reason and
 * leaves the two Files/paths checks unevaluated (their answer would be
 * meaningless without a real tracked-file set to check against).
 *
 * `./groomLoad` is imported dynamically (not at module scope) so that
 * groomLoad.ts's own dependency footprint (git shell-out via
 * `child_process`, the Notion client) is only pulled in for the Ready-flips
 * that actually need a tracked-file lookup — groomGate.ts is imported far
 * more broadly (readinessGate, TaskWriteCommands, the precheck tool) than
 * groomLoad.ts is, and a static import would put that whole surface area on
 * every one of those callers' module graphs.
 */
/** Whether `markdown` carries a top-level `## Files / paths affected`-style heading at all, independent of whether that section has any content. */
function hasFilesPathsHeading(markdown: string): boolean {
  return markdown.split('\n').some(
    (line) =>
      /^#{1,3}\s/.test(line) &&
      line
        .replace(/^#+\s*/, '')
        .toLowerCase()
        .includes('files'),
  );
}

async function resolveFilesPathsEntriesServerSide(
  type: string | undefined,
  entries: FilesPathsEntry[] | undefined,
  projectId: string | undefined,
  taskBody: string | undefined,
  trackedFileSetCache?: TrackedFileSetCache,
): Promise<{ entries: FilesPathsEntry[] | undefined; blockedReason?: string }> {
  if (type !== '💻 Code') {
    return { entries };
  }

  // The candidate list a tracked-file lookup would actually be resolved
  // against: the body's own parsed raw items once `taskBody` is supplied and
  // actually carries a `## Files / paths affected` heading — defect 2's fix,
  // never the session's retyped payload — falling back to the
  // session-supplied `entries` when no body was supplied, or a supplied body
  // has no such heading at all (a task-writing.md violation on its own,
  // already blocked upstream by the readiness gate for a real Ready flip;
  // never a live path this loses precision on).
  const bodyHasFilesHeading = !!taskBody && hasFilesPathsHeading(taskBody);
  let bodySection: string | undefined;
  let candidates: { raw: string; isNew: boolean }[];
  if (bodyHasFilesHeading) {
    const { parseSection } = await import('../notion/NotionClient');
    const { parseFilesPathsRawItems } = await import('./groomLoad');
    bodySection = parseSection(taskBody as string, 'files');
    candidates = parseFilesPathsRawItems(bodySection);
  } else {
    candidates = entries ?? [];
  }

  if (
    candidates.length === 0 ||
    !candidates.some((e) =>
      entryNeedsTrackedFileResolution({
        raw: e.raw,
        isNew: e.isNew,
        existsInRepo: false,
      }),
    )
  ) {
    return {
      entries: bodyHasFilesHeading
        ? candidates.map((e) => ({ ...e, existsInRepo: false }))
        : entries,
    };
  }

  const repoRoot = projectId
    ? ProjectService.getById(projectId)?.projectDir
    : undefined;
  if (!repoRoot) {
    return {
      entries,
      blockedReason:
        'Files / paths affected could not be validated — no resolvable repository root for ' +
        `project "${projectId ?? 'unknown'}"; the tracked-file set this check requires is unavailable.`,
    };
  }
  const {
    resolveTrackedFileSet,
    filesPathsEntryExistsInRepo,
    parseFilesPathsEntries,
  } = await import('./groomLoad');
  let trackedFiles: Set<string>;
  try {
    trackedFiles = await resolveTrackedFileSet(repoRoot, trackedFileSetCache);
  } catch (err) {
    return {
      entries,
      blockedReason:
        'Files / paths affected could not be validated — the repository tracked-file set could not be ' +
        `resolved for project "${projectId}": ${(err as Error).message}`,
    };
  }
  if (bodyHasFilesHeading) {
    return {
      entries: parseFilesPathsEntries(bodySection ?? '', trackedFiles),
    };
  }
  return {
    entries: (entries ?? []).map((e) => ({
      ...e,
      existsInRepo: filesPathsEntryExistsInRepo(e.raw, trackedFiles),
    })),
  };
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

/** An external-source prefix such as `Notion:` or `Slack:` — a declared line naming work in another system, never a repo path. */
const EXTERNAL_PREFIX_RE = /^[A-Za-z][A-Za-z0-9 ]*:\s/;

/**
 * Whether a Files/paths entry's leading token could plausibly be a
 * repository path — the discriminator for the non-repo-path check below is
 * *shape*, not existence: a well-formed but not-yet-created source file
 * (`packages/backend/src/foo/bar.ts`, or a bare `a.ts` at repo root) must
 * parse as true, while a line naming work in another system
 * (`Notion: Design the per-flow arm model...`) must parse as false. Requires
 * a file extension on the leading token and rejects an explicit
 * external-source prefix. Resolves its candidate through groomLoad.ts's
 * `extractPathToken` (backtick-aware, same `cleanPathToken` normalisation)
 * rather than a naive split, so this and `filesPathsEntryExistsInRepo` never
 * disagree on what a given entry's path token is — a conventionally
 * backticked new-file entry (`` `src/foo/bar.py` (new) ``) must parse the
 * same whether or not it is backticked.
 */
export function looksLikeRepoPath(raw: string): boolean {
  const trimmed = raw.trim();
  if (EXTERNAL_PREFIX_RE.test(trimmed)) return false;
  const candidate = extractPathToken(trimmed);
  return !!candidate && /\.[A-Za-z0-9]+$/.test(candidate);
}

/**
 * The incident driver for this check (task 3ae22f91): a 💻 Code task's
 * Files/paths entry that is existsInRepo:false AND does not parse as a
 * plausible repo path (looksLikeRepoPath) declares work a dispatched Code
 * session's worktree+PR cannot perform — a Notion page, a decision record,
 * etc. Distinguishable from the legitimate case of a genuinely new source
 * file, which is existsInRepo:false but well-formed. Independent of FM2's
 * hedge/isNew check above (a session's own isNew label is not trustworthy —
 * the incident entry was mislabeled isNew:true) and of type_check's
 * advisory smuggle heuristic (which stayed "none" on this exact input) —
 * this check is deterministic and reported as its own gate reason, never
 * folded into type_check's disposition. Non-Code types fail-open.
 */
function isFilesPathsDeclaringRepoWork(
  type: string | undefined,
  entries: FilesPathsEntry[] | undefined,
): { ok: boolean; reasons: string[] } {
  if (type !== '💻 Code') return { ok: true, reasons: [] };
  const reasons: string[] = [];
  for (const e of entries ?? []) {
    if (!e.existsInRepo && !looksLikeRepoPath(e.raw)) {
      reasons.push(
        `Files/paths entry "${e.raw}" does not resolve to an existing repo file and does not parse as a ` +
          'plausible repository path (no path separator / file extension, or an explicit external-source ' +
          'prefix such as "Notion:") — a 💻 Code task cannot declare non-repo work; excise the entry or ' +
          're-type the task.',
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Re-derives each Depends On dependency's status/type from `task_cache`
 * (`getCachedStatus`/`getCachedType`) by id — the same precedent
 * `resolveFilesPathsEntriesServerSide` sets for Files/paths: a caller-staged
 * `dependsOnTasks` snapshot can carry a stale or wrong-vocabulary status
 * (e.g. the canonical `'Done'` rather than the display `'✅ Done'` the
 * DONE_STATUSES check actually compares against), so `dep.status`/`dep.type`
 * are never trusted directly. Falls back to the caller-supplied value only
 * when the dep id has no `task_cache` row — preserving the pre-existing
 * fail-closed posture for an unresolvable dependency.
 */
function resolveDependsOnTasksServerSide(
  dependsOnTasks: DependsOnTaskRef[] | undefined,
): DependsOnTaskRef[] {
  return (dependsOnTasks ?? []).map((dep) => {
    const cachedStatus = getCachedStatus(dep.id);
    const cachedType = getCachedType(dep.id);
    return {
      id: dep.id,
      type: cachedType ?? dep.type,
      status: cachedStatus ? STATUS_DISPLAY[cachedStatus] : dep.status,
    };
  });
}

/**
 * FM3 signal (a) — a non-Done 📐 Design / 📋 Planning / 🔎 Investigation
 * Depends On task can still reshape this task's scope, invalidating whatever
 * was groomed against it. Blocks promotion until that dependency reaches
 * ✅ Done (or is ⏭️ Deferred). `dependsOnTasks` must already be server-side
 * resolved (`resolveDependsOnTasksServerSide`) — this function trusts the
 * status/type it's handed.
 */
function isDependsOnGateClear(dependsOnTasks: DependsOnTaskRef[] | undefined): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  for (const dep of dependsOnTasks ?? []) {
    if (
      dep.type &&
      DEPENDS_ON_GATE_TYPES.has(dep.type) &&
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
 * ✅ Done. `dependsOnTasks` must already be server-side resolved
 * (`resolveDependsOnTasksServerSide`) — a caller-supplied `status`/`type` is
 * never trusted for the routed/cited lookups below.
 */
function isConstraintsDispositioned(
  entry: GroomingGateEntry,
  dependsOnTasks: DependsOnTaskRef[],
): {
  ok: boolean;
  reasons: string[];
} {
  const ids = bindingConstraintIdsForRegions(
    entry.regions ?? { packages: [], files: [] },
  );
  const dispositioned = entry.constraintsDispositioned ?? {};
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
 * Approve-by-standard triage is defined for triage-eligible types only —
 * 📐 Design / 📋 Planning (INTERACTIVE_TASK_TYPES) plus 🔧 Operational /
 * 🔎 Investigation (planning/triage.ts's TRIAGE_ELIGIBLE_TYPES, per the
 * clean-verdict standard locked in "Articulate the clean-verdict standard
 * for 🔧 Operational and 🔎 Investigation promotion"). 💻 Code (and any other
 * ineligible type) keeps the per-task human gate that approve-by-standard
 * would otherwise remove. `entry.triage` is session-supplied, like
 * `entry.type`: a dispatched session could otherwise attach a triage verdict
 * to any task type to buy it batched treatment. A Ready-flip carrying
 * `entry.triage` for a resolved type outside TRIAGE_ELIGIBLE_TYPES is
 * therefore rejected outright (never silently stripped), so the staging
 * session sees the mismatch and can re-stage without a triage block. `type`
 * here is always the caller's resolved type (authoritative when available —
 * see checkGroomingPromotionGate), never `entry.type` on its own.
 */
function isTriageEligibleForType(
  type: string | undefined,
  entry: GroomingGateEntry,
): { ok: boolean; reasons: string[] } {
  if (!entry.triage || isTriageEligibleType(type))
    return { ok: true, reasons: [] };
  return {
    ok: false,
    reasons: [
      `groomingGate.triage was recorded for task type "${type ?? 'unknown'}" — approve-by-standard triage ` +
        `applies only to triage-eligible types (${TRIAGE_ELIGIBLE_TYPES_LIST}); ` +
        'this type keeps the per-task human gate and must not carry a triage verdict. Re-stage without ' +
        'groomingGate.triage.',
    ],
  };
}

/**
 * Approve-by-standard promotion path for triage-eligible types (📐 Design /
 * 📋 Planning / 🔧 Operational / 🔎 Investigation — see
 * planning/triage.ts's TRIAGE_ELIGIBLE_TYPES) — the per-task server-enforced
 * records above stay required and type-agnostic; this is the one additional
 * gate that stands in for the per-item human decision those types no longer
 * carry. A triage-eligible task promotes only once its triage input floors
 * to 'clean', evaluated against that type's own registry-defined
 * required-heading fact (applyTriageFloorForType). 💻 Code (and any other
 * ineligible type) fails open — this check does not apply to it, so
 * auto-dispatched promotion is unaffected.
 */
function isInteractiveTriageClean(
  type: string | undefined,
  entry: GroomingGateEntry,
  dependsOnTasks: DependsOnTaskRef[],
): { ok: boolean; reasons: string[] } {
  if (!isTriageEligibleType(type)) return { ok: true, reasons: [] };
  if (!entry.triage) {
    return {
      ok: false,
      reasons: [
        `triage-eligible task type "${type}" requires a recorded triage verdict before promotion — ` +
          `types ${TRIAGE_ELIGIBLE_TYPES_LIST} require groomingGate.triage ` +
          '(`{"proposedVerdict": "clean"|"blocked"|"needs-attention", "hasOpenQuestionsHeading": true|false}`); ' +
          'promotion without a per-item human sign-off requires a clean verdict.',
      ],
    };
  }
  const hardBlockDepNotDone = dependsOnTasks.some(
    (dep) =>
      dep.type &&
      DEPENDS_ON_GATE_TYPES.has(dep.type) &&
      !(dep.status && DONE_STATUSES.has(dep.status)),
  );
  const hasRoutedConstraintConflict = Object.values(
    entry.constraintsDispositioned ?? {},
  ).some((d) => d.disposition === 'conflict_route');

  const floored = applyTriageFloorForType(type, {
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
          `a triage-eligible (${type}) task promotes without a per-item sign-off only once triaged clean.`,
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
 *
 * `projectId`, when resolvable to a project's repo, is used to re-derive
 * every Files/paths entry's `existsInRepo` from that repo's own tracked-file
 * set (`resolveFilesPathsEntriesServerSide`) before the two Files/paths
 * checks run — a session's own `existsInRepo` claim on its staged payload is
 * never trusted as the deciding value. Async because that re-derivation
 * shells out to git.
 *
 * `taskBody`, when supplied, is the task's current raw markdown — the
 * Files/paths entry list the two Files/paths checks evaluate is then parsed
 * straight out of its `## Files / paths affected` section, not out of
 * `entry.filesPathsEntries` (the session's own retyped transcription of that
 * section into its groomingGate payload). Every caller that already has the
 * task body in hand (or fetches it anyway for `checkReadiness`) should pass
 * it through so the verdict tracks the artifact, not the paraphrase.
 *
 * `trackedFileSetCache`, when supplied, memoizes the `git ls-files`-backed
 * tracked-file set `resolveFilesPathsEntriesServerSide` resolves against, so
 * a multi-member group commit (commitGroupIntents) can share one resolution
 * across every 💻 Code Ready-flip in the same commit instead of re-spawning
 * the subprocess once per member.
 */
export async function checkGroomingPromotionGate(
  entry: GroomingGateEntry,
  taskId: string,
  authoritativeType?: string,
  accretionOpts?: AccretionCheckOptions,
  projectId?: string,
  taskBody?: string,
  trackedFileSetCache?: TrackedFileSetCache,
): Promise<GroomingGateResult> {
  const reasons: string[] = [];
  const resolvedType = authoritativeType ?? entry.type;

  if (!isSizeCheckClassified(entry)) {
    reasons.push(
      'size_check is missing or malformed — every Code/Tooling task must have an explicit size ' +
        'classification recorded before promotion. Expected {"decision": "no_split"|"split_now"|"unsplittable"|"n/a"}.',
    );
  } else {
    const missingNumericFields = sizeCheckMissingNumericFields(entry);
    if (missingNumericFields.length > 0) {
      reasons.push(
        `size_check is missing required field(s): ${missingNumericFields.join(', ')} — a numeric ` +
          'size decision (no_split/split_now/unsplittable) must also record the files/loc/loc_method ' +
          'estimate the decision rests on, not judge whether that estimate is correct.',
      );
    }
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

  const { entries: serverFilesPathsEntries, blockedReason } =
    await resolveFilesPathsEntriesServerSide(
      resolvedType,
      entry.filesPathsEntries,
      projectId,
      taskBody,
      trackedFileSetCache,
    );
  if (blockedReason) {
    reasons.push(blockedReason);
  } else {
    reasons.push(
      ...isFilesPathsResolved(resolvedType, serverFilesPathsEntries).reasons,
    );
    reasons.push(
      ...isFilesPathsDeclaringRepoWork(resolvedType, serverFilesPathsEntries)
        .reasons,
    );
  }
  const resolvedDependsOnTasks = resolveDependsOnTasksServerSide(
    entry.dependsOnTasks,
  );
  reasons.push(...isDependsOnGateClear(resolvedDependsOnTasks).reasons);
  reasons.push(
    ...isConstraintsDispositioned(entry, resolvedDependsOnTasks).reasons,
  );
  reasons.push(...isTriageEligibleForType(resolvedType, entry).reasons);
  reasons.push(
    ...isInteractiveTriageClean(resolvedType, entry, resolvedDependsOnTasks)
      .reasons,
  );

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

  if (!opts?.skipGateContributionCheck) {
    const gateCheck = isGateContributionRecorded(resolvedType, taskId);
    if (!gateCheck.ok && gateCheck.reasons.length === 0) {
      reasons.push(
        'gate_contribution is not recorded — for 💻 Code tasks, accreteGateContribution ' +
          'must record a gate_accretion marker (items appended to the milestone gate, or an explicit ' +
          '"none"/"n/a" decision with a substantive reason) for this task before promotion.',
      );
    } else {
      reasons.push(...gateCheck.reasons);
    }
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

  reasons.push(
    ...isGateContributionCandidatesClassified(entry.gateContributionCandidates)
      .reasons,
  );

  reasons.push(
    ...isSeedContributionCandidatesClassified(entry.seedContributionCandidates)
      .reasons,
  );

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

/**
 * One staged-intent group member, as `findAutoApproveIneligibleTaskCreate`
 * needs to see it: its kind, and — for a `task.create` — the type its own
 * payload declares (never the group's subject task's type; see below).
 */
export interface GroupCommitMember {
  kind: string;
  /** For `task.create` only: the type field carried on that intent's own payload. */
  taskCreatePayloadType?: string;
}

/**
 * The multi-group /batch/commit approve-by-standard surface's task.create
 * guard: a `task.create` must never be created via that unattended,
 * many-groups-at-once disposition — regardless of the type it declares.
 * Task creation is a deliberate per-task human act; batch-committing many
 * groups on one clean-triage verdict is not that act, no matter what type
 * the minted task would be. The caller (stagedIntents.ts's
 * commitGroupIntents) must only invoke this when `opts.triageMilestoneLabel`
 * is set — i.e. only for the multi-group /batch/commit path. The
 * single-group `/approve` route (a human explicitly reviewing and approving
 * one specific group) is a deliberate per-task disposition and must remain
 * free to create a task.create of any type; it must never call this
 * function.
 */
export function findAutoApproveIneligibleTaskCreate(
  members: readonly GroupCommitMember[],
): { blocked: boolean; reasons: string[] } {
  const reasons = members
    .filter((m) => m.kind === 'task.create')
    .map(
      (m) =>
        `task.create${m.taskCreatePayloadType ? ` for type "${m.taskCreatePayloadType}"` : ''} cannot be ` +
        'created through the multi-group batch-commit approve-by-standard surface; commit this group ' +
        'individually through the single-group /approve route instead.',
    );
  return { blocked: reasons.length > 0, reasons };
}
