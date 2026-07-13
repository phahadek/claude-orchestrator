import { getMergeCommitForTask } from '../db/queries';
import { logger } from '../logger';
import type { PRMergeWatcher, MergeCompletedPayload } from '../github/PRMergeWatcher';
import * as gateStore from './gateStore';

/**
 * Fills gate_item_source.merge_commit for every gate_item sourced from the
 * merged task, then recomputes min_deployed_commit on each. This is the
 * gate's only reaction to a merge — it never advances item state itself;
 * the reconciler's next tick (reconcileGateRunnability) picks up the new
 * min_deployed_commit and re-opens/marks-runnable as appropriate.
 */
export function handleMergeCompleted(payload: MergeCompletedPayload): void {
  const itemIds = gateStore.itemIdsBySourceTask(payload.notion_task_id);
  if (itemIds.length === 0) return;
  const now = new Date().toISOString();
  for (const itemId of itemIds) {
    gateStore.setSourceMergeCommit(
      itemId,
      payload.notion_task_id,
      payload.merge_commit,
    );
    gateStore.recomputeMinDeployedCommit(itemId, now);
  }
}

/**
 * Subscribes the gate to PRMergeWatcher's merge-completion signal. The gate
 * is a consumer, not a coupled caller — PRMergeWatcher has no knowledge of
 * gate_item/gate_item_source; it only emits `merge_completed`.
 */
export function registerGateMergeConsumer(watcher: PRMergeWatcher): void {
  watcher.on('merge_completed', (payload: MergeCompletedPayload) => {
    try {
      handleMergeCompleted(payload);
    } catch (err) {
      logger.error(
        `[gateMergeConsumer] handleMergeCompleted failed for task ${payload.notion_task_id}:`,
        err,
      );
    }
  });
}

export interface CatchUpMergeCommitsResult {
  filled: number;
}

/**
 * Durability net for the reconciler tick: fills any gate_item_source rows
 * still missing merge_commit whose source task's branch already shows
 * merged in local_branches — recovering a merge_completed event that was
 * missed (e.g. a backend restart mid-emit) without a permanently-lost fill.
 */
export function catchUpMergeCommits(): CatchUpMergeCommitsResult {
  const now = new Date().toISOString();
  let filled = 0;
  for (const sourceTaskId of gateStore.unfilledSourceTaskIds()) {
    const mergeCommit = getMergeCommitForTask(sourceTaskId);
    if (!mergeCommit) continue;
    for (const itemId of gateStore.itemIdsBySourceTask(sourceTaskId)) {
      gateStore.setSourceMergeCommit(itemId, sourceTaskId, mergeCommit);
      gateStore.recomputeMinDeployedCommit(itemId, now);
      filled++;
    }
  }
  return { filled };
}
