import { logger } from '../logger';
import {
  getSession,
  listStagedIntentsByGroup,
  listStagedIntentsBySession,
  markSessionDone,
  setPendingApproveTerminal,
  clearPendingApproveTerminal,
  getSessionsWithPendingApproveTerminal,
  setTaskPauseReason,
  getPRBySessionId,
  setSessionTerminalCompletionReason,
  TERMINAL_SESSION_STATUSES,
  hasActiveCapabilityRequestForSession,
  listIdlePlanningSessionsEligibleForTerminalSweep,
  insertCompletingSignal,
} from '../db/queries';
import type {
  Session,
  StagedIntentRow,
  StagedIntentAnswer,
  StagedIntentState,
} from '../db/types';
import {
  isPlanningSession,
  isGateVerifySession,
  isInvestigateSession,
} from '../session/sessionPredicates';
import {
  getEntry,
  isSessionTerminalOpsState,
  sessionTerminalOpsStates,
  type OpsState,
} from '../ops/opsJournal';
import { getCachedType } from '../tasks/TaskWriteCommands';
import type { SessionManager } from '../session/SessionManager';
import type { ServerMessage } from '../ws/types';
import {
  verifyDispatchedGroupsForSession,
  sessionOwesGatedDesignArtifacts,
  findIncompleteOpsTerminalGroupsForSession,
  isOpsTerminalClosingSetMember,
} from '../routes/stagedIntents';
import { getTaskBackend } from '../tasks/TaskBackend';
import { emitTaskUpdated, broadcastTaskStatusChanged } from '../routes/tasks';
import { NO_OP_INTENT_KIND, hasStagedDecision } from './planningDecisionKinds';
import { runtimeSettings } from '../config';
import { recordEvent } from '../audit/AuditLog';
import type { Scheduler } from './Scheduler';

export const DESIGN_DONE_STATUS = '✅ Done';

/**
 * Terminal reasons that represent a genuinely completed design — the only
 * ones with authority to promote a design task to Done. A future terminal
 * reason must be consciously added here to gain that authority; it does not
 * inherit it by default. planning_operator_end is deliberately excluded: an
 * operator-ended session is not a completed design.
 */
const DESIGN_COMPLETING_REASONS = new Set([
  'planning_approved',
  'planning_no_pending_dispositions',
]);

/**
 * Shared closure guard for completeOpsTask and closeDeferredOpsTask: true
 * when this session holds a rejected or needs_revision staged intent that is
 * a member of one of its ops-terminal closing groups (see
 * groupHasOpsTerminalMember / OPS_TERMINAL_KINDS in routes/stagedIntents.ts).
 *
 * Scoped to the closing set rather than every intent the session ever
 * staged: a declined intent that has nothing to do with the closing decision
 * (e.g. an unrelated gate-verify proposal the operator correctly rejected,
 * with the session accounting for that reasoning in its own closing note)
 * must not permanently strand the task at In Progress. A rejected or
 * needs_revision member *inside* the closing set still blocks — it means
 * the closing decision itself was refused, or is still revisable and the
 * session may yet supersede it.
 */
function opsSessionHasBlockedClosingGroupMember(sessionId: string): boolean {
  return listStagedIntentsBySession(sessionId).some(
    (i) =>
      (i.state === 'rejected' || i.state === 'needs_revision') &&
      isOpsTerminalClosingSetMember(i),
  );
}

/**
 * The bounded self-correct re-turn nudge sent exactly once (per session) when
 * a dispatched planning session reaches terminal having staged nothing that
 * counts as a decision — see checkTerminal's noDecisionNudgeSent guard.
 */
const NO_DECISION_NUDGE_MESSAGE =
  'You reached terminal without staging — stage your decision, or an ' +
  'explicit no-op (planning.noOp) if nothing needs changing. The chat ' +
  'write-up is not the deliverable.';

/**
 * The bounded self-correct re-turn nudge sent once per distinct blocked-set
 * (see checkTerminal's blockedMembersNudgeSentFor guard) when a planning
 * session ends its turn while holding staged intents of its own at
 * needs_revision/pending_verification — the resumable twin of
 * surfaceBlockedMembersPauseReason, which only covers a session that is
 * already terminal or has no live process. Names the blocked intent ids so
 * the session's next turn can act on (supersede/answer) exactly those.
 */
function formatBlockedMembersNudgeMessage(
  blockedMembers: StagedIntentRow[],
): string {
  return (
    `You ended your turn holding ${blockedMembers.length} of your own staged ` +
    'intent(s) blocked at needs_revision/pending_verification: ' +
    `${blockedMembers.map((i) => i.id).join(', ')}. Resolve these — supersede ` +
    'a needs_revision intent with a corrected one, or address whatever ' +
    'pending_verification is waiting on — before ending the turn again.'
  );
}

/**
 * The bounded self-correct re-turn nudge sent exactly once (per session)
 * when a dispatched ops session reaches terminal with its ops_journal entry
 * still at an intermediate waypoint for its task's Type — see checkTerminal's
 * noDecisionNudgeSent guard (shared with NO_DECISION_NUDGE_MESSAGE) and
 * isSessionTerminalOpsState.
 */
function opsJournalNotTerminalNudgeMessage(state: OpsState): string {
  return (
    `You reached terminal with the ops journal still at "${state}" — that ` +
    'is not a session-reachable terminal state. Continue the investigation ' +
    'to its type-appropriate terminal (resolved, or applied-pending-confirm ' +
    'for an Operational run), or stage journal.setState -> "blocked" if you ' +
    'genuinely cannot proceed.'
  );
}

type PlanningDisposition = 'approve' | 'pushback' | 'decline' | 'answer';

export interface PlanningDispositionPayload {
  intent: StagedIntentRow;
  disposition: PlanningDisposition;
  /** Operator-supplied rationale — required for pushback and decline. */
  reason?: string | null;
  /** The operator's answer to a decision.pickOne question-intent — required for the `answer` disposition. */
  answer?: StagedIntentAnswer | null;
  /**
   * Who produced this disposition — an operator decision (default) or an
   * automatic validator rejection (stage-time/apply-time payload validation
   * failure, routed here as a `pushback`). Only meaningfully distinguishes
   * pushback/decline: it changes the enqueueFeedback `source` label and the
   * message framing so the session can tell a validation failure it must fix
   * itself from an operator judgement call, rather than reading both as the
   * same `[operator-disposition]`-prefixed feedback.
   */
  provenance?: 'auto' | 'operator';
}

/**
 * Turn-based park/resume correlation layer for groom/design (planning)
 * sessions — mirrors ReviewOrchestrator's role for PR reviews, but is a thin
 * correlation shim over the existing session lifecycle rather than a
 * parallel stack:
 *  - "park" is just the existing idle status (AgentSession.handleCleanExit
 *    already marks a planning session idle on clean exit).
 *  - "resume" is the existing CLI --resume path (SessionManager.enqueueFeedback
 *    / sendOrResume), reused verbatim.
 *  - boot redrive of a still-running turn is resumeOrphanSessions, unchanged.
 *
 * What this class actually adds:
 *  1. Disposition routing — an operator pushback/decline/answer on a staged
 *     intent resumes the intent's originating session with the outcome as
 *     the next turn's input, since those are decisions the session's next
 *     turn is waiting on. An approve is acknowledgment, not a decision, so
 *     it never resumes per intent (grooming decision 2026-07-26) — see
 *     handleApproveDisposition, which instead drives the session terminal
 *     once its group's approvals complete the mandate, or resumes it once,
 *     coalesced, if other staged work remains.
 *  2. Terminal detection — once a planning session parks again, if no
 *     un-dispositioned (state='staged') intents remain for it and the turn
 *     that just ended staged nothing new, the session is driven to a
 *     terminal (done) state rather than left idle forever. checkTerminal is
 *     public so handleApproveDisposition (nothing re-dispatches the session
 *     after its final disposition, so it never re-parks and onSessionParked
 *     alone would never fire for that case) can also invoke it directly.
 */
