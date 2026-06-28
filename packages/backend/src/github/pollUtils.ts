import type { PullRequestRow } from '../db/types';
import { parsePauseReason } from '../db/pauseReason';

export type StalledPRKind =
  | 'incomplete_verdict'
  | 'errored_review_session'
  | 'gate_failed'
  | 'analyze_failing'
  | 'pre_review_interrupted';

/**
 * True when a PR is in a terminal-stale state where PRMergeWatcher polling
 * would be pointless. Covers three parked anchors:
 *
 *  1. incomplete verdict + no new push (head_sha unchanged)
 *  2. gate-failure verdict (autofix_failed / verify_failed) with no pending push
 *  3. reconciler retry cap reached (stalled_reconcile_cap pause)
 *
 * Errored/killed review sessions are NOT included here — PRMergeWatcher still
 * runs mergeability checks on those. The StalledPRReconciler handles re-driving
 * all three states independently.
 */
export function isTerminalStalePR(pr: PullRequestRow): boolean {
  // Reconciler gave up — treat as terminal for polling purposes too
  const parsed = parsePauseReason(pr.pause_reason);
  if (parsed?.reason === 'stalled_reconcile_cap') return true;

  if (!pr.review_result) return false;

  let verdict: string | undefined;
  try {
    verdict = (JSON.parse(pr.review_result) as { verdict?: string }).verdict;
  } catch {
    return false;
  }

  // Incomplete verdict with no new push since last review
  if (
    verdict === 'incomplete' &&
    pr.head_sha !== null &&
    pr.head_sha === pr.last_reviewed_sha
  ) {
    return true;
  }

  // Gate-failure verdict with no push pending — the reconciler handles re-gate
  if (
    (verdict === 'autofix_failed' || verdict === 'verify_failed') &&
    !pr.review_session_id &&
    !pr.pending_push &&
    pr.head_sha === pr.last_reviewed_sha
  ) {
    return true;
  }

  return false;
}

/**
 * Classify which stalled state a PR is in, for use by StalledPRReconciler.
 * Returns null when the PR is not stalled (no action needed).
 *
 * Called with the session status resolved by the caller to avoid importing
 * session queries here.
 */
export function classifyStalledPR(
  pr: PullRequestRow,
  reviewSessionStatus: string | null,
): { kind: StalledPRKind } | null {
  // Already escalated — reconciler is done with this PR
  const parsed = parsePauseReason(pr.pause_reason);
  if (parsed?.reason === 'stalled_reconcile_cap') return null;

  if (!pr.head_sha) return null;

  // Analyze-gate failure: parked with analyze_failing and no pending push
  if (parsed?.reason === 'analyze_failing' && !pr.pending_push) {
    return { kind: 'analyze_failing' };
  }

  const verdict = parseVerdict(pr.review_result);

  // Gate-failed: verdict is autofix_failed/verify_failed, no pending push
  if (
    (verdict === 'autofix_failed' || verdict === 'verify_failed') &&
    !pr.pending_push
  ) {
    return { kind: 'gate_failed' };
  }

  // Incomplete verdict + no push since last review
  if (verdict === 'incomplete' && pr.head_sha === pr.last_reviewed_sha) {
    return { kind: 'incomplete_verdict' };
  }

  // Pre-review pipeline was interrupted on restart (or PR awaited its first
  // review): no verdict, no pending push, and no live/errored session holding
  // the slot. reviewSessionStatus is null when review_session_id is absent or
  // the session row is gone — exactly the cases that fall through everything
  // else and need a fresh enqueueReview.
  if (!pr.review_result && !pr.pending_push && !reviewSessionStatus) {
    return { kind: 'pre_review_interrupted' };
  }

  // Errored or killed review session
  if (
    pr.review_session_id &&
    (reviewSessionStatus === 'error' || reviewSessionStatus === 'killed')
  ) {
    return { kind: 'errored_review_session' };
  }

  return null;
}

function parseVerdict(reviewResult: string | null): string | undefined {
  if (!reviewResult) return undefined;
  try {
    return (JSON.parse(reviewResult) as { verdict?: string }).verdict;
  } catch {
    return undefined;
  }
}
