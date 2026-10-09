import type { DeployPlanStep, DeployRunEvent } from '../api/deploy';

export type DeployStepState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'declined';

export interface DeployStepCellState {
  id: string;
  description: string | null;
  state: DeployStepState;
  /** The step_failed event's detail, if this step's state is 'failed'. */
  failureDetail: string | null;
  /** Honest disposition note: an auto-approved gate or a declined rollback, never presented as an operator decision. */
  note: string | null;
}

/**
 * Derives each plan step's display state from its run's raw event log —
 * a pure function of (plan, events) so it's unit-testable without a DOM.
 * Scans a step's events in order, letting a terminal event (succeeded/
 * failed/declined) win outright. A recorded confirm_gate event is written
 * after its disposition, so it never marks a step as pending; it only adds
 * a note for a non-operator (auto-approved) disposition.
 */
export function deriveDeployStepStates(
  plan: DeployPlanStep[],
  events: DeployRunEvent[],
): DeployStepCellState[] {
  return plan.map((step) => {
    const stepEvents = events.filter((ev) => ev.step === step.id);
    let state: DeployStepState = 'pending';
    let failureDetail: string | null = null;
    let note: string | null = null;

    for (const ev of stepEvents) {
      if (ev.event_type === 'step_failed') {
        state = 'failed';
        failureDetail = ev.detail ?? null;
        break;
      }
      if (ev.event_type === 'step_succeeded') {
        state = 'succeeded';
        break;
      }
      if (ev.event_type === 'rollback_declined') {
        state = 'declined';
        note = ev.detail ?? 'rollback declined: not run in a deploy run';
        break;
      }
      if (ev.event_type === 'step_started') {
        state = 'running';
      } else if (
        ev.event_type === 'confirm_gate' &&
        ev.disposition === 'auto_approved'
      ) {
        note = 'auto-approved (no operator)';
      }
    }

    return {
      id: step.id,
      description: step.description,
      state,
      failureDetail,
      note,
    };
  });
}
