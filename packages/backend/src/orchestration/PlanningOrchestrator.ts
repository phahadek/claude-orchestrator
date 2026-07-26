import { logger } from '../logger';
import {
  getSession,
  listStagedIntentsBySession,
  markSessionDone,
} from '../db/queries';
import type { Session, StagedIntentRow, StagedIntentAnswer } from '../db/types';
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
 *  1. Disposition routing — an operator approve/pushback/reject on a staged
 *     intent resumes the intent's originating session with the outcome as
 *     the next turn's input.
 *  2. Terminal detection — once a planning session parks again, if no
 *     un-dispositioned (state='staged') intents remain for it and the turn
 *     that just ended staged nothing new, the session is driven to a
 *     terminal (done) state rather than left idle forever. checkTerminal is
 *     public so the apply path (stagedIntents.ts, on the applied terminal
 *     grooming disposition — group fully disposed, target task promoted)
 *     can also invoke it directly: nothing re-dispatches the session after
 *     its final disposition, so it never re-parks and onSessionParked alone
 *     would never fire for that case.
 */
export class PlanningOrchestrator {
  /** Total intent count (any state) observed for a session at its last resume — lets the next park detect whether that turn staged anything new. */
  private stagedCountAtResume = new Map<string, number>();

  constructor(private sessionManager: SessionManager) {
    sessionManager.on('message', (msg: ServerMessage) => this.onMessage(msg));
  }

  private onMessage(msg: ServerMessage): void {
    if (msg.type !== 'session_ended' || msg.status !== 'idle') return;
    void this.onSessionParked(msg.sessionId);
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

  private markTerminal(sessionId: string, reason: string): void {
    const row = getSession(sessionId);
    if (!row || row.status === 'done') return;
    markSessionDone(sessionId, Date.now(), null, reason);
    this.stagedCountAtResume.delete(sessionId);
    // The normal run().then() cleanup that frees a session's in-memory
    // planning-concurrency slot only fires when its subprocess exits on its
    // own — a session marked terminal here (from the apply path, or from a
    // park whose turn staged nothing new) may still be registered live, so
    // force the eviction rather than leaving the slot held until an
    // operator kills it by hand.
    this.sessionManager.evictSession(sessionId);
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
   * originating planning session: resumes the session by id via
   * SessionManager.enqueueFeedback (the existing CLI --resume path),
   * delivering the outcome as the next turn's input. enqueueFeedback itself
   * handles a session that has already reached a terminal state (done/error/
   * killed) — it attempts a resume and, failing that, surfaces a
   * needs-attention signal rather than silently dropping the pushback (see
   * SessionManager.deliverUndeliveredInboxItems). No-ops (recorded-only) only
   * for intents with no originating session at all, or whose session isn't a
   * planning session — there is no session to route feedback to in either case.
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
   * Group-level twin of `handleDisposition` — routes an operator pushback
   * or decline on a whole staged-intent group as a single feedback message,
   * instead of one per intent. Intents are grouped by originating session
   * (ordinarily all one session, since a group is one structural-change
   * unit from one planning session) so each session still resumes exactly
   * once for the group, with the reason and full set of rejected intents.
   */
  async handleGroupDisposition(payload: {
    intents: StagedIntentRow[];
    disposition: PlanningDisposition;
    reason?: string | null;
    groupId: string;
  }): Promise<void> {
    const { intents, disposition, reason, groupId } = payload;

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
  disposition: PlanningDisposition,
  reason?: string | null,
  answer?: StagedIntentAnswer | null,
): string {
  switch (disposition) {
    case 'approve':
      return `Staged intent ${intent.id} (${intent.kind}) was approved and applied.`;
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
