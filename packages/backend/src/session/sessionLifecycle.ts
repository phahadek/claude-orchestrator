/**
 * Two shared signals over a session's lifecycle, replacing the per-mechanism
 * ad hoc judgments StuckSessionMonitor/OrphanedTaskSweeper/PlanningOrchestrator
 * each used to make independently from code-session-shaped artifacts (a PR
 * row, a push event, a process exit) that groom/design/ops/gate-verify
 * sessions can't produce:
 *
 * - sessionIsLive: a single, fully type-agnostic check of session_events
 *   recency — any activity of any kind resets the clock, uniformly across
 *   every session type.
 * - sessionDidWork: branches on session capability (PR-opening vs
 *   stage-only vs ops-with-a-journal vs not-applicable), not an enumerated
 *   per-type table. It answers only "did this session produce something" —
 *   used to withhold a revert/notification, never to replace a mechanism's
 *   own stricter terminal-completion bar (e.g.
 *   PlanningOrchestrator.completeOpsTask's ops_journal.state === 'resolved'
 *   requirement for auto-completing to Done), which stays a separate check
 *   layered on top.
 */

import { runtimeSettings } from '../config';
import {
  getSession,
  getSessionLastActivityMs,
  getPRBySessionId,
  getLocalBranchBySession,
  listStagedIntentsBySession,
  getOpsJournalEntry,
} from '../db/queries';
import { isGateVerifySession } from './sessionPredicates';
import type { SessionType } from './sessionPredicates';
import type { StagedIntentState } from '../db/types';

/**
 * True iff the session has emitted a session_events row more recently than
 * the stuck-session notify threshold — the same "reschedule from last
 * activity" logic StuckSessionMonitor's timers already implement (see
 * StuckSessionMonitor.recordActivity), extracted here as a plain,
 * poll-friendly query so other consumers (and a restarted
 * StuckSessionMonitor guarding against a race between a just-landed
 * session_event and an already-queued timer callback) don't have to keep
 * their own copy. Uses the notify threshold — the tighter of the two
 * stuck-session bounds — since that's the general-purpose "is this session
 * actively being worked right now" signal; the pause threshold is a
 * separate, longer escalation bound StuckSessionMonitor still owns. A
 * session with no recorded activity at all is not live.
 */
export function sessionIsLive(sessionId: string): boolean {
  const lastActivityMs = getSessionLastActivityMs(sessionId);
  if (lastActivityMs === null) return false;
  const thresholdMs = runtimeSettings.session_notify_threshold_seconds * 1000;
  return Date.now() - lastActivityMs < thresholdMs;
}

/** True iff a merged/closed pull_requests row or a merged local branch exists for this session. */
function hasMergedOrClosedOutcome(sessionId: string): boolean {
  const pr = getPRBySessionId(sessionId);
  if (pr && (pr.state === 'merged' || pr.state === 'closed')) return true;
  const localBranch = getLocalBranchBySession(sessionId);
  return localBranch?.status === 'merged';
}

/** True iff this session ever opened a PR or has a local-branch row of its own. */
function hasOpenedPr(sessionId: string): boolean {
  return (
    getPRBySessionId(sessionId) !== null ||
    getLocalBranchBySession(sessionId) !== undefined
  );
}

/**
 * States that still count as "staged a decision": still on (or recoverable
 * to) the operator-facing decision surface, or already landed. Excludes
 * `superseded` (replaced by a later row, which is counted on its own
 * merits), `withdrawn` (retracted by the staging session itself), and
 * `rejected` (dispositioned away) — none leave anything for an operator to
 * act on.
 */
const DECISION_SURFACE_STATES: ReadonlySet<StagedIntentState> = new Set([
  'staged',
  'pending_verification',
  'approved',
  'needs_revision',
  'committed',
]);

/** True iff at least one staged_intent row for this session is still actionable or already landed. */
function hasStagedAnything(sessionId: string): boolean {
  return listStagedIntentsBySession(sessionId).some((intent) =>
    DECISION_SURFACE_STATES.has(intent.state),
  );
}

/** True iff the task's ops_journal entry has advanced past its initial 'pending' state. */
function opsJournalAdvancedPastPending(taskId: string): boolean {
  const entry = getOpsJournalEntry(taskId);
  return entry !== undefined && entry.state !== 'pending';
}

/**
 * True iff this session produced something recognizable as work, judged by
 * its capability rather than an enumerated per-type table:
 *
 * - standard (code session): PR/merge outcome.
 * - docs: PR/merge outcome if it opened one, else falls back to the
 *   staged-decision check — mirrors PlanningOrchestrator.completeDocsTask's
 *   existing fallback.
 * - groom / design / split: staged a decision (>=1 staged_intent row still
 *   on the decision surface or already committed — see
 *   DECISION_SURFACE_STATES).
 * - ops: staged a decision, OR (for a non gate-verify ops/investigation
 *   session) its ops_journal advanced past 'pending' — that category can do
 *   real recorded work without staging anything. A gate-verify session
 *   (task_id `gate-item:<id>`) has no ops_journal entry of its own, so it is
 *   judged by the staged-decision check alone.
 * - review: not applicable — a review session opens no PR and stages no
 *   decision of its own. Explicit branch rather than a fallthrough default.
 *
 * Adding a new SessionType member without adding a matching branch here
 * fails the build (no runtime default case — see the `never` assignment
 * below, the same pattern ws/router.ts uses for its own discriminated
 * union).
 */
export function sessionDidWork(sessionId: string): boolean {
  const session = getSession(sessionId);
  if (!session) return false;

  const sessionType = session.session_type as SessionType;
  const taskId = session.task_id;

  switch (sessionType) {
    case 'standard':
      return hasMergedOrClosedOutcome(sessionId);

    case 'docs':
      return hasOpenedPr(sessionId)
        ? hasMergedOrClosedOutcome(sessionId)
        : hasStagedAnything(sessionId);

    case 'groom':
    case 'design':
    case 'split':
      return hasStagedAnything(sessionId);

    case 'ops': {
      if (hasStagedAnything(sessionId)) return true;
      if (isGateVerifySession(taskId)) return false;
      return taskId !== null ? opsJournalAdvancedPastPending(taskId) : false;
    }

    case 'review':
    case 'depth_review':
      // Not applicable — a review/depth-review session fits neither the
      // PR-outcome nor the stage-only branch.
      return false;

    default: {
      const _exhaustive: never = sessionType;
      return _exhaustive;
    }
  }
}
