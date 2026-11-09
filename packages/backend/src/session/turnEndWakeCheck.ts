import { db } from '../db/db';
import {
  getSession,
  getOpenPRBySessionId,
  hasQueuedOrRunningTestRunForSession,
  hasPendingReviewDisputeForPR,
  hasActiveCapabilityRequestForSession,
  setSessionPauseReason,
} from '../db/queries';
import {
  parsePauseReasonSet,
  findAutomaticGateRecoveryEntry,
} from '../db/pauseReason';
import { parseVerdict } from '../github/pollUtils';
import { typedGetSetting } from '../config/settings';
import { recordEvent } from '../audit/AuditLog';
import { logger } from '../logger';

export type PendingWake =
  | 'test_run'
  | 'review_dispute'
  | 'staged_intent'
  | 'capability_request'
  | 'attribution_wait'
  | 'pr_in_flight';

export const TURN_END_CONTINUE_DIRECTIVE =
  'Nothing is pending that will wake you: no test run, no staged operator decision, and no pipeline stage in flight. ' +
  'Continue the task to its end state: fix, push, request tests, open the PR. ' +
  'If you are genuinely blocked, stage the matching intent (review.dispute, test.override, or session.requestCapability) instead of ending the turn.';

/** PR verdicts that need the session to push — the verdict was delivered and nothing is in flight. */
const SESSION_ACTIONABLE_VERDICTS = new Set([
  'needs_changes',
  'incomplete',
  'autofix_failed',
  'verify_failed',
]);

function hasHeldOperatorIntent(sessionId: string): boolean {
  const row = db
    .prepare<[string], { one: number }>(
      `SELECT 1 AS one FROM staged_intent
       WHERE session_id = ? AND state = 'staged'
         AND kind IN ('test.override', 'test.request', 'review.dispute')
       LIMIT 1`,
    )
    .get(sessionId);
  return row !== undefined;
}

function hasLiveAttributionWait(sessionId: string, now: number): boolean {
  const row = db
    .prepare<[string], { awaiting_disposition_at: number }>(
      `SELECT awaiting_disposition_at FROM test_request_runs
       WHERE session_id = ? AND state = 'failed'
         AND awaiting_disposition_at IS NOT NULL
       ORDER BY awaiting_disposition_at DESC LIMIT 1`,
    )
    .get(sessionId);
  if (!row) return false;
  const deadlineMs =
    typedGetSetting('attribution_wait_deadline_minutes') * 60_000;
  return now - row.awaiting_disposition_at < deadlineMs;
}

function isPrStageInFlight(sessionId: string): boolean {
  const pr = getOpenPRBySessionId(sessionId);
  if (!pr) return false;
  if (hasPendingReviewDisputeForPR(pr.pr_number, pr.repo)) return true;
  const verdict = parseVerdict(pr.review_result);
  if (verdict && SESSION_ACTIONABLE_VERDICTS.has(verdict)) return false;
  if (
    findAutomaticGateRecoveryEntry(
      parsePauseReasonSet(pr.pause_reason),
      'analyze',
    )
  ) {
    return false;
  }
  if (pr.merge_state === 'dirty' || pr.merge_state === 'blocked') return false;
  return true;
}

/** Returns the first registered pending wake for the session, or null when nothing will wake it. */
export function turnEndWakeCheck(
  sessionId: string,
  now: number = Date.now(),
): PendingWake | null {
  if (hasQueuedOrRunningTestRunForSession(sessionId)) return 'test_run';
  if (hasActiveCapabilityRequestForSession(sessionId))
    return 'capability_request';
  if (hasHeldOperatorIntent(sessionId)) return 'staged_intent';
  if (hasLiveAttributionWait(sessionId, now)) return 'attribution_wait';
  if (isPrStageInFlight(sessionId)) return 'pr_in_flight';
  return null;
}

export interface TurnEndWakeState {
  /** Consecutive no-wake turn ends with no tool call in between. */
  consecutiveNoWake: number;
}

export type TurnEndWakeOutcome =
  | 'skipped'
  | 'wake_pending'
  | 'resumed'
  | 'surfaced';

/**
 * Run at a non-terminal turn end of a standard session. Enqueues one continue
 * directive when nothing will wake the session; after two consecutive no-wake
 * turn ends with no tool call between them, surfaces to the operator instead.
 * The caller resets state.consecutiveNoWake when a tool call occurs.
 */
export async function handleTurnEnd(
  sessionId: string,
  state: TurnEndWakeState,
  enqueueFeedback: (
    sessionId: string,
    source: string,
    payload: string,
  ) => Promise<void>,
): Promise<TurnEndWakeOutcome> {
  const session = getSession(sessionId);
  if (!session || session.session_type !== 'standard') return 'skipped';
  if (turnEndWakeCheck(sessionId)) {
    state.consecutiveNoWake = 0;
    return 'wake_pending';
  }
  state.consecutiveNoWake += 1;
  const base = {
    actor_type: 'system' as const,
    actor_id: sessionId,
    project_id: session.project_id ?? null,
    task_id: session.task_id ?? null,
  };
  if (state.consecutiveNoWake >= 3) {
    return 'skipped';
  }
  if (state.consecutiveNoWake === 2) {
    setSessionPauseReason(sessionId, 'stalled_idle');
    recordEvent({
      ...base,
      event_type: 'task_orphan_surfaced',
      payload: {
        taskId: session.task_id ?? null,
        sessionId,
        reason: 'turn_end_no_wake_repeated',
      },
    });
    logger.info(
      `[turnEndWakeCheck] surfaced session ${sessionId} to operator after repeated no-wake turn ends`,
    );
    return 'surfaced';
  }
  recordEvent({
    ...base,
    event_type: 'turn_end_no_wake',
    payload: { session_id: sessionId },
  });
  try {
    await enqueueFeedback(
      sessionId,
      'system:turn_end_no_wake',
      TURN_END_CONTINUE_DIRECTIVE,
    );
  } catch (err) {
    logger.warn(
      `[turnEndWakeCheck] enqueueFeedback failed for ${sessionId}: ${(err as Error).message}`,
    );
  }
  return 'resumed';
}
