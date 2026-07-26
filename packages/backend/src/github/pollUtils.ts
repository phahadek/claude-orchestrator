import type { PullRequestRow } from '../db/types';
import { parsePauseReason } from '../db/pauseReason';

export type StalledPRKind =
  | 'incomplete_verdict'
  | 'errored_review_session'
  | 'gate_failed'
  | 'analyze_failing'
  | 'pre_review_interrupted'
  | 'conflict_dead_session'
  | 'undelivered_review_feedback'
  | 'orphaned_no_task_link';

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
 * Called with the session statuses resolved by the caller to avoid importing
 * session queries here. reviewSessionStatus covers the review session
 * (review_session_id); implementingSessionStatus covers the implementing
 * session (session_id) and is used for the conflict and undelivered-feedback
 * checks below. hasUndeliveredFeedback reports whether session_feedback_inbox
 * has rows still pending delivery to the implementing session — resolved by
 * the caller since inbox lookups are I/O.
 */
export function classifyStalledPR(
  pr: PullRequestRow,
  reviewSessionStatus: string | null,
  implementingSessionStatus: string | null = null,
  hasUndeliveredFeedback = false,
): { kind: StalledPRKind } | null {
  // Already escalated — reconciler is done with this PR
  const parsed = parsePauseReason(pr.pause_reason);
  if (parsed?.reason === 'stalled_reconcile_cap') return null;

  if (!pr.head_sha) return null;

  const verdict = parseVerdict(pr.review_result);

  const isDeadImplementingSession =
    implementingSessionStatus === 'done' ||
    implementingSessionStatus === 'error' ||
    implementingSessionStatus === 'killed';

  // Merge conflict/blocked with a dead implementing session: the live-session
  // nudge path (AutoMerger.conflictNudgeSweep) can't reach it, and re-reviewing
  // is pointless since nothing is left to push a rebase. Independent of verdict.
  if (
    (pr.merge_state === 'dirty' || pr.merge_state === 'blocked') &&
    isDeadImplementingSession
  ) {
    return { kind: 'conflict_dead_session' };
  }

  // Approved but unmergeable: GitHub computes mergeability asynchronously, so
  // an approval can land while merge_state is still 'unknown'. The caller
  // refreshes stale merge_state via GitHubClient before calling in — by the
  // time we get here mergeable/merge_state reflect the latest check. Treat a
  // genuine conflict (mergeable=0) the same as conflict_dead_session when the
  // implementing session is dead or idle (not live mid-rebase); a live session
  // is left to AutoMerger's conflict nudge instead.
  if (
    verdict === 'approved' &&
    pr.mergeable === 0 &&
    (pr.merge_state === 'dirty' ||
      pr.merge_state === 'blocked' ||
      pr.merge_state === 'unknown') &&
    (isDeadImplementingSession || implementingSessionStatus === 'idle')
  ) {
    return { kind: 'conflict_dead_session' };
  }

  // Analyze-gate failure: parked with analyze_failing and no pending push
  if (parsed?.reason === 'analyze_failing' && !pr.pending_push) {
    return { kind: 'analyze_failing' };
  }

  // Gate-failed: verdict is autofix_failed/verify_failed. A pending push here
  // means content the gate never saw arrived before the initial review session
  // was established (db.ts:278) and consumePendingPushIfSet no-ops without a
  // live session to notify — the reconciler still re-drives it (consuming the
  // pending push itself) rather than treating it as recoverable via the normal
  // push-detected path.
  if (verdict === 'autofix_failed' || verdict === 'verify_failed') {
    return { kind: 'gate_failed' };
  }

  // Incomplete verdict + no push since last review
  if (verdict === 'incomplete' && pr.head_sha === pr.last_reviewed_sha) {
    return { kind: 'incomplete_verdict' };
  }

  // Undelivered needs_changes feedback: the review completed and left
  // feedback in the implementing session's inbox, but the session went idle
  // before ever picking it up (a live session is handled by the wake-aware
  // delivery path, not this safety net).
  if (
    verdict === 'needs_changes' &&
    pr.head_sha === pr.last_reviewed_sha &&
    hasUndeliveredFeedback &&
    implementingSessionStatus === 'idle'
  ) {
    return { kind: 'undelivered_review_feedback' };
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

export function parseVerdict(reviewResult: string | null): string | undefined {
  if (!reviewResult) return undefined;
  try {
    return (JSON.parse(reviewResult) as { verdict?: string }).verdict;
  } catch {
    return undefined;
  }
}
