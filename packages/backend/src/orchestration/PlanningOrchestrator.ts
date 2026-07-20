import { logger } from '../logger';
import {
  getSession,
  listStagedIntentsBySession,
  markSessionDone,
} from '../db/queries';
import type { StagedIntentRow } from '../db/types';
import { isPlanningSession } from '../session/sessionPredicates';
import type { SessionManager } from '../session/SessionManager';
import type { ServerMessage } from '../ws/types';

export type PlanningDisposition = 'approve' | 'pushback' | 'reject';

export interface PlanningDispositionPayload {
  intent: StagedIntentRow;
  disposition: PlanningDisposition;
  /** Operator-supplied rationale — required for pushback, optional for reject. */
  feedback?: string | null;
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
    this.onSessionParked(msg.sessionId);
  }

  private onSessionParked(sessionId: string): void {
    const row = getSession(sessionId);
    if (!row || !isPlanningSession(row.session_type ?? '')) return;
    this.checkTerminal(sessionId);
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
    const { intent, disposition, feedback } = payload;
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

    const message = formatDispositionMessage(intent, disposition, feedback);
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
}

function formatDispositionMessage(
  intent: StagedIntentRow,
  disposition: PlanningDisposition,
  feedback?: string | null,
): string {
  switch (disposition) {
    case 'approve':
      return `Staged intent ${intent.id} (${intent.kind}) was approved and applied.`;
    case 'reject':
      return `Staged intent ${intent.id} (${intent.kind}) was rejected.${feedback ? ` Reason: ${feedback}` : ''}`;
    case 'pushback':
      return `Staged intent ${intent.id} (${intent.kind}) was sent back for revision. Feedback: ${feedback ?? ''}`;
  }
}
