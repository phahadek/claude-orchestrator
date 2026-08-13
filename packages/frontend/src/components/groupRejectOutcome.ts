import type {
  StagedIntent,
  StagedIntentRejectOutcome,
} from '../api/stagedIntents';

/** The count of blocked members backing the reject-outcome default and the recover/commit guard — visible needs_revision/pending_verification members, or the backend-derived total when it's larger (covers hidden, auto-rejected members the frontend never sees). */
export function groupBlockedCount(intents: StagedIntent[]): number {
  const visibleBlockedCount = intents.filter(
    (intent) =>
      intent.state === 'needs_revision' ||
      intent.state === 'pending_verification',
  ).length;
  return Math.max(
    visibleBlockedCount,
    intents[0]?.groupBlockedMemberCount ?? 0,
  );
}

/** Mirrors the single-intent path's default (StagedIntentPanel): decline when any member is blocked, since pushing back a group with a blocked member is refused server-side; pushback otherwise. */
export function defaultGroupRejectOutcome(
  intents: StagedIntent[],
): StagedIntentRejectOutcome {
  return groupBlockedCount(intents) > 0 ? 'decline' : 'pushback';
}
