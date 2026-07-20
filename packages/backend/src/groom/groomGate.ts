/**
 * In-backend grooming promotion gate — the enforcement point the /groom
 * skill's gate usage rewires to as grooming state moves off the file-cache
 * PreToolUse hook (scripts/groom-gate.mjs) and into the orchestrator. Covers
 * the size_check, type_check, gate_contribution, and seed_contribution
 * artifacts; the hook's other checks (signoff, hard_block_deps,
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
 */

import { getAccretionMarker as getGateAccretionMarker } from '../gate/gateStore';
import { getAccretionMarker as getSeedAccretionMarker } from '../seed/seedStore';

const SIZE_CHECK_DECISIONS = new Set([
  'no_split',
  'split_now',
  'unsplittable',
  'n/a',
]);

/** Task types that require a gate_contribution accretion marker before Ready. */
const GATE_CONTRIBUTION_TYPES = new Set(['💻 Code', '🛠️ Tooling']);

/** Task types that require a seed_contribution accretion marker before Ready. */
const SEED_CONTRIBUTION_TYPES = new Set(['💻 Code', '🛠️ Tooling']);

export interface GroomingGateEntry {
  size_check?: { decision?: unknown; [key: string]: unknown } | null;
  type_check?: {
    decision?: unknown;
    disposition?: unknown;
    [key: string]: unknown;
  } | null;
  /** Display-format Task Type, e.g. '💻 Code' — decides whether gate_contribution is required. */
  type?: string;
}

export interface GroomingGateResult {
  allowed: boolean;
  reasons: string[];
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
 * — the task being promoted is its own source). Absent `type`, or a type
 * outside Code/Tooling, fail-open (allow) — mirrors groom-gate.mjs's
 * needsGate check.
 */
function isGateContributionRecorded(
  entry: GroomingGateEntry,
  taskId: string,
): boolean {
  if (!entry.type || !GATE_CONTRIBUTION_TYPES.has(entry.type)) return true;
  return getGateAccretionMarker(taskId) !== undefined;
}

/**
 * seed_contribution requires a durable seed_accretion marker for the task
 * being promoted (stageSeedContribution writes it, keyed by source task id —
 * the task being promoted is its own source). Absent `type`, or a type
 * outside Code/Tooling, fail-open (allow) — mirrors gate_contribution's
 * treatment and groom-gate.mjs's needsSeed check.
 */
function isSeedContributionRecorded(
  entry: GroomingGateEntry,
  taskId: string,
): boolean {
  if (!entry.type || !SEED_CONTRIBUTION_TYPES.has(entry.type)) return true;
  return getSeedAccretionMarker(taskId) !== undefined;
}

/** Checks the size_check / type_check / gate_contribution / seed_contribution artifacts of a grooming-state entry ahead of a Ready promotion. */
export function checkGroomingPromotionGate(
  entry: GroomingGateEntry,
  taskId: string,
): GroomingGateResult {
  const reasons: string[] = [];

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

  if (!isGateContributionRecorded(entry, taskId)) {
    reasons.push(
      'gate_contribution is not recorded — for 💻 Code and 🛠️ Tooling tasks, accreteGateContribution ' +
        'must record a gate_accretion marker (items appended to the milestone gate, or an explicit ' +
        '"none"/"n/a" decision) for this task before promotion.',
    );
  }

  if (!isSeedContributionRecorded(entry, taskId)) {
    reasons.push(
      'seed_contribution is not recorded — for 💻 Code and 🛠️ Tooling tasks, stageSeedContribution ' +
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
