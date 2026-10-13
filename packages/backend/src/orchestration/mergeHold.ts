/**
 * Per-session merge-hold flag: while the test lane merges latest dev into a
 * session's worktree, SessionManager.sendOrResume defers any wake to the
 * inbox so the session can't start mutating the tree mid-merge.
 */

const held = new Set<string>();
const releaseListeners = new Set<(sessionId: string) => void>();

/** Synchronously takes the hold; false when the session is already held. */
export function acquireMergeHold(sessionId: string): boolean {
  if (held.has(sessionId)) return false;
  held.add(sessionId);
  return true;
}

export function releaseMergeHold(sessionId: string): void {
  if (!held.delete(sessionId)) return;
  for (const fn of releaseListeners) fn(sessionId);
}

export function isMergeHeld(sessionId: string): boolean {
  return held.has(sessionId);
}

export function onMergeHoldReleased(
  fn: (sessionId: string) => void,
): () => void {
  releaseListeners.add(fn);
  return () => releaseListeners.delete(fn);
}
