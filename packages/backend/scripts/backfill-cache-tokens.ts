/**
 * One-off backfill: reconstructs sessions.cache_read_tokens/cache_creation_tokens
 * for sessions predating the live additive-persist fix in AgentSession.ts.
 *
 * Each 'result' event's usage.cache_read_input_tokens/cache_creation_input_tokens
 * is already the cumulative total across every API call *in that turn*, so the
 * session-wide cumulative total is the sum of those values across every 'result'
 * event in the session — the same additive rule the live fix applies per turn,
 * replayed over history.
 *
 * Sessions with events_pruned_at set have had their raw session_events deleted
 * and are NOT backfillable — they are skipped (counted, not estimated) so their
 * cache-token columns stay at whatever the live code already wrote (usually 0),
 * which downstream displays must treat as "unknown, pre-fix", not "confirmed zero".
 *
 * Run manually: npx ts-node packages/backend/scripts/backfill-cache-tokens.ts
 */
import {
  getAllSessionIds,
  getUnprunedSessionIds,
  getEventsBySession,
  setCacheTokensAbsolute,
} from '../src/db/queries';
import type { SessionEvent } from '../src/db/types';

export interface CacheTokenTotals {
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Sums cache_read_input_tokens/cache_creation_input_tokens across every
 * 'result' event in the given session_events. Exported for unit testing
 * against a fixture session's events independent of the DB.
 */
export function reconstructCacheTokenTotals(
  events: SessionEvent[],
): CacheTokenTotals {
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const event of events) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (payload.type !== 'result') continue;
    const usage = payload.usage as
      | {
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        }
      | undefined;
    if (!usage) continue;
    cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
  }
  return { cacheReadTokens, cacheCreationTokens };
}

export interface BackfillCacheTokensSummary {
  backfilled: number;
  skippedNoData: number;
  skippedPruned: number;
}

/**
 * Runs the backfill against every session in the DB. Sessions with
 * events_pruned_at set are fetched separately (via getUnprunedSessionIds)
 * and never touched — their absence from that list IS the skip.
 */
export function backfillCacheTokens(
  totalSessionCount: number,
): BackfillCacheTokensSummary {
  const unprunedIds = getUnprunedSessionIds();
  const skippedPruned = totalSessionCount - unprunedIds.length;

  let backfilled = 0;
  let skippedNoData = 0;
  for (const sessionId of unprunedIds) {
    const events = getEventsBySession(sessionId);
    const { cacheReadTokens, cacheCreationTokens } =
      reconstructCacheTokenTotals(events);
    if (cacheReadTokens === 0 && cacheCreationTokens === 0) {
      skippedNoData++;
      continue;
    }
    setCacheTokensAbsolute(sessionId, cacheReadTokens, cacheCreationTokens);
    backfilled++;
  }

  return { backfilled, skippedNoData, skippedPruned };
}

if (require.main === module) {
  const totalSessionCount = getAllSessionIds().length;
  const summary = backfillCacheTokens(totalSessionCount);
  // eslint-disable-next-line no-console
  console.log(
    `[backfill-cache-tokens] backfilled=${summary.backfilled} ` +
      `skippedNoData=${summary.skippedNoData} skippedPruned=${summary.skippedPruned}`,
  );
}
