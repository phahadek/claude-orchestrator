import { logger } from '../logger';
import {
  getSession,
  listStagedIntentsByGroup,
  listStagedIntentsBySession,
  markSessionDone,
  setPendingApproveTerminal,
  clearPendingApproveTerminal,
  getSessionsWithPendingApproveTerminal,
} from '../db/queries';
import type {
  Session,
  StagedIntentRow,
  StagedIntentAnswer,
  StagedIntentState,
} from '../db/types';
import { isPlanningSession } from '../session/sessionPredicates';
import type { SessionManager } from '../session/SessionManager';
import type { ServerMessage } from '../ws/types';
import { verifyDispatchedGroupsForSession } from '../routes/stagedIntents';
import { getTaskBackend } from '../tasks/TaskBackend';
import { emitTaskUpdated } from '../routes/tasks';

const DESIGN_DONE_STATUS = '✅ Done';

type PlanningDisposition = 'approve' | 'pushback' | 'decline' | 'answer';

export interface PlanningDispositionPayload {
  intent: StagedIntentRow;
  disposition: PlanningDisposition;
  /** Operator-supplied rationale — required for pushback and decline. */
  reason?: string | null;
  /** The operator's answer to a decision.pickOne question-intent — required for the `answer` disposition. */
  answer?: StagedIntentAnswer | null;
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

  constructor(private sessionManager: SessionManager) {
    sessionManager.on('message', (msg: ServerMessage) => this.onMessage(msg));
  }

  private onMessage(msg: ServerMessage): void {
    // Turn-boundary signal: fires the instant a turn's result event is
    // processed, whether the session then parks alive (the normal resting
    // state for a dispatched planning session, status stays 'running') or
    // exits — unlike session_ended, which only fires on actual process exit.
    if (msg.type === 'session_event' && msg.eventType === 'result') {
      this.applyPendingApproveTerminal(msg.sessionId);
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
   * non-terminal call, not just from a disposition. checkTerminal already
   * runs on every park (onSessionParked fires on every session_ended/idle
   * message), so anchoring the snapshot to "count as of the last park"
   * rather than "count as of the last disposition" makes the comparison
   * self-correcting: a resume that isn't routed through handleDisposition/
   * handleGroupDisposition (e.g. a capability-grant resume) can no longer
   * leave the snapshot stale, and a park whose turn staged nothing new is
   * detected the very next time checkTerminal runs — including the park
   * that follows a session's final disposition, with no further apply
   * required.
   */
  checkTerminal(sessionId: string): boolean {
    const all = listStagedIntentsBySession(sessionId);
    const stillPending = all.some((i) => i.state === 'staged');
    const priorCount = this.stagedCountAtResume.get(sessionId) ?? 0;
    const stagedNothingNew = all.length <= priorCount;
    const terminal = !stillPending && stagedNothingNew;
    if (terminal) {
      this.markTerminal(sessionId, 'planning_no_pending_dispositions');
    } else {
      this.stagedCountAtResume.set(sessionId, all.length);
    }
    return terminal;
  }

  private markTerminal(
    sessionId: string,
    reason: string,
    opts?: { skipInFlightGuard?: boolean },
  ): void {
    const row = getSession(sessionId);
    if (!row) return;
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
    this.stagedCountAtResume.delete(sessionId);
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
      reason === 'planning_no_pending_dispositions'
    ) {
      this.completeDesignTask(sessionId, row);
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

    // Snapshot the current intent count so the next park's terminal check
    // can tell whether the turn this disposition triggers stages anything new.
    this.stagedCountAtResume.set(
      sessionId,
      listStagedIntentsBySession(sessionId).length,
    );

    const message = formatDispositionMessage(
      intent,
      disposition,
      reason,
      answer,
    );
    try {
      await this.sessionManager.enqueueFeedback(
        sessionId,
        'operator-disposition',
        message,
      );
    } catch (err) {
      logger.error(
        `[PlanningOrchestrator] resume failed for session ${sessionId.slice(0, 8)} after ${disposition}: ${err}`,
      );
    }
  }

  /**
   * An approval carries no information the session can act on — its mandate
   * ends at staging, so approval is the operator consuming the deliverable,
   * not a message back to the producer. It therefore never resumes the
   * session, unconditionally: once its group has settled and no other staged
   * intents remain for the session, the session goes straight to terminal
   * with no feedback message. This deliberately does not consult
   * checkTerminal — that heuristic exists to detect a turn that staged
   * nothing new, which is a different question from "does this approval
   * itself warrant a resume" (it never does).
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
    for (const intent of intents) {
      const sessionId = intent.session_id;
      if (!sessionId) continue;
      const row = getSession(sessionId);
      if (!row || !isPlanningSession(row.session_type ?? '')) continue;
      const list = bySession.get(sessionId) ?? [];
      list.push(intent);
      bySession.set(sessionId, list);
    }

    for (const [sessionId, sessionIntents] of bySession) {
      this.stagedCountAtResume.set(
        sessionId,
        listStagedIntentsBySession(sessionId).length,
      );

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
        );
      } catch (err) {
        logger.error(
          `[PlanningOrchestrator] resume failed for session ${sessionId.slice(0, 8)} after group ${disposition}: ${err}`,
        );
      }
    }
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

function formatDispositionMessage(
  intent: StagedIntentRow,
  disposition: Exclude<PlanningDisposition, 'approve'>,
  reason?: string | null,
  answer?: StagedIntentAnswer | null,
): string {
  switch (disposition) {
    case 'decline':
      return `Staged intent ${intent.id} (${intent.kind}) was declined. Reason: ${reason ?? ''}`;
    case 'pushback':
      return `Staged intent ${intent.id} (${intent.kind}) was sent back for revision. Feedback: ${reason ?? ''}`;
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
