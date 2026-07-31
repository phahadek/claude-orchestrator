import { listStagedIntentsBySession } from '../db/queries';
import type { StagedIntentRow } from '../db/types';

/**
 * Staged-intent kind vocabulary shared between PlanningOrchestrator's own
 * checkTerminal (the turn-tracking terminal detector, with its
 * nudge/blocked-member bookkeeping) and AgentSession's clean-exit fast path
 * (groomSessionConcludedWithDecision below, a stateless subset check usable
 * outside a PlanningOrchestrator instance) — kept in one place so the two
 * never classify a staged intent differently.
 */

/** The deliberate-no-op marker kind — see stagedIntents.ts's KNOWN_INTENT_KINDS. */
export const NO_OP_INTENT_KIND = 'planning.noOp';

/** The ops_journal disposition kind — a staged transition counts as a decision. */
const OPS_JOURNAL_INTENT_KIND = 'journal.setState';

/**
 * Kinds that constitute "staged a decision" — every real task-write /
 * arch-write / gate / seed intent kind a groom or design session can stage.
 * Deliberately excludes decision.pickOne, session.requestCapability, and
 * completeness.disposition: those are questions/asks the session raises for
 * the operator, not decisions it has committed to, so staging one alone must
 * not mask a session that otherwise never decided anything.
 * OPS_JOURNAL_INTENT_KIND and NO_OP_INTENT_KIND count as decisions too (see
 * hasStagedDecision) but are tracked separately since they aren't task-writes.
 */
const DECISION_INTENT_KINDS: ReadonlySet<string> = new Set([
  'task.create',
  'task.setStatus',
  'task.setDependsOn',
  'task.updateBody',
  'task.patchBodySection',
  'task.setProperties',
  'task.setType',
  'task.archive',
  'task.move',
  'gate.accrete',
  'seed.stage',
  'arch.createUnit',
  'arch.updateUnit',
  'arch.supersedeUnit',
]);

/**
 * True once the session has ever staged (any lifecycle state — even a
 * since-rejected intent still proves the session produced a real decision)
 * at least one intent of a kind that counts as "staged a decision": a
 * task-write/arch-write/gate/seed intent, an ops_journal transition, or an
 * explicit no-op marker.
 */
export function hasStagedDecision(intents: StagedIntentRow[]): boolean {
  return intents.some(
    (i) =>
      DECISION_INTENT_KINDS.has(i.kind) ||
      i.kind === OPS_JOURNAL_INTENT_KIND ||
      i.kind === NO_OP_INTENT_KIND,
  );
}

/**
 * True when a groom session has, across its full lifetime, staged at least
 * one decision-bearing intent and none of its intents are still pending
 * disposition (state 'staged') or blocked on the operator/session
 * (needs_revision/pending_verification). A narrower, stateless subset of
 * PlanningOrchestrator.checkTerminal's own logic — it has no access to that
 * class's in-memory turn-tracking (stagedCountAtResume) or its
 * nudge/blocked-member side effects, so it only fast-paths the unambiguous
 * case: a session that plainly finished with a settled decision. Used by
 * AgentSession.handleCleanExit to let such a session reach done directly
 * instead of parking idle and waiting on PlanningOrchestrator's own
 * (asynchronous, event-driven) terminal check to catch up. Any other case —
 * nothing staged yet, something still pending, or a blocked member — still
 * parks idle and is handled by checkTerminal as before.
 */
export function groomSessionConcludedWithDecision(sessionId: string): boolean {
  const intents = listStagedIntentsBySession(sessionId);
  const stillPending = intents.some(
    (i) => i.kind !== NO_OP_INTENT_KIND && i.state === 'staged',
  );
  const hasBlocked = intents.some(
    (i) => i.state === 'needs_revision' || i.state === 'pending_verification',
  );
  return !stillPending && !hasBlocked && hasStagedDecision(intents);
}
