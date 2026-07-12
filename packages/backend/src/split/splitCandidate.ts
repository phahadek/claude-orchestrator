/**
 * Orchestrator-owned split-candidate detection — the "detect" half of the
 * detect → confirm → route flow (see Technical Architecture § Split). Split
 * itself is never performed inside a grooming session; a grooming session may
 * only nominate a candidate. This module is what turns the deterministic
 * size_check seed (packages/backend/src/groom/groomLoad.ts sizeCheckSeed —
 * files touched, already computed) into a trip/no-trip signal, and gates
 * whether that trip is strong enough to route to the dedicated split session
 * without a human in the loop.
 *
 * The 500-LoC floor and the files×lines/file estimate mirror the /groom
 * skill's manual heuristic (skills/groom/reference/presentation.md § Size
 * check) so the two paths agree on what "too big" means.
 */

/** Code/Tooling tasks default to under this estimated diff size. */
export const SIZE_FLOOR_LOC = 500;

/** Midpoint of the groom skill's "files touched × ~50-100 lines each" heuristic. */
const LOC_PER_FILE_ESTIMATE = 75;

/** A candidate more than this multiple over the floor auto-confirms without an operator. */
const AUTO_CONFIRM_FLOOR_MULTIPLE = 2;

export interface SizeCheckSeed {
  /** Deduped changed-file count (groomLoad.ts's sizeCheckSeed.files). */
  files: number;
  /** Explicit LoC estimate, when already known; otherwise derived from `files`. */
  locEstimate?: number;
}

export interface SplitCandidateResult {
  isCandidate: boolean;
  locEstimate: number;
  files: number;
  floor: number;
}

export function estimateLoc(seed: SizeCheckSeed): number {
  if (typeof seed.locEstimate === 'number') return seed.locEstimate;
  return seed.files * LOC_PER_FILE_ESTIMATE;
}

/** Trips when the estimated diff size exceeds the size floor. */
export function detectSplitCandidate(
  seed: SizeCheckSeed,
  floor: number = SIZE_FLOOR_LOC,
): SplitCandidateResult {
  const locEstimate = estimateLoc(seed);
  return {
    isCandidate: locEstimate > floor,
    locEstimate,
    files: seed.files,
    floor,
  };
}

export interface ConfirmSplitOptions {
  /** Explicit operator sign-off — always sufficient, regardless of heuristic margin. */
  operatorApproved?: boolean;
}

export interface ConfirmSplitResult {
  confirmed: boolean;
  reason: string;
}

/**
 * Confirm gate: a candidate more than AUTO_CONFIRM_FLOOR_MULTIPLE over the
 * floor auto-confirms (the heuristic margin is unambiguous); anything closer
 * to the floor needs explicit operator approval before routing to the
 * dedicated split session.
 */
export function confirmSplitCandidate(
  candidate: SplitCandidateResult,
  options: ConfirmSplitOptions = {},
): ConfirmSplitResult {
  if (!candidate.isCandidate) {
    return {
      confirmed: false,
      reason: 'not a split candidate: estimate is at or under the size floor',
    };
  }
  if (options.operatorApproved) {
    return { confirmed: true, reason: 'operator approved' };
  }
  if (candidate.locEstimate > candidate.floor * AUTO_CONFIRM_FLOOR_MULTIPLE) {
    return {
      confirmed: true,
      reason:
        `heuristic auto-confirm: estimate (${candidate.locEstimate} LoC) exceeds ` +
        `${AUTO_CONFIRM_FLOOR_MULTIPLE}x the size floor (${candidate.floor} LoC)`,
    };
  }
  return {
    confirmed: false,
    reason:
      'estimate is over the floor but within the auto-confirm margin — needs explicit operator approval',
  };
}
