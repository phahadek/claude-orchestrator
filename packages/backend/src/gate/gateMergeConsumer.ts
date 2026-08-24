import {
  getMergeCommitForTask,
  findActiveGateVerifyMirrorForItem,
} from '../db/queries';
import { hasGateItemRehomedEvent } from '../audit/AuditLog';
import { logger } from '../logger';
import type {
  PRMergeWatcher,
  MergeCompletedPayload,
} from '../github/PRMergeWatcher';
import * as gateStore from './gateStore';
import type { GateItem } from './gateStore';
import { runWithConcurrency } from '../utils/concurrency';

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

const CATCH_UP_CONCURRENCY = 5;
const UNRESOLVED_BASE_BACKOFF_MS = 5 * 60 * 1000;
const UNRESOLVED_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

/**
 * The unresolved-attempt count at which catchUpMergeCommits stops silently
 * retrying forever and stages an operator-visible escalation instead. Under
 * the backoff schedule above (5min base, doubling, capped at 24h), the 8th
 * attempt lands roughly 2-3 days after the first failed lookup — well past
 * a transient GitHub hiccup, well before a human would have forgotten.
 */
const ESCALATION_ATTEMPT_THRESHOLD = 8;

/**
 * Injected sink for staging the escalation's Decision Inbox mirror — kept
 * separate from gateReconciler.ts's GateItemMirrorSink (rather than reusing
 * it directly) since gateReconciler.ts already imports catchUpMergeCommits
 * from this module; importing its sink back here would cycle. Wired at
 * server bootstrap, alongside configureGateItemMirrorSink. The retire side
 * of this mirror's lifecycle IS handled by gateReconciler's existing
 * reconcileHumanObservationMirrors scan (generalized to the
 * `'unresolved-source'` origin — see isUnresolvedSourceStillLive there),
 * since retiring only needs to read gate_item_source state, not this
 * module's in-memory attempt counters.
 */
export interface UnresolvedSourceEscalationSink {
  /** Stage a `gate.verify` mirror (origin: 'unresolved-source') for an item whose source's merge commit couldn't be resolved past the escalation ceiling. */
  stage(item: GateItem, evidence: string): void;
}

let configuredEscalationSink: UnresolvedSourceEscalationSink | null = null;

export function configureUnresolvedSourceEscalationSink(
  sink: UnresolvedSourceEscalationSink,
): void {
  configuredEscalationSink = sink;
}

/** Evidence text for a source that hit the escalation ceiling — distinguishes a cross-milestone rehome (source_task_id deliberately points at the archived pre-move task) from a plain dropped webhook / out-of-band merge. */
function escalationEvidence(sourceTaskId: string): string {
  if (hasGateItemRehomedEvent(sourceTaskId)) {
    return (
      'source task was rehomed across a milestone move; source_task_id ' +
      'points at the archived pre-move task per the audit-trail contract ' +
      "— supply the successor task's merge commit manually or reclassify"
    );
  }
  return (
    `merge commit could not be resolved after ${ESCALATION_ATTEMPT_THRESHOLD} ` +
    'attempts — check for a dropped webhook or a merge outside the tracked ' +
    'PR/branch flow'
  );
}

/**
 * Stages the escalation mirror for every gate_item sourced from
 * `sourceTaskId` — idempotent via findActiveGateVerifyMirrorForItem's
 * per-item, per-origin dedup, so calling this again on every subsequent
 * failed attempt past the ceiling is a no-op once the first mirror is live.
 */
function escalateUnresolvedSource(sourceTaskId: string): void {
  if (!configuredEscalationSink) return;
  const sink = configuredEscalationSink;
  const evidence = escalationEvidence(sourceTaskId);
  for (const itemId of gateStore.itemIdsBySourceTask(sourceTaskId)) {
    if (findActiveGateVerifyMirrorForItem(itemId, 'unresolved-source')) {
      continue;
    }
    const item = gateStore.getItem(itemId);
    if (!item) continue;
    sink.stage(item, evidence);
  }
}

interface UnresolvedAttempt {
  attempts: number;
  nextAttemptAt: number;
}

/**
 * Per-source backoff state for a source whose merge-commit lookup has come
 * back empty (deleted PR, private-repo access issue, transient GitHub
 * error). Without this, unfilledSourceTaskIds() re-offers the exact same
 * permanently-unresolved source every tick forever, each one a fresh live
 * GitHub API call with no cache and no give-up. Module-level and
 * in-memory — reset on process restart, which is fine since a restart is
 * also the case this durability net exists to retry.
 */
const unresolvedAttempts = new Map<string, UnresolvedAttempt>();

function unresolvedBackoffMs(attempts: number): number {
  return Math.min(
    UNRESOLVED_BASE_BACKOFF_MS * 2 ** (attempts - 1),
    UNRESOLVED_MAX_BACKOFF_MS,
  );
}

/**
 * Durability net for the reconciler tick: fills any gate_item_source rows
 * still missing merge_commit whose source task's branch already shows
 * merged in local_branches — recovering a merge_completed event that was
 * missed (e.g. a backend restart mid-emit) without a permanently-lost fill.
 * Candidates whose last lookup came back unresolved are skipped until their
 * backoff window elapses, and the rest are looked up with bounded
 * concurrency rather than one GitHub round-trip at a time.
 */
export async function catchUpMergeCommits(): Promise<CatchUpMergeCommitsResult> {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  let filled = 0;

  const candidates = gateStore
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
        if (attempts >= ESCALATION_ATTEMPT_THRESHOLD) {
          escalateUnresolvedSource(sourceTaskId);
        }
        return;
      }
      unresolvedAttempts.delete(sourceTaskId);
      for (const itemId of gateStore.itemIdsBySourceTask(sourceTaskId)) {
        gateStore.setSourceMergeCommit(itemId, sourceTaskId, mergeCommit);
        gateStore.recomputeMinDeployedCommit(itemId, now);
        filled++;
      }
    },
  );

  return { filled };
}
