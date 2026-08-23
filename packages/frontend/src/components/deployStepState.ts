import type { DeployPlanStep, DeployRunEvent } from '../api/deploy';

export type DeployStepState =
  | 'pending'
  | 'running'
  | 'awaiting-confirm'
  | 'succeeded'
  | 'failed';

export interface DeployStepCellState {
  id: string;
  description: string | null;
  state: DeployStepState;
  /** The step_failed event's detail, if this step's state is 'failed'. */
  failureDetail: string | null;
}

/**
 * Derives each plan step's display state from its run's raw event log —
 * a pure function of (plan, events) so it's unit-testable without a DOM.
 * Scans a step's events in order, letting a terminal event (succeeded/
 * failed) win outright, and otherwise tracking the latest non-terminal
 * signal (started → running, confirm_gate → awaiting-confirm).
 */
export function deriveDeployStepStates(
  plan: DeployPlanStep[],
  events: DeployRunEvent[],
): DeployStepCellState[] {
  return plan.map((step) => {
    const stepEvents = events.filter((ev) => ev.step === step.id);
    let state: DeployStepState = 'pending';
    let failureDetail: string | null = null;

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
      if (ev.event_type === 'step_started') {
        state = 'running';
      } else if (ev.event_type === 'confirm_gate') {
        state = 'awaiting-confirm';
      }
    }

    return { id: step.id, description: step.description, state, failureDetail };
  });
}
