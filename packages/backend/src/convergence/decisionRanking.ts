import type { StagedIntentRow } from '../db/types';
import { normalizeTaskId } from '../tasks/taskId';
import type { MilestoneConvergence } from './convergenceService';

/**
 * Unblock-impact ranking for the milestone decision inbox (Technical
 * Architecture § "Decision surface & confirm-gate contract"). Orders a flat
 * list of staged decisions — no separate partition — by a composite key,
 * each criterion breaking ties in the one before it:
 *
 *  1. Blocking-axis membership — the intent's target task_id is currently
 *     blocking the milestone (per the convergence read-surface's tasks/ops
 *     axes). Acting on a green-blocking item outranks acting on an
 *     already-satisfied one.
 *  2. Decision kind/direction — progress > structural > scope-add >
 *     advisory-only (see classifyKindDirection below).
 *  3. Needs-attention boosts — a blocking annotation, a flagged/errored/
 *     usage_limited Tier-3 advisory, or an unanswered decision.pickOne
 *     floats an item up.
 *
 * Deliberately NOT "rank by distance reduction": a setStatus->Ready approval
 * doesn't shrink distanceToGreen (Backlog and Ready are both open) — it
 * advances the pipeline. Unblock-impact here means pipeline-advancement, not
 * Δdistance. Dependency fan-out (score by count of freed blocked dependents)
 * is a named future iteration, not implemented here.
 */

export type DecisionKindDirection =
  | 'progress'
  | 'structural'
  | 'scope_add'
  | 'advisory_only';

/**
 * setStatus is the pipeline-advancement kind — most visibly setStatus->Ready,
 * but any status transition advances the task through the pipeline.
 * review.dispute joins it: resolving one either way is the single unblocking
 * action for a PR otherwise parked on a verdict its author disputes.
 */
const PROGRESS_KINDS = new Set(['task.setStatus', 'review.dispute']);

/** Kinds that reshape an existing task's content/classification without advancing or widening scope. */
const STRUCTURAL_KINDS = new Set([
  'task.updateBody',
  'task.setDependsOn',
  'task.patchBodySection',
  'task.setProperties',
  'task.setType',
  'task.move',
  'arch.updateUnit',
  'arch.supersedeUnit',
  'journal.setState',
]);

/** Kinds that widen the milestone's scope by minting new work. */
const SCOPE_ADD_KINDS = new Set([
  'task.create',
  'arch.createUnit',
  'gate.accrete',
  'seed.stage',
]);

/** Everything else — question-intents, capability requests, archival, and other kinds with no direct pipeline/structural/scope effect. */
export function classifyKindDirection(kind: string): DecisionKindDirection {
  if (PROGRESS_KINDS.has(kind)) return 'progress';
  if (STRUCTURAL_KINDS.has(kind)) return 'structural';
  if (SCOPE_ADD_KINDS.has(kind)) return 'scope_add';
  return 'advisory_only';
}

const KIND_DIRECTION_RANK: Record<DecisionKindDirection, number> = {
  progress: 3,
  structural: 2,
  scope_add: 1,
  advisory_only: 0,
};

/**
 * Every task_id the convergence read-surface's per-axis blocking data names
 * as currently blocking the milestone. Only the tasks and ops axes are keyed
 * by task id — gate/seed axes key on their own item ids, not the source
 * task, so they're not joinable here.
 */
export function buildBlockingTaskIdSet(
  convergence: MilestoneConvergence | null,
): Set<string> {
  const ids = new Set<string>();
  if (!convergence) return ids;
  for (const item of convergence.axes.tasks.blocking) {
    ids.add(normalizeTaskId(item.id));
  }
  for (const item of convergence.axes.ops.blocking) {
    ids.add(normalizeTaskId(item.task_id));
  }
  return ids;
}

function isBlockingMember(
  row: StagedIntentRow,
  blockingTaskIds: Set<string>,
): boolean {
  if (!row.task_id) return false;
  return blockingTaskIds.has(normalizeTaskId(row.task_id));
}

