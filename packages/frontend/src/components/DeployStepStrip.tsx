import type { DeployPlanStep } from '../api/deploy';
import type { DeployRunEvent } from '../api/deploy';
import styles from './DeployStepStrip.module.css';

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

const STATE_GLYPH: Record<DeployStepState, string> = {
  pending: '○',
  running: '◐',
  'awaiting-confirm': '?',
  succeeded: '✓',
  failed: '✗',
};

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

interface Props {
  plan: DeployPlanStep[];
  events: DeployRunEvent[];
}

export function DeployStepStrip({ plan, events }: Props) {
  const cells = deriveDeployStepStates(plan, events);

  return (
    <ol className={styles.strip} data-testid="deploy-step-strip">
      {cells.map((cell) => {
        const label = [cell.description, cell.failureDetail]
          .filter((v): v is string => Boolean(v))
          .join(' — ');
        return (
          <li
            key={cell.id}
            className={`${styles.cell} ${styles[`state-${cell.state}`]}`}
            title={label || undefined}
            aria-label={label ? `${cell.id}: ${label}` : cell.id}
            data-testid={`deploy-step-cell-${cell.id}`}
            data-state={cell.state}
          >
            <span className={styles.glyph} aria-hidden="true">
              {STATE_GLYPH[cell.state]}
            </span>
            <span className={styles.stepId}>{cell.id}</span>
          </li>
        );
      })}
    </ol>
  );
}
