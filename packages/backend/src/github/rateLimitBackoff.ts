import { logger } from '../logger';
import type { GitHubRateLimitError } from './types';
import type { ServerMessage } from '../ws/types';

/**
 * Module-level (not per-caller) rate-limit clock. GitHub's quota is
 * account-wide, so every caller sharing one clock means the first caller to
 * hit a 403 stops the rest from learning about exhaustion the hard way — by
 * burning another call. PRMergeWatcher, AutoMerger, ReviewerCommentsWatcher,
 * filePollutionCheck, CommitAttributionWatcher and PRReviewService all read
 * and write this same clock.
 */
let pausedUntil: Date | null = null;
let broadcasted = false;

/**
 * True while a prior GitHubRateLimitError's reset window hasn't elapsed yet.
 * Clears itself (and broadcasts github_rate_limit_cleared exactly once) the
 * first time it's checked after the reset time passes.
 */
export function isGitHubRateLimitActive(
  broadcast?: (msg: ServerMessage) => void,
): boolean {
  if (pausedUntil === null) return false;
  if (Date.now() < pausedUntil.getTime()) return true;
  pausedUntil = null;
  broadcasted = false;
  broadcast?.({ type: 'github_rate_limit_cleared' });
  return false;
}

export function getGitHubRateLimitPausedUntil(): Date | null {
  return pausedUntil;
}

/**
 * Records a GitHubRateLimitError against the shared clock and broadcasts
 * github_rate_limit_hit at most once per pause episode, regardless of how
 * many callers observe the 403.
 */
export function recordGitHubRateLimit(
  err: GitHubRateLimitError,
  source: string,
  broadcast?: (msg: ServerMessage) => void,
): void {
  pausedUntil = err.resetAt;
  logger.warn(
    `${source} GitHub rate-limited; backing off until ${err.resetAt.toISOString()}`,
  );
  if (!broadcasted) {
    broadcasted = true;
    broadcast?.({
      type: 'github_rate_limit_hit',
      resetAt: err.resetAt.toISOString(),
      limit: err.limit,
      used: err.used,
    });
  }
}

/** Test-only reset of the shared clock between cases. */
export function __resetGitHubRateLimitForTests(): void {
  pausedUntil = null;
  broadcasted = false;
}