export class PlanningOrchestrator {
  /** Total intent count (any state) observed for a session at its last resume — lets the next park detect whether that turn staged anything new. */
  private stagedCountAtResume = new Map<string, number>();

  /**
   * Sessions whose mandate-complete approval landed while a turn was still
   * in flight (AgentSession.hasActiveTurn(), e.g. the session was resumed by
   * a concurrent capability grant). markTerminal is deferred rather than
   * dropped — applying it here would race the live turn, but forgetting it
   * would park the session forever. Mirrored to the durable
   * pending_approve_terminal_at column (setPendingApproveTerminal) so a
   * backend restart before the drain fires doesn't lose it — see
   * SessionManager.resumeOrphanSessions' boot-time sweep. Applied on the
   * turn-boundary result event for that session, or on session_ended as a
   * safety net for a session that does exit.
   */
  private pendingApproveTerminal = new Set<string>();

  /**
   * Sessions that have already received the one bounded terminal-no-decision
   * nudge (see checkTerminal) — a separate, session-scoped budget from
   * handlePlanningSessionCrash's task_crash_counts, so the nudge never
   * double-penalizes a session against the crash budget.
   */
  private noDecisionNudgeSent = new Set<string>();

  /**
   * Sessions that have already received the bounded blocked-members re-turn
   * nudge (see checkTerminal), keyed by session id to the exact blocked
   * intent id set (sorted, joined) the nudge named — a session-scoped budget
   * of one nudge per distinct blocked set, so a session that ignores the
   * nudge and ends its turn again with the *same* set unresolved escalates
   * to surfaceBlockedMembersPauseReason instead of being nudged forever,
   * while a set that changes (operator dispositions some, session supersedes
   * others) earns a fresh nudge.
   */
  private blockedMembersNudgeSentFor = new Map<string, string>();

  constructor(private sessionManager: SessionManager) {
    sessionManager.on('message', (msg: ServerMessage) => this.onMessage(msg));
  }

  private onMessage(msg: ServerMessage): void {
    // Turn-boundary signal: fires the instant a turn's result event is
    // processed, whether the session then parks alive (the normal resting
    // state for a dispatched planning session, status stays 'running') or
    // exits — unlike session_ended, which only fires on actual process exit.
    if (msg.type === 'session_event' && msg.eventType === 'result') {
      const wentTerminal = this.applyPendingApproveTerminal(msg.sessionId);
      if (!wentTerminal) {
        this.checkBlockedMembersNudgeOnTurnEnd(msg.sessionId);
      }
      return;
    }
    if (msg.type !== 'session_ended') return;
    if (this.applyPendingApproveTerminal(msg.sessionId)) return;
    if (msg.status !== 'idle') return;
    void this.onSessionParked(msg.sessionId);
  }

  /** Returns true if a deferred approve-terminal was pending and has now been applied. */
  private applyPendingApproveTerminal(sessionId: string): boolean {
    if (!this.pendingApproveTerminal.has(sessionId)) return false;
    this.pendingApproveTerminal.delete(sessionId);
    clearPendingApproveTerminal(sessionId);

    // The approval that justified this deferral was evaluated once, at defer
    // time — the deferral window itself (the turn staying live) is exactly
    // the interval in which the session can stage new terminal artifacts.
    // Re-check the precondition now rather than trusting the stale verdict:
    // if un-dispositioned intents exist, this session's approval is no
    // longer complete, so fall through to the normal park path (the caller's
    // session_ended handling, or the next park) instead of going terminal —
    // it needs to stay alive awaiting disposition of what it just staged.
    const stillPending = listStagedIntentsBySession(sessionId).some(
      (i) => i.kind !== NO_OP_INTENT_KIND && i.state === 'staged',
    );
    if (stillPending) {
      logger.info(
        `[PlanningOrchestrator] ${sessionId.slice(0, 8)} deferred approve-terminal drained but new intents were staged during the deferral window — not marking terminal`,
      );
      return false;
    }

    // The turn that was in flight when this was deferred has now ended (this
    // is only reached from the turn-boundary result event or session_ended),
    // so skipInFlightGuard is safe even though the session's DB status may
    // still read 'running' — its normal resting state while parked alive.
    this.markTerminal(sessionId, 'planning_approved', {
      skipInFlightGuard: true,
    });
    return true;
  }

  /**
   * Boot-time backstop for pendingApproveTerminal: a deferred
   * approve-terminal transition that was durably recorded
   * (pending_approve_terminal_at) but never reached its turn-boundary drain
   * — e.g. the backend restarted between the defer and the session's
   * result/session_ended message. No live process exists yet for any
   * session this early in boot, so the turn that was in flight when this was
   * deferred has certainly ended by now; apply it unconditionally rather
   * than leaving the row stranded at status='running' forever.
   */
  reconcilePendingApproveTerminals(): void {
    for (const row of getSessionsWithPendingApproveTerminal()) {
      this.pendingApproveTerminal.delete(row.session_id);
      clearPendingApproveTerminal(row.session_id);
      this.markTerminal(row.session_id, 'planning_approved', {
        skipInFlightGuard: true,
      });
    }
  }

  /**
   * Turn-end: the dispatched session's turn completing is the "group
   * submitted" signal (grooming decision 2026-07-24) — before checking for
   * terminal state, gate every proposal group the session touched this turn
   * through verifyDispatchedGroupsForSession. A group blocked (and not yet
   * escalated) is fed back to the session via enqueueFeedback so it can
   * self-correct in a resumed turn; the terminal check is skipped in that
   * case since the session is about to resume anyway.
   */
  private async onSessionParked(sessionId: string): Promise<void> {
    const row = getSession(sessionId);
    if (!row || !isPlanningSession(row.session_type ?? '')) return;

    const fedBack = await this.verifyAndRoutePendingGroups(sessionId);
    if (fedBack) return;
    this.checkTerminal(sessionId);
  }

  /**
   * Turn-boundary twin of checkTerminal's blocked-members nudge — reachable
   * from the result event alone, since a session that merely ends a turn and
   * stays resumable (the common case) never emits session_ended and so never
   * reaches onSessionParked/checkTerminal. Shares checkBlockedMembersNudge's
   * detection and per-blocked-set budget with checkTerminal so a set nudged
   * here does not also collect a fresh nudge at the session's next park, and
   * deliberately does not drive the session terminal — that stays
   * checkTerminal's alone, since running it at every turn boundary would end
   * the session's process on this path too, which is not appropriate here.
   */
  private checkBlockedMembersNudgeOnTurnEnd(sessionId: string): void {
    const row = getSession(sessionId);
    if (!row || !isPlanningSession(row.session_type ?? '')) return;
    const all = listStagedIntentsBySession(sessionId);
    this.checkBlockedMembersNudge(sessionId, all);
  }

