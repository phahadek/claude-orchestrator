import { logger } from '../logger';
import {
  getSession,
  listStagedIntentsBySession,
  markSessionDone,
} from '../db/queries';
import type { StagedIntentRow, StagedIntentAnswer } from '../db/types';
import { isPlanningSession } from '../session/sessionPredicates';
import type { SessionManager } from '../session/SessionManager';
import type { ServerMessage } from '../ws/types';
import { verifyDispatchedGroupsForSession } from '../routes/stagedIntents';

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
 *     terminal (done) state rather than left idle forever.
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
   */
  checkTerminal(sessionId: string): boolean {
    const all = listStagedIntentsBySession(sessionId);
    const stillPending = all.some((i) => i.state === 'staged');
    const priorCount = this.stagedCountAtResume.get(sessionId) ?? 0;
    const stagedNothingNew = all.length <= priorCount;
    const terminal = !stillPending && stagedNothingNew;
    if (terminal)
      this.markTerminal(sessionId, 'planning_no_pending_dispositions');
    return terminal;
  }

  private markTerminal(sessionId: string, reason: string): void {
    const row = getSession(sessionId);
    if (!row || row.status === 'done') return;
    markSessionDone(sessionId, Date.now(), null, reason);
    this.stagedCountAtResume.delete(sessionId);
    this.sessionManager.emit('message', {
      type: 'session_status',
      sessionId,
      status: 'done',
    } satisfies ServerMessage);
    logger.info(
      `[PlanningOrchestrator] ${sessionId.slice(0, 8)} -> terminal (${reason})`,
    );
  }

  /** Operator explicitly ends a planning session — an early terminal, regardless of un-dispositioned intents. */
  endSession(sessionId: string): void {
    this.markTerminal(sessionId, 'planning_operator_end');
  }

  /**
   * Route an operator disposition on a staged intent back to its
   * originating planning session: resumes the idle session by id via
   * SessionManager.enqueueFeedback (the existing CLI --resume path),
   * delivering the outcome as the next turn's input. No-ops for intents with
   * no originating session, or whose session isn't a planning session.
   */
  async handleDisposition(payload: PlanningDispositionPayload): Promise<void> {
    const { intent, disposition, reason, answer } = payload;
    const sessionId = intent.session_id;
    if (!sessionId) return;

    const row = getSession(sessionId);
    if (!row || !isPlanningSession(row.session_type ?? '')) return;

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
  const verb = disposition === 'decline' ? 'declined' : 'sent back for revision';
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
      return (
        `Decision ${intent.id} (${intent.kind}) was answered: "${answer?.chosenLabel ?? ''}".` +
        (answer?.freeForm ? ` Additional context: ${answer.freeForm}` : '')
      );
  }
}
