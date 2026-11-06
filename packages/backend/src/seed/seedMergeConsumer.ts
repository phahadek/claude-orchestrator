import { getMergeCommitForTask } from '../db/queries';
import { logger } from '../logger';
import type {
  PRMergeWatcher,
  MergeCompletedPayload,
} from '../github/PRMergeWatcher';
import * as seedStore from './seedStore';
import { runWithConcurrency } from '../utils/concurrency';

/**
 * Fills seed_item_source.merge_commit for every seed_item sourced from the
 * merged task, then recomputes min_deployed_commit on each — the seed twin
 * of gateMergeConsumer.handleMergeCompleted. This is the seed store's only
 * reaction to a merge; it never advances item state itself.
 */
export function handleMergeCompleted(payload: MergeCompletedPayload): void {
  const itemIds = seedStore.itemIdsBySourceTask(payload.notion_task_id);
  if (itemIds.length === 0) return;
  const now = new Date().toISOString();
  for (const itemId of itemIds) {
    seedStore.setSourceMergeCommit(
      itemId,
      payload.notion_task_id,
      payload.merge_commit,
    );
    seedStore.recomputeMinDeployedCommit(itemId, now);
  }
}

/**
 * Subscribes the seed store to PRMergeWatcher's merge-completion signal —
 * the seed twin of registerGateMergeConsumer. The seed store is a consumer,
 * not a coupled caller; PRMergeWatcher has no knowledge of
 * seed_item/seed_item_source.
 */
export function registerSeedMergeConsumer(watcher: PRMergeWatcher): void {
  watcher.on('merge_completed', (payload: MergeCompletedPayload) => {
    try {
      handleMergeCompleted(payload);
    } catch (err) {
      logger.error(
        `[seedMergeConsumer] handleMergeCompleted failed for task ${payload.notion_task_id}:`,
        err,
      );
    }
  });
}

export interface CatchUpSeedMergeCommitsResult {
  filled: number;
}

const CATCH_UP_CONCURRENCY = 5;
const UNRESOLVED_BASE_BACKOFF_MS = 5 * 60 * 1000;
const UNRESOLVED_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

interface UnresolvedAttempt {
  attempts: number;
  nextAttemptAt: number;
}

/**
 * Per-source backoff state for a source whose merge-commit lookup has come
 * back empty — the seed twin of gateMergeConsumer's unresolvedAttempts.
 * Module-level and in-memory — reset on process restart, which is fine
 * since a restart is also the case this durability net exists to retry.
 */
const unresolvedAttempts = new Map<string, UnresolvedAttempt>();

function unresolvedBackoffMs(attempts: number): number {
  return Math.min(
    UNRESOLVED_BASE_BACKOFF_MS * 2 ** (attempts - 1),
    UNRESOLVED_MAX_BACKOFF_MS,
  );
}

/**
 * Durability net for the reconciler tick: resolves each seed item's source
 * task's merge commit (via getMergeCommitForTask — shared with the gate,
 * never re-derived) for every still-unfilled seed_item_source row, then
 * recomputes min_deployed_commit on each item that gained a fill. This is
 * also the backfill path for the 25 pre-existing rows that accreted before
 * this consumer existed — they show up as unfilled candidates on the first
 * tick same as any other.
 */
export async function catchUpSeedMergeCommits(): Promise<CatchUpSeedMergeCommitsResult> {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  let filled = 0;

  const candidates = seedStore
    .unfilledSourceTaskIds()
    .filter((sourceTaskId) => {
      const prior = unresolvedAttempts.get(sourceTaskId);
      return !prior || prior.nextAttemptAt <= nowMs;
    });

  await runWithConcurrency(
    candidates,
    CATCH_UP_CONCURRENCY,
    async (sourceTaskId) => {
      const mergeCommit = await getMergeCommitForTask(sourceTaskId);
      if (!mergeCommit) {
        const attempts =
          (unresolvedAttempts.get(sourceTaskId)?.attempts ?? 0) + 1;
        unresolvedAttempts.set(sourceTaskId, {
          attempts,
          nextAttemptAt: nowMs + unresolvedBackoffMs(attempts),
        });
        return;
      }
      unresolvedAttempts.delete(sourceTaskId);
      for (const itemId of seedStore.itemIdsBySourceTask(sourceTaskId)) {
        seedStore.setSourceMergeCommit(itemId, sourceTaskId, mergeCommit);
        seedStore.recomputeMinDeployedCommit(itemId, now);
        filled++;
      }
    },
  );

  return { filled };
}