  /** Returns true if at least one blocked, non-escalated group's errors were routed back to the session (i.e. it is about to resume). */
  private async verifyAndRoutePendingGroups(
    sessionId: string,
  ): Promise<boolean> {
    const outcomes = await verifyDispatchedGroupsForSession(sessionId);
    const blocked = outcomes.filter((o) => !o.passed && !o.escalated);

    for (const outcome of blocked) {
      try {
        await this.sessionManager.enqueueFeedback(
          sessionId,
          'verification-error',
          formatVerificationFeedback(outcome.groupId, outcome.errors),
        );
      } catch (err) {
        logger.error(
          `[PlanningOrchestrator] resume failed for session ${sessionId.slice(0, 8)} after group verification failure: ${err}`,
        );
      }
    }
    return blocked.length > 0;
  }

  /**
   * True when no un-dispositioned intents remain for the session AND its
   * latest resumed turn staged nothing new. Drives the session to a
   * terminal (done) state as a side effect when true.
   *
   * stagedCountAtResume is refreshed here — to the current total — on every
   * non-terminal call, not just from a disposition. checkTerminal runs on
   * every park (onSessionParked fires on every session_ended/idle message —
   * a turn that merely ends and stays resumable does not park and does not
   * reach checkTerminal; see checkBlockedMembersNudgeOnTurnEnd for that
   * case), so anchoring the snapshot to "count as of the last park" rather
   * than "count as of the last disposition" makes the comparison
   * self-correcting: a resume that isn't routed through handleDisposition/
   * handleGroupDisposition (e.g. a capability-grant resume) can no longer
   * leave the snapshot stale, and a park whose turn staged nothing new is
   * detected the very next time checkTerminal runs — including the park
   * that follows a session's final disposition, with no further apply
   * required.
   */
  /**
   * Core completeness predicate shared by the live event-driven path
   * (checkTerminal) and the cold idle-sweep path
   * (isSessionCompleteForIdleSweep) — a staged no-op marker requires no
   * operator disposition, and staging one is itself the terminal signal
   * rather than "new work" a next turn must settle, so it is excluded from
   * the pending gate. `owesGatedArtifacts`: a session whose
   * completeness.disposition was just approved still owes its gated
   * architecture-unit / closing-synthesis write even though nothing is left
   * `staged` — that approval is a precondition for further staging, not the
   * end of the session's mandate. See sessionOwesGatedDesignArtifacts.
   */
  private computeStagedIntentState(sessionId: string): {
    all: StagedIntentRow[];
    countable: StagedIntentRow[];
    stillPending: boolean;
    owesGatedArtifacts: boolean;
  } {
    const all = listStagedIntentsBySession(sessionId);
    const countable = all.filter((i) => i.kind !== NO_OP_INTENT_KIND);
    const stillPending = countable.some((i) => i.state === 'staged');
    const owesGatedArtifacts = sessionOwesGatedDesignArtifacts(sessionId);
    return { all, countable, stillPending, owesGatedArtifacts };
  }

  /**
   * The session's ops_journal state, if it is a task the session may not yet
   * conclude on — i.e. an ops session (not gate-verify) with a journal entry
   * that sits below its task Type's session-reachable terminal set (see
   * isSessionTerminalOpsState). Returns undefined for every case that must
   * pass through unaffected: a non-ops session, a gate-verify session (no
   * Notion task), a task with no journal entry at all, or a journal already
   * at a state the session is allowed to stop on (including blocked, which
   * is a fully acceptable terminal outcome for every task Type).
   */
  private incompleteOpsJournalStateFor(sessionId: string): OpsState | null {
    const row = getSession(sessionId);
    if (!row || row.session_type !== 'ops' || !row.task_id) return null;
    if (isGateVerifySession(row.task_id)) return null;
    const entry = getEntry(row.task_id);
    if (!entry) return null;
    const taskType = getCachedType(row.task_id);
    if (isSessionTerminalOpsState(entry.state, taskType)) return null;
    return entry.state;
  }

  /**
   * Resumable twin of surfaceBlockedMembersPauseReason: a session that ends
   * its turn holding its own needs_revision/pending_verification intents is
   * still alive to supersede/resolve them, so re-engage it with a bounded
   * nudge instead of falling straight through to terminal (which would
   * otherwise surface the pause reason and end the process while it could
   * still self-correct). Shared by checkTerminal (checked ahead of its
   * reachedTerminal gate, since a blocked member matters regardless of
   * whether other intents are still awaiting disposition) and
   * checkBlockedMembersNudgeOnTurnEnd (the turn-boundary path that must not
   * drive the session terminal). `all` is passed in rather than refetched
   * here since both callers already have it.
   */
  private checkBlockedMembersNudge(
    sessionId: string,
    all: StagedIntentRow[],
  ): { blockedMembers: StagedIntentRow[]; blockedBudgetExhausted: boolean } {
    const blockedMembers = all.filter(
      (i) => i.state === 'needs_revision' || i.state === 'pending_verification',
    );
    const blockedKey = blockedMembers
      .map((i) => i.id)
      .sort()
      .join(',');
    const blockedBudgetExhausted =
      blockedMembers.length > 0 &&
      this.blockedMembersNudgeSentFor.get(sessionId) === blockedKey;

    if (blockedMembers.length > 0 && !blockedBudgetExhausted) {
      this.blockedMembersNudgeSentFor.set(sessionId, blockedKey);
      const countable = all.filter((i) => i.kind !== NO_OP_INTENT_KIND);
      this.stagedCountAtResume.set(sessionId, countable.length);
      this.sessionManager
        .enqueueFeedback(
          sessionId,
          'planning-terminal-blocked-members-nudge',
          formatBlockedMembersNudgeMessage(blockedMembers),
        )
        .catch((err) => {
          logger.error(
            `[PlanningOrchestrator] resume failed for session ${sessionId.slice(0, 8)} after blocked-members nudge: ${err}`,
          );
        });
    }

    return { blockedMembers, blockedBudgetExhausted };
  }

