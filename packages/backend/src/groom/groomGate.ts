/**
 * In-backend grooming promotion gate — the enforcement point the /groom
 * skill's gate usage rewires to as grooming state moves off the file-cache
 * PreToolUse hook (scripts/groom-gate.mjs) and into the orchestrator. Covers
 * the size_check and type_check artifacts; the hook's other checks (signoff,
 * hard_block_deps, repo_assignment, gate/seed_contribution) migrate here in
 * follow-on tasks as their state moves backend-side.
 *
 * Both artifacts are "present-and-dispositioned" gates, not correctness
 * gates: the groomer must have recorded a decision, but a flagged type_check
 * never hard-blocks promotion on its own — see typeCheck.ts.
 */

const SIZE_CHECK_DECISIONS = new Set([
  'no_split',
  'split_now',
  'unsplittable',
  'n/a',
]);

export interface GroomingGateEntry {
  size_check?: { decision?: unknown; [key: string]: unknown } | null;
  type_check?: {
    decision?: unknown;
    disposition?: unknown;
    [key: string]: unknown;
  } | null;
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

/** Checks the size_check / type_check artifacts of a grooming-state entry ahead of a Ready promotion. */
export function checkGroomingPromotionGate(
  entry: GroomingGateEntry,
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