/**
 * A blocking annotation (last apply attempt hard-blocked), a flagged/errored/
 * usage_limited Tier-3 semantic advisory (flagged means a real verdict raised
 * a concern; errored/usage_limited mean the classifier couldn't produce a
 * verdict at all — both need operator eyes), an unanswered decision.pickOne
 * question, or a gate.verify row reporting a `fail` disposition or carrying
 * an `origin` (a Human-Observation/consent mirror, either of which needs an
 * operator-supplied disposition no verifier can produce) — signals that the
 * operator's attention is specifically needed on this item, beyond its
 * ordinary kind/blocking-membership standing. A `pass`/`needs-setup`/
 * `not-yet-triggerable` verdict payload carries neither signal and is
 * unaffected, sorting by recency within its existing `advisory_only` tier.
 */
export function hasNeedsAttentionBoost(row: StagedIntentRow): boolean {
  if (row.annotation) {
    try {
      const parsed = JSON.parse(row.annotation) as { blocked?: boolean };
      if (parsed?.blocked) return true;
    } catch {
      /* malformed annotation — not a boost signal */
    }
  }
  if (row.advisory) {
    try {
      const parsed = JSON.parse(row.advisory) as { status?: string };
      if (
        parsed?.status === 'flagged' ||
        parsed?.status === 'errored' ||
        parsed?.status === 'usage_limited'
      ) {
        return true;
      }
    } catch {
      /* malformed advisory — not a boost signal */
    }
  }
  if (row.kind === 'decision.pickOne' && !row.answer) return true;
  if (row.kind === 'gate.verify') {
    try {
      const payload = JSON.parse(row.payload) as {
        disposition?: string;
        origin?: string;
      };
      if (payload?.disposition === 'fail') return true;
      if (payload?.origin) return true;
    } catch {
      /* malformed payload — not a boost signal */
    }
  }
  return false;
}

interface RankKey {
  blocking: 0 | 1;
  kindDirection: number;
  needsAttention: 0 | 1;
}

function computeRankKey(
  row: StagedIntentRow,
  blockingTaskIds: Set<string>,
): RankKey {
  return {
    blocking: isBlockingMember(row, blockingTaskIds) ? 1 : 0,
    kindDirection: KIND_DIRECTION_RANK[classifyKindDirection(row.kind)],
    needsAttention: hasNeedsAttentionBoost(row) ? 1 : 0,
  };
}

function compareRankKeys(a: RankKey, b: RankKey): number {
  if (a.blocking !== b.blocking) return b.blocking - a.blocking;
  if (a.kindDirection !== b.kindDirection) {
    return b.kindDirection - a.kindDirection;
  }
  return b.needsAttention - a.needsAttention;
}

/**
 * Orders staged decisions by unblock-impact, descending (highest-impact
 * first). Intents tied on every rank-key criterion break the tie
 * newest-first (created_at DESC) — a freshly staged intent of equal or
 * lower rank surfaces above older ones in its tier rather than sinking to
 * the bottom of a large tied block (e.g. a gate-heavy milestone's backlog
 * of gate.verify mirrors). Pass `null` for convergence (e.g. the
 * "unattributed" milestone bucket, which has no single milestone's
 * convergence to join against) to rank purely on kind/direction +
 * needs-attention.
 */
export function rankDecisions(
  intents: StagedIntentRow[],
  convergence: MilestoneConvergence | null,
): StagedIntentRow[] {
  const blockingTaskIds = buildBlockingTaskIdSet(convergence);
  return intents
    .map((row) => ({ row, key: computeRankKey(row, blockingTaskIds) }))
    .sort((a, b) => {
      const rankCmp = compareRankKeys(a.key, b.key);
      if (rankCmp !== 0) return rankCmp;
      return b.row.created_at - a.row.created_at;
    })
    .map((entry) => entry.row);
}