  checkTerminal(sessionId: string): boolean {
    const { all, countable, stillPending, owesGatedArtifacts } =
      this.computeStagedIntentState(sessionId);

    const { blockedMembers, blockedBudgetExhausted } =
      this.checkBlockedMembersNudge(sessionId, all);
    if (blockedMembers.length > 0 && !blockedBudgetExhausted) {
      return false;
    }

    const priorCount = this.stagedCountAtResume.get(sessionId) ?? 0;
    const stagedNothingNew = countable.length <= priorCount;
    const reachedTerminal =
      blockedBudgetExhausted ||
      (!stillPending && stagedNothingNew && !owesGatedArtifacts);

    if (!reachedTerminal) {
      this.stagedCountAtResume.set(sessionId, countable.length);
      return false;
    }

    // An investigate-dispatched session (task_id `report-batch:<batchId>`)
    // that stages nothing is not a backstop case to nudge past — a
    // not-actionable finding is a legitimate, common investigation outcome
    // (see isResolveEligible's own docstring: "a report investigated and
    // found not-actionable still resolves once its session ends"). Routing
    // it through the no-decision nudge/second-occurrence dance below would
    // make its terminalization depend on in-memory nudge state that a
    // backend restart wipes — so it goes straight to markTerminal on the
    // very first park, the same as a session that did stage a decision.
    const investigateSession = isInvestigateSession(
      getSession(sessionId)?.task_id,
    );

    if (hasStagedDecision(all) || investigateSession) {
      const incompleteJournalState =
        this.incompleteOpsJournalStateFor(sessionId);
      if (incompleteJournalState) {
        if (!this.noDecisionNudgeSent.has(sessionId)) {
          this.noDecisionNudgeSent.add(sessionId);
          this.stagedCountAtResume.set(sessionId, countable.length);
          this.sessionManager
            .enqueueFeedback(
              sessionId,
              'planning-terminal-ops-journal-incomplete-nudge',
              opsJournalNotTerminalNudgeMessage(incompleteJournalState),
            )
            .catch((err) => {
              logger.error(
                `[PlanningOrchestrator] resume failed for session ${sessionId.slice(0, 8)} after ops-journal-incomplete nudge: ${err}`,
              );
            });
          return false;
        }

        const row = getSession(sessionId);
        if (row?.task_id) {
          setTaskPauseReason(
            row.task_id,
            'ops_journal_terminal_incomplete',
            `Ops session ${sessionId} reached terminal with its ops_journal ` +
              `entry still at "${incompleteJournalState}" — twice, after one ` +
              'self-correct nudge.',
          );
        }
      }
      this.markTerminal(sessionId, 'planning_no_pending_dispositions');
      return true;
    }

    // Terminal with nothing that counts as a staged decision — the backstop
    // this class exists to close. First occurrence: one bounded self-correct
    // re-turn nudge, no pause, session stays parked (not terminal). Second
    // occurrence (the nudge's own re-turn also reached terminal empty):
    // surface a needs-attention pause reason and let the session go terminal
    // rather than nudging forever.
    if (!this.noDecisionNudgeSent.has(sessionId)) {
      this.noDecisionNudgeSent.add(sessionId);
      this.stagedCountAtResume.set(sessionId, countable.length);
      this.sessionManager
        .enqueueFeedback(
          sessionId,
          'planning-terminal-no-decision-nudge',
          NO_DECISION_NUDGE_MESSAGE,
        )
        .catch((err) => {
          logger.error(
            `[PlanningOrchestrator] resume failed for session ${sessionId.slice(0, 8)} after terminal-no-decision nudge: ${err}`,
          );
        });
      return false;
    }

    const row = getSession(sessionId);
    if (row?.task_id) {
      setTaskPauseReason(
        row.task_id,
        'planning_terminal_no_decision',
        'Planning session reached terminal with no staged decision, ops journal transition, or explicit no-op — twice, after one self-correct nudge.',
      );
    }
    this.markTerminal(sessionId, 'planning_no_pending_dispositions');
    return true;
  }

  private markTerminal(
    sessionId: string,
    reason: string,
    opts?: { skipInFlightGuard?: boolean },
  ): void {
    const row = getSession(sessionId);
    if (!row) return;

    // needs_revision/pending_verification are transient states meant to be
    // resolved by this same session — a group's own group-commit guard now
    // refuses to drop a blocked member, but that only helps while the
    // session is still alive to supersede it. Once the session goes
    // terminal with blocked members still outstanding, they become
    // unreachable (excluded from both the operator-facing decision surface
    // and any live session), so raise a needs-attention pause reason
    // against the target task rather than leaving them silently stranded.
    this.surfaceBlockedMembersPauseReason(sessionId, row, reason);

    // An ops-terminal closing group that never carried its journal.setState
    // -> "resolved" transition leaves an Investigation's journal stuck at a
    // non-terminal state forever — completeOpsTask's synchronous check will
    // not close the task, and no one will ever stage the transition once the
    // session is done. group-commit's own precheck
    // (checkOpsTerminalGroupCompleteness) refuses this when both are staged
    // together in one apply, but a session can still commit a partial group
    // across turns and go terminal before ever staging the rest — surface it
    // rather than let the session complete (or fail to complete) silently.
    if (
      row.task_id &&
      row.session_type === 'ops' &&
      !isGateVerifySession(row.task_id)
    ) {
      const incompleteGroups =
        findIncompleteOpsTerminalGroupsForSession(sessionId);
      if (incompleteGroups.length > 0) {
        setTaskPauseReason(
          row.task_id,
          'ops_terminal_group_incomplete',
          `Ops session ${sessionId} reached terminal (${reason}) with an ops-terminal closing ` +
            'group missing its journal.setState -> "resolved" transition: ' +
            `${incompleteGroups.join(', ')}.`,
        );
      }
    }

    if (row.status === 'done') {
      // Status was already written by another terminal-status writer (e.g.
      // the gate-item verifier), which may not have reaped the subprocess.
      // End it unconditionally rather than leaving it to leak a
      // planning-concurrency slot forever — endSession on an already-exited
      // session is already a no-op.
      this.sessionManager.endSession(sessionId);
      return;
    }
    if (opts) {
      markSessionDone(sessionId, Date.now(), null, reason, opts);
    } else {
      markSessionDone(sessionId, Date.now(), null, reason);
    }
    // Durable, queryable record of *why* this session went terminal — not
    // just for design/docs/ops sessions below, since a future terminal
    // reason may need this without gaining task-closing authority. See
    // closeDeferredOpsTask, which reads this back well after the session
    // has ended to drive the ops-journal route's deferred close.
    setSessionTerminalCompletionReason(sessionId, reason);
    // Dual-write bridge (see session/completingSignalRegistry.ts and
    // sessionStatusDeriver.ts): mirror this session's terminal reason into
    // completing_signal_ledger as a 'staged_intent' signal, ahead of any
    // read-side cutover for this session_type. Purely additive — never
    // gates, alters, or is awaited by the legacy writes above, so it cannot
    // change their observable behavior.
    insertCompletingSignal({
      session_id: sessionId,
      task_id: row.task_id ?? null,
      session_type: row.session_type,
      signal_class: 'staged_intent',
      signal_value: reason,
      recorded_at: Date.now(),
    });
    this.stagedCountAtResume.delete(sessionId);
    this.noDecisionNudgeSent.delete(sessionId);
    this.blockedMembersNudgeSentFor.delete(sessionId);
    // The normal run().then() cleanup that frees a session's in-memory
    // planning-concurrency slot only fires when its subprocess exits — a
    // session marked terminal here (from the apply path, which can fire
    // mid-turn, or from a park whose turn staged nothing new) may still be
    // live, so end it via the same mechanism PRMergeWatcher uses: closing
    // stdin drives the CLI to a clean exit, which resolves run() and lets
    // cleanupWorktree delete the map entry and free the slot. markSessionDone
    // above has already landed, so the clean-exit chain's markSessionIdle
    // call (AgentSession.handleCleanExit) hits the terminal guard in
    // markSessionIdle and is a no-op rather than clobbering done back to idle.
    //
    // setSessionTerminalCompletionReason above must land before this call:
    // AgentSession.endSession reads it synchronously to tell a forced kill
    // that follows a sanctioned conclusion apart from an unexpected one, so
    // the escalation (if the CLI doesn't honor stdin close within the grace
    // period) is classified as a clean conclusion rather than
    // runner_killed_unexpected/session_errored.
    this.sessionManager.endSession(sessionId);
    this.sessionManager.emit('message', {
      type: 'session_status',
      sessionId,
      status: 'done',
    } satisfies ServerMessage);
    logger.info(
      `[PlanningOrchestrator] ${sessionId.slice(0, 8)} -> terminal (${reason})`,
    );

    // A design session's natural (not operator-killed) terminal is the
    // orchestrator's own signal to close its target task — a design session
    // never stages its own Done (that is not a session's to propose); this
    // is the one place that promotes it, on the same deterministic-signal
    // model as a merged PR closing a Code task.
    if (
      row.session_type === 'design' &&
      DESIGN_COMPLETING_REASONS.has(reason)
    ) {
      this.completeDesignTask(sessionId, row);
    }

    // A docs session's natural terminal closes its target task only when the
    // session never opened a PR (a Notion-page-edit-only outcome) — once a
    // docs session opens a PR, opensPr('docs') routes the target task's
    // closure through the existing merge-driven path instead, same as a
    // standard code session.
    if (row.session_type === 'docs' && DESIGN_COMPLETING_REASONS.has(reason)) {
      this.completeDocsTask(sessionId, row);
    }

    // An ops session's natural terminal closes its target task the same
    // way — except a gate-verify session (task_id `gate-item:<id>`) has no
    // Notion task to close, so it is excluded rather than mistakenly
    // written to as one.
    if (
      row.session_type === 'ops' &&
      DESIGN_COMPLETING_REASONS.has(reason) &&
      !isGateVerifySession(row.task_id)
    ) {
      this.completeOpsTask(sessionId, row);
    }
  }

