import type { DeployPlanStep } from '../api/deploy';
import type { DeployRunEvent } from '../api/deploy';
import {
  deriveDeployStepStates,
  type DeployStepState,
} from './deployStepState';
import styles from './DeployStepStrip.module.css';

const STATE_GLYPH: Record<DeployStepState, string> = {
  pending: '○',
  running: '◐',
  'awaiting-confirm': '?',
  succeeded: '✓',
  failed: '✗',
};

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
