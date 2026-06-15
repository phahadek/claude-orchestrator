import { useState } from 'react';
import type {
  BootReconciliationState,
  BootStepEntry,
} from '../../hooks/useBootReconciliation';
import styles from './ReconciliationPill.module.css';

interface Props {
  state: BootReconciliationState;
}

function stepLabel(name: string): string {
  return name.replace(/_/g, ' ');
}

function StepRow({ entry }: { entry: BootStepEntry }) {
  const icon =
    entry.status === 'completed'
      ? '✓'
      : entry.status === 'failed'
        ? '✗'
        : '…';
  return (
    <tr className={`${styles.stepRow} ${styles[`step_${entry.status}`]}`}>
      <td className={styles.stepIcon}>{icon}</td>
      <td className={styles.stepName}>{stepLabel(entry.name)}</td>
      <td className={styles.stepDuration}>
        {entry.duration_ms != null ? `${entry.duration_ms}ms` : ''}
      </td>
    </tr>
  );
}

export function ReconciliationPill({ state }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (state.phase === 'idle') return null;

  const label =
    state.phase === 'completed'
      ? 'Boot complete'
      : state.currentStep
        ? stepLabel(state.currentStep)
        : 'Starting…';

  return (
    <div className={styles.wrapper} data-testid="reconciliation-pill">
      <button
        type="button"
        className={`${styles.pill}${state.phase === 'completed' ? ` ${styles.pillDone}` : ''}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`Boot reconciliation: ${label}`}
      >
        {state.phase === 'in_progress' && (
          <span className={styles.spinner} aria-hidden="true" />
        )}
        <span className={styles.pillLabel}>
          {state.phase === 'in_progress' ? `Reconciling… ${label}` : label}
        </span>
      </button>

      {expanded && (
        <div className={styles.dropdown} data-testid="reconciliation-dropdown">
          <table className={styles.stepTable}>
            <tbody>
              {state.stepEntries.map((entry, i) => (
                <StepRow key={`${entry.name}-${i}`} entry={entry} />
              ))}
            </tbody>
          </table>
          {state.totalDurationMs != null && (
            <div className={styles.totalDuration}>
              Total: {(state.totalDurationMs / 1000).toFixed(1)}s
            </div>
          )}
        </div>
      )}
    </div>
  );
}