  /**
   * Close a design session's target task once its closing set of staged
   * intents has actually been applied. A declined or pushed-back intent
   * transitions to 'rejected' regardless of whether the session later reaches
   * terminal with nothing left pending — so an abandoned proposal in the
   * session's history blocks the close rather than being silently treated as
   * a completed design.
   */
  private completeDesignTask(sessionId: string, row: Session): void {
    const taskId = row.task_id;
    const projectId = row.project_id;
    if (!taskId || !projectId) return;

    const intents = listStagedIntentsBySession(sessionId);
    if (intents.some((i) => i.state === 'rejected')) return;

    getTaskBackend(projectId)
      .updateStatus(taskId, DESIGN_DONE_STATUS, {
        source: 'orchestrator',
        sessionId,
      })
      .then(() => {
        this.sessionManager.emit('message', {
          type: 'task_status_changed',
          notionTaskId: taskId,
          newStatus: DESIGN_DONE_STATUS,
        } satisfies ServerMessage);
        emitTaskUpdated(taskId);
      })
      .catch((err) => {
        logger.error(
          `[PlanningOrchestrator] failed to close design task ${taskId} for session ${sessionId.slice(0, 8)}: ${err}`,
        );
      });
  }

  /**
   * Close a docs session's target task when it reached terminal having never
   * opened a PR — the Notion-page-edit-only outcome. If a PR was opened, its
   * closure runs through the existing merge-driven path instead (see
   * opensPr('docs')), so this mirrors completeDesignTask but is additionally
   * gated on the absence of a PR row for this session.
   */
  private completeDocsTask(sessionId: string, row: Session): void {
    const taskId = row.task_id;
    const projectId = row.project_id;
    if (!taskId || !projectId) return;
    if (getPRBySessionId(sessionId)) return;

    const intents = listStagedIntentsBySession(sessionId);
    if (intents.some((i) => i.state === 'rejected')) return;

    getTaskBackend(projectId)
      .updateStatus(taskId, DESIGN_DONE_STATUS, {
        source: 'orchestrator',
        sessionId,
      })
      .then(() => {
        this.sessionManager.emit('message', {
          type: 'task_status_changed',
          notionTaskId: taskId,
          newStatus: DESIGN_DONE_STATUS,
        } satisfies ServerMessage);
        emitTaskUpdated(taskId);
      })
      .catch((err) => {
        logger.error(
          `[PlanningOrchestrator] failed to close docs task ${taskId} for session ${sessionId.slice(0, 8)}: ${err}`,
        );
      });
  }

  /**
   * Close an ops session's target task once its closing set of staged
   * intents has actually been applied — mirrors completeDesignTask, plus one
   * additional precondition unique to ops: reaching terminal is not itself
   * completion, since ops work is tracked by its own state machine
   * (ops_journal: pending → candidate → staged-proposal →
   * applied-pending-confirm → resolved, see ops/opsJournal.ts). Only a
   * journal already at 'resolved' at this synchronous instant means the
   * investigation actually concluded — every other state (including a
   * missing entry) leaves the task in progress. This only ever fires for the
   * no-change Investigation path, where the whole hop sequence to resolved
   * (e.g. journal.setState -> candidate alongside journal.setState ->
   * resolved) is staged in the same closing group and applied in order by
   * commitGroupIntents — each hop validated against the effective state the
   * prior staged hop in the chain would produce (stagedIntents.ts's
   * effectiveOpsStateForStaging), not just the applied row — and is
   * therefore already committed by the time markTerminal runs; the
   * operator-confirmed applied-pending-confirm -> resolved path is out of
   * scope (see routes/opsJournal.ts) and typically settles well after the
   * session has gone terminal. Callers must exclude gate-verify sessions
   * (task_id `gate-item:<id>`) first, since those have no Notion task to
   * close and also have no ops_journal entry.
   *
   * Also gated on the absence of a PR row for this session, mirroring
   * completeDocsTask: an ops session can now earn the PR-open tool grant
   * (see opensPr('ops')) and open a PR against its target task, whose
   * closure must run through the existing merge-driven path instead of
   * this ops_journal-driven one — closing the task here while that PR is
   * still open would pull the task out from under an in-flight review.
   */
  private completeOpsTask(sessionId: string, row: Session): void {
    const taskId = row.task_id;
    const projectId = row.project_id;
    if (!taskId || !projectId) return;
    if (getPRBySessionId(sessionId)) return;

    const journalEntry = getEntry(taskId);
    if (!journalEntry || journalEntry.state !== 'resolved') return;

    if (opsSessionHasBlockedClosingGroupMember(sessionId)) return;

    getTaskBackend(projectId)
      .updateStatus(taskId, DESIGN_DONE_STATUS, {
        source: 'orchestrator',
        sessionId,
      })
      .then(() => {
        this.sessionManager.emit('message', {
          type: 'task_status_changed',
          notionTaskId: taskId,
          newStatus: DESIGN_DONE_STATUS,
        } satisfies ServerMessage);
        emitTaskUpdated(taskId);
      })
      .catch((err) => {
        logger.error(
          `[PlanningOrchestrator] failed to close ops task ${taskId} for session ${sessionId.slice(0, 8)}: ${err}`,
        );
      });
  }

  /** Operator explicitly ends a planning session — an early terminal, regardless of un-dispositioned intents. */
  endSession(sessionId: string): void {
    this.markTerminal(sessionId, 'planning_operator_end');
  }

  /**
   * Route an operator disposition on a staged intent back to its
   * originating planning session. pushback/decline/answer resume the session
   * by id via SessionManager.enqueueFeedback (the existing CLI --resume
   * path), delivering the outcome as the next turn's input — those are
   * decisions the session's next turn is waiting on. enqueueFeedback itself
   * handles a session that has already reached a terminal state (done/error/
   * killed) — it attempts a resume and, failing that, surfaces a
   * needs-attention signal rather than silently dropping the pushback (see
   * SessionManager.deliverUndeliveredInboxItems).
   *
   * approve is different (grooming decision 2026-07-26): an approval is
   * acknowledgment, not a decision the session needs to act on, so it never
   * resumes per intent — see handleApproveDisposition.
   *
   * No-ops (recorded-only) only for intents with no originating session at
   * all, or whose session isn't a planning session — there is no session to
   * route feedback to in either case.
   */
  async handleDisposition(payload: PlanningDispositionPayload): Promise<void> {
    const { intent, disposition, reason, answer } = payload;
    const provenance = payload.provenance ?? 'operator';
    const sessionId = intent.session_id;
    if (!sessionId) {
      logger.warn(
        `[PlanningOrchestrator] ${disposition} on intent ${intent.id} has no originating session — recorded only`,
      );
      return;
    }

    const row = getSession(sessionId);
    if (!row || !isPlanningSession(row.session_type ?? '')) {
      logger.warn(
        `[PlanningOrchestrator] ${disposition} on intent ${intent.id}: session ${sessionId.slice(0, 8)} is not a planning session — recorded only`,
      );
      return;
    }

    if (disposition === 'approve') {
      await this.handleApproveDisposition(sessionId, intent);
      return;
    }

    // A terminal session (done/error/killed) will not be resumed by the
    // enqueueFeedback call below (attemptTerminalResume: false), so the
    // count snapshot below — which exists to let the next park's terminal
    // check detect a resumed turn staging something new — would never be
    // consulted. Skip it rather than leaving a misleading write.
    const isTerminal = TERMINAL_SESSION_STATUSES.has(row.status);
    if (!isTerminal) {
      // Snapshot the current intent count so the next park's terminal check
      // can tell whether the turn this disposition triggers stages anything new.
      this.stagedCountAtResume.set(
        sessionId,
        listStagedIntentsBySession(sessionId).length,
      );
    }

    const message = formatDispositionMessage(
      intent,
      disposition,
      reason,
      answer,
      provenance,
    );
    try {
      await this.sessionManager.enqueueFeedback(
        sessionId,
        provenance === 'auto' ? 'validation-error' : 'operator-disposition',
        message,
        { attemptTerminalResume: false },
      );
    } catch (err) {
      logger.error(
        `[PlanningOrchestrator] resume failed for session ${sessionId.slice(0, 8)} after ${disposition}: ${err}`,
      );
    }
  }

  /**
   * An approval carries no information the session can act on by default —
   * its mandate ordinarily ends at staging, so approval is the operator
   * consuming the deliverable, not a message back to the producer. Once its
   * group has settled and no other staged intents remain for the session,
   * the session is a terminal candidate. This deliberately does not consult
   * checkTerminal — that heuristic exists to detect a turn that staged
   * nothing new, which is a different question from "does this approval
   * itself warrant a resume".
   *
   * But "terminal candidate" is not the same as "terminate unconditionally"
   * — some session types have work that only becomes stageable *after* an
   * approval lands, so termination here must be conditional on the session
   * genuinely having no mandate left, checked against the per-type terminal
   * predicates that already exist rather than by adding a bespoke carve-out
   * per session type as each one turns up:
   *  - design sessions: sessionOwesGatedDesignArtifacts — an approved
   *    completeness.disposition unblocks the gated architecture-unit /
   *    closing-synthesis write (see assertCompletenessApproval in
   *    routes/stagedIntents.ts).
   *  - ops sessions: incompleteOpsJournalStateFor — an approved
   *    journal.setState transition to a non-terminal waypoint (e.g.
   *    candidate) is the operator's go-ahead to continue the investigation
   *    or operational run to its task Type's own terminal target(s), not a
   *    close-out.
   * Either case resumes the session (exactly like a pushback/decline/answer
   * disposition) instead of marking it terminal, since going terminal here
   * would foreclose the very turn that was waiting on this approval. A
   * session type with no remaining mandate after any approval (groom,
   * gate-verify) is unaffected by either predicate and proceeds straight to
   * terminal below.
   *
   * A concurrent path (e.g. a capability-grant resume) can have the
   * session's turn genuinely in flight (AgentSession.hasActiveTurn()) by the
   * time this settles — the mandate having completed does not mean the
   * session is between turns. Marking terminal underneath a live turn would
   * stop it out from under itself while it keeps emitting events, so the
   * transition is deferred to the turn's next boundary instead of applied
   * immediately. Note this is deliberately NOT session.status === 'running'
   * — that is the normal resting state for a dispatched planning session
   * parked alive between turns, not a turn-in-flight signal, so it would
   * defer almost every approval rather than only the rare mid-turn one.
   * (The resume paths above need no equivalent defer: they go through
   * enqueueFeedback, which already queues behind an in-flight turn and
   * delivers at the next boundary — see SessionManager.enqueueFeedback.)
   */
  private async handleApproveDisposition(
    sessionId: string,
    intent: StagedIntentRow,
  ): Promise<void> {
    if (!isGroupFullyDisposed(intent)) return;

    const stillPending = listStagedIntentsBySession(sessionId).some(
      (i) => i.state === 'staged',
    );
    if (stillPending) return;

    if (sessionOwesGatedDesignArtifacts(sessionId)) {
      this.stagedCountAtResume.set(
        sessionId,
        listStagedIntentsBySession(sessionId).length,
      );
      try {
        await this.sessionManager.enqueueFeedback(
          sessionId,
          'operator-disposition',
          formatGatedArtifactsUnblockedMessage(intent),
        );
      } catch (err) {
        logger.error(
          `[PlanningOrchestrator] resume failed for session ${sessionId.slice(0, 8)} after gating approval: ${err}`,
        );
      }
      return;
    }

    const incompleteOpsState = this.incompleteOpsJournalStateFor(sessionId);
    if (incompleteOpsState) {
      this.stagedCountAtResume.set(
        sessionId,
        listStagedIntentsBySession(sessionId).length,
      );
      try {
        await this.sessionManager.enqueueFeedback(
          sessionId,
          'operator-disposition',
          formatOpsJournalApprovedIncompleteMessage(
            sessionId,
            intent,
            incompleteOpsState,
          ),
        );
      } catch (err) {
        logger.error(
          `[PlanningOrchestrator] resume failed for session ${sessionId.slice(0, 8)} after ops-journal approval: ${err}`,
        );
      }
      return;
    }

    const liveSession = this.sessionManager.getLiveSession(sessionId);
    if (liveSession?.hasActiveTurn()) {
      this.pendingApproveTerminal.add(sessionId);
      setPendingApproveTerminal(sessionId, Date.now());
      logger.info(
        `[PlanningOrchestrator] ${sessionId.slice(0, 8)} approval complete but turn is in flight — deferring terminal transition`,
      );
      return;
    }

    // hasActiveTurn() has already confirmed no turn is in flight, so it's
    // safe to skip markSessionDone's own in-flight guard even though the
    // session's DB status may still read 'running'.
    this.markTerminal(sessionId, 'planning_approved', {
      skipInFlightGuard: true,
    });
  }

  /**
   * Group-level twin of `handleDisposition` — routes an operator pushback
   * or decline on a whole staged-intent group as a single feedback message,
   * instead of one per intent. Intents are grouped by originating session
   * (ordinarily all one session, since a group is one structural-change
   * unit from one planning session) so each session still resumes exactly
   * once for the group, with the reason and full set of rejected intents.
   */
  async handleGroupDisposition(payload: {
    intents: StagedIntentRow[];
    disposition: Exclude<PlanningDisposition, 'approve'>;
    reason?: string | null;
    groupId: string;
  }): Promise<void> {
    const { intents, disposition, reason, groupId } = payload;

    // The type excludes 'approve', but this is reachable from a caller that
    // narrows less strictly than the compiler enforces — an approve must
    // never be coalesced into a group resume, so fall through to the same
    // no-resume approve path used for a single intent rather than trusting
    // the type alone.
    if ((disposition as PlanningDisposition) === 'approve') {
      for (const intent of intents) {
        if (!intent.session_id) continue;
        await this.handleApproveDisposition(intent.session_id, intent);
      }
      return;
    }

    const bySession = new Map<string, StagedIntentRow[]>();
    const terminalBySession = new Map<string, boolean>();
    for (const intent of intents) {
      const sessionId = intent.session_id;
      if (!sessionId) continue;
      const row = getSession(sessionId);
      if (!row || !isPlanningSession(row.session_type ?? '')) continue;
      const list = bySession.get(sessionId) ?? [];
      list.push(intent);
      bySession.set(sessionId, list);
      terminalBySession.set(
        sessionId,
        TERMINAL_SESSION_STATUSES.has(row.status),
      );
    }

    for (const [sessionId, sessionIntents] of bySession) {
      // See handleDisposition's matching comment: a terminal session will
      // not be resumed below (attemptTerminalResume: false), so skip the
      // count snapshot rather than leaving a misleading write.
      if (!terminalBySession.get(sessionId)) {
        this.stagedCountAtResume.set(
          sessionId,
          listStagedIntentsBySession(sessionId).length,
        );
      }

      const message = formatGroupDispositionMessage(
        groupId,
        sessionIntents,
        disposition,
        reason,
      );
      try {
        await this.sessionManager.enqueueFeedback(
          sessionId,
          'operator-disposition',
          message,
          { attemptTerminalResume: false },
        );
      } catch (err) {
        logger.error(
          `[PlanningOrchestrator] resume failed for session ${sessionId.slice(0, 8)} after group ${disposition}: ${err}`,
        );
      }
    }
  }

  /**
   * Sets the 'planning_terminal_blocked_members' pause reason when the
   * session holds staged intents stuck at needs_revision/pending_verification
   * — shared by markTerminal (which surfaces this alongside terminalizing)
   * and the idle-sweep's blocked branch (which surfaces this INSTEAD of
   * terminalizing, since those intents can never be resolved once the
   * subprocess is gone). Returns true if a pause reason was set.
   */
  private surfaceBlockedMembersPauseReason(
    sessionId: string,
    row: Session,
    reason: string,
  ): boolean {
    if (!row.task_id) return false;
    const blockedMembers = listStagedIntentsBySession(sessionId).filter(
      (i) => i.state === 'needs_revision' || i.state === 'pending_verification',
    );
    if (blockedMembers.length === 0) return false;
    setTaskPauseReason(
      row.task_id,
      'planning_terminal_blocked_members',
      `Planning session ${sessionId} reached terminal (${reason}) with ` +
        `${blockedMembers.length} blocked staged intent(s) still outstanding: ` +
        `${blockedMembers.map((i) => i.id).join(', ')}.`,
    );
    return true;
  }

  /**
   * Cold-path completeness check for a session with no live in-memory
   * process — reuses computeStagedIntentState, the same core predicate
   * checkTerminal applies on the live event-driven path, with
   * stagedNothingNew treated as unconditionally true: nothing can ever be
   * staged again for a session whose subprocess has already exited, so the
   * turn-boundary comparison checkTerminal needs is moot here. Adds two
   * gates that only matter once resumption is impossible:
   *  - 'blocked': a needs_revision/pending_verification intent can never be
   *    resolved by this session again — surface it for operator attention
   *    rather than silently terminalizing over it.
   *  - an outstanding session.requestCapability intent — the session is
   *    still (structurally, if not literally) awaiting an answer.
   */
  private isSessionCompleteForIdleSweep(
    sessionId: string,
  ): 'terminal' | 'blocked' | 'not_ready' {
    const { all, stillPending, owesGatedArtifacts } =
      this.computeStagedIntentState(sessionId);
    if (stillPending || owesGatedArtifacts) return 'not_ready';
    if (hasActiveCapabilityRequestForSession(sessionId)) return 'not_ready';
    const blocked = all.some(
      (i) => i.state === 'needs_revision' || i.state === 'pending_verification',
    );
    return blocked ? 'blocked' : 'terminal';
  }

  /**
   * Cold-path terminal attempt for a single session, keyed off
   * isSessionCompleteForIdleSweep's same DB-only completeness predicate —
   * usable from a caller that has no live turn/park event to drive
   * checkTerminal (e.g. a liveness-reconciler sweep about to write a bare
   * 'killed' status over a session whose OS process is gone but whose work
   * actually settled before it died). Returns true iff the session was
   * driven to terminal via markTerminal with the same
   * 'planning_no_pending_dispositions' reason the live checkTerminal path
   * uses — so a report's isResolveEligible / a task's design-completion
   * wiring sees the identical, already-audited signal regardless of which
   * path reached it. A 'blocked' verdict surfaces the pause reason (the
   * session can never resolve those members itself once its process is
   * gone) and returns false, same as the idle sweep; 'not_ready' also
   * returns false, leaving the caller's own fallback (e.g. writing
   * 'killed') untouched.
   */
  tryTerminalizeIfComplete(sessionId: string): boolean {
    const row = getSession(sessionId);
    if (!row || !isPlanningSession(row.session_type ?? '')) return false;
    const outcome = this.isSessionCompleteForIdleSweep(sessionId);
    if (outcome === 'not_ready') return false;
    if (outcome === 'blocked') {
      this.surfaceBlockedMembersPauseReason(
        sessionId,
        row,
        'planning_liveness_reconciler_blocked',
      );
      return false;
    }
    this.markTerminal(sessionId, 'planning_no_pending_dispositions', {
      skipInFlightGuard: true,
    });
    return true;
  }

  /**
   * Periodic backstop for the gap checkTerminal structurally cannot close:
   * a planning session whose subprocess has already exited (status='idle',
   * ended_at set) can never again emit the session_ended/result message
   * onSessionParked listens for, so checkTerminal is never re-triggered for
   * it — it sits holding a countLivePlanningSessions() slot forever. This
   * sweeps that population, applying isSessionCompleteForIdleSweep (positive
   * evidence of completion, not an inference from elapsed time) gated by a
   * generous age floor as defense-in-depth, and reuses markTerminal / the
   * blocked-member pause-reason path rather than writing session status
   * directly. archiveConcludedSessionsOlderThan's separate idle-exclusion
   * guard is untouched — a session this sweep terminalizes is reclaimed by
   * that archiver unchanged, on its own normal cadence.
   */
  sweepIdleTerminalSessions(nowFn: () => number = () => Date.now()): number {
    const cutoffMs =
      nowFn() -
      runtimeSettings.idle_planning_terminal_sweep_age_floor_minutes * 60_000;
    const candidates =
      listIdlePlanningSessionsEligibleForTerminalSweep(cutoffMs);

    const terminalizedIds: string[] = [];
    for (const row of candidates) {
      // Defensive regression guard: status='idle' should already imply no
      // live process, but never destroy live work on that assumption
      // alone. Checked against the real OS process (isProcessAlive), not
      // the in-memory session map (isAlive) — a stale map entry must never
      // block this sweep from reconciling a session whose process is
      // actually gone.
      if (this.sessionManager.isProcessAlive(row.session_id)) continue;

      const outcome = this.isSessionCompleteForIdleSweep(row.session_id);
      if (outcome === 'not_ready') continue;
      if (outcome === 'blocked') {
        this.surfaceBlockedMembersPauseReason(
          row.session_id,
          row,
          'planning_idle_sweep_blocked',
        );
        continue;
      }
      this.markTerminal(row.session_id, 'planning_idle_sweep_terminal', {
        skipInFlightGuard: true,
      });
      terminalizedIds.push(row.session_id);
    }

    if (terminalizedIds.length > 0) {
      recordEvent({
        event_type: 'planning_sessions_idle_swept_terminal',
        actor_type: 'system',
        payload: {
          terminalized_count: terminalizedIds.length,
          session_ids: terminalizedIds,
        },
      });
      logger.info(
        `[PlanningOrchestrator] idle-sweep terminalized ${terminalizedIds.length} finished idle planning session(s)`,
      );
    }

    return terminalizedIds.length;
  }

  /** Registers the idle-terminal sweep with the Scheduler — cadence/reentrancy managed by Scheduler, this class owns sweep logic only. */
  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'idle_planning_session_terminal_sweep',
      intervalMs: () =>
        runtimeSettings.idle_planning_terminal_sweep_interval_minutes * 60_000,
      enabled: () => runtimeSettings.idle_planning_terminal_sweep_enabled,
      concurrency: 'skip-if-running',
      run: async () => {
        const items_processed = this.sweepIdleTerminalSessions();
        return { items_processed };
      },
    });
  }
}

/** True once every live intent in the group has settled (committed/rejected/superseded) — trivially true for an ungrouped intent. */
function isGroupFullyDisposed(intent: StagedIntentRow): boolean {
  if (!intent.group_id) return true;
  const PENDING: StagedIntentState[] = ['staged', 'approved'];
  return !listStagedIntentsByGroup(intent.group_id).some((row) =>
    PENDING.includes(row.state),
  );
}

function formatVerificationFeedback(groupId: string, errors: string[]): string {
  return (
    `Proposal group ${groupId} failed verification and was sent back for revision:\n` +
    errors.map((e) => `- ${e}`).join('\n')
  );
}

function formatGroupDispositionMessage(
  groupId: string,
  intents: StagedIntentRow[],
  disposition: PlanningDisposition,
  reason?: string | null,
): string {
  const list = intents.map((i) => `${i.id} (${i.kind})`).join(', ');
  const verb =
    disposition === 'decline' ? 'declined' : 'sent back for revision';
  const label = disposition === 'decline' ? 'Reason' : 'Feedback';
  return (
    `Staged intent group ${groupId} (${intents.length} intent${intents.length === 1 ? '' : 's'}: ${list}) ` +
    `was ${verb}. ${label}: ${reason ?? ''}`
  );
}

function formatGatedArtifactsUnblockedMessage(intent: StagedIntentRow): string {
  return (
    `Staged intent ${intent.id} (${intent.kind}) was approved. This unblocks ` +
    "this task's gated architecture-unit write (arch.createUnit / " +
    'arch.updateUnit / arch.supersedeUnit) and the closing-synthesis ' +
    'task.updateBody — stage them now.'
  );
}

/**
 * Resume message for an approved journal.setState whose ops journal is still
 * below its task Type's session-reachable terminal set — see
 * incompleteOpsJournalStateFor / isSessionTerminalOpsState. Names the
 * task Type's own remaining terminal target(s) via sessionTerminalOpsStates
 * rather than a fixed string, since the set differs by Type (an Investigation
 * may not stop at applied-pending-confirm; an Operational run may).
 */
function formatOpsJournalApprovedIncompleteMessage(
  sessionId: string,
  intent: StagedIntentRow,
  state: OpsState,
): string {
  const row = getSession(sessionId);
  const taskType = row?.task_id ? getCachedType(row.task_id) : undefined;
  const remaining = Array.from(sessionTerminalOpsStates(taskType)).join(' or ');
  return (
    `Staged intent ${intent.id} (${intent.kind}) was approved, moving the ops ` +
    `journal to "${state}" — that is the operator's go-ahead to continue, not ` +
    `a close-out. Continue this task to ${remaining}, filing any follow-on ` +
    'tasks and the closing intent as one group, before ending the turn.'
  );
}

export function formatDispositionMessage(
  intent: StagedIntentRow,
  disposition: Exclude<PlanningDisposition, 'approve'>,
  reason?: string | null,
  answer?: StagedIntentAnswer | null,
  provenance: 'auto' | 'operator' = 'operator',
): string {
  switch (disposition) {
    case 'decline':
      return `Staged intent ${intent.id} (${intent.kind}) was declined. Reason: ${reason ?? ''}`;
    case 'pushback':
      return provenance === 'auto'
        ? `Staged intent ${intent.id} (${intent.kind}) failed validation and was sent back for ` +
            `revision. Validation error: ${reason ?? ''}\n` +
            `To fix this, stage the corrected intent with supersedes set to "${intent.id}" (the id ` +
            'of this rejected intent) so it retires the rejected one instead of leaving it in place. ' +
            'Supersede ONLY this rejected intent — its unblocked group siblings (sitting cleanly at ' +
            'staged/approved) must be left in place, not retired and re-staged; a superseded member ' +
            'never blocks a group commit, so re-staging an unblocked sibling fixes nothing and only ' +
            'multiplies the cost of this correction.'
        : `Staged intent ${intent.id} (${intent.kind}) was sent back for revision. Feedback: ${reason ?? ''}`;
    case 'answer':
      if (answer?.chosenLabel) {
        return (
          `Decision ${intent.id} (${intent.kind}) was answered: "${answer.chosenLabel}".` +
          (answer.freeForm ? ` Additional context: ${answer.freeForm}` : '')
        );
      }
      return (
        `Decision ${intent.id} (${intent.kind}) was answered: no listed option was selected. ` +
        `The operator's answer: "${answer?.freeForm ?? ''}"`
      );
  }
}

/**
 * Deferred half of ops-task closure. Mirrors PlanningOrchestrator's private
 * completeOpsTask, but is driven by the ops-journal route's operator-confirmed
 * applied-pending-confirm -> resolved transition (routes/opsJournal.ts)
 * instead of completeOpsTask's synchronous journal check at markTerminal's
 * exact instant — that check always misses this path, since the journal is
 * still at applied-pending-confirm when the session goes terminal and
 * typically only reaches resolved well after (see completeOpsTask's
 * docstring). Standalone (not a class method) so the route can call it with
 * just the session row it already looked up, without needing a
 * PlanningOrchestrator/SessionManager instance.
 *
 * Guards mirror completeOpsTask's: excludes gate-verify sessions (no Notion
 * task to close), requires the session's durable terminal_completion_reason
 * to be one of DESIGN_COMPLETING_REASONS, and bails via
 * opsSessionHasBlockedClosingGroupMember if a rejected/needs_revision intent
 * sits inside one of the session's ops-terminal closing groups — an
 * unrelated decline elsewhere in the session's history does not block.
 * Additionally checks the task's current status before writing, so it no-ops
 * if completeOpsTask's synchronous path (the
 * decided-no-change Investigation, where journal.setState -> resolved
 * commits atomically alongside the session's terminal) already closed the
 * task — this route-driven path must never double-apply that close.
 */
export async function closeDeferredOpsTask(session: Session): Promise<void> {
  const taskId = session.task_id;
  const projectId = session.project_id;
  if (!taskId || !projectId) return;
  if (isGateVerifySession(taskId)) return;
  if (
    !session.terminal_completion_reason ||
    !DESIGN_COMPLETING_REASONS.has(session.terminal_completion_reason)
  ) {
    return;
  }

  if (opsSessionHasBlockedClosingGroupMember(session.session_id)) return;

  const backend = getTaskBackend(projectId);
  const summary = await backend.fetchTaskSummary(taskId);
  if (summary?.status === DESIGN_DONE_STATUS) return;

  await backend.updateStatus(taskId, DESIGN_DONE_STATUS, {
    source: 'orchestrator',
    sessionId: session.session_id,
  });
  broadcastTaskStatusChanged(taskId, DESIGN_DONE_STATUS);
  emitTaskUpdated(taskId);
}
