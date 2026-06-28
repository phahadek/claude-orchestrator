import type { BootReconciliationState } from '../hooks/useBootReconciliation';
import styles from './BootLoadingBanner.module.css';

function stepLabel(name: string): string {
  return name.replace(/_/g, ' ');
}

interface Props {
  state: BootReconciliationState;
}

export function BootLoadingBanner({ state }: Props) {
  if (state.phase !== 'in_progress') return null;

  const completedCount = state.stepEntries.filter(
    (e) => e.status === 'completed',
  ).length;
  const currentStepIndex =
    state.currentStep !== null
      ? state.steps.indexOf(state.currentStep) + 1
      : completedCount;
  const totalSteps = state.steps.length;

  return (
    <div className={styles.banner} data-testid="boot-loading-banner">
      <span className={styles.spinner} aria-hidden="true" />
      <div className={styles.content}>
        <div className={styles.title}>Backend booting…</div>
        {state.currentStep !== null && (
          <div className={styles.currentStep} data-testid="boot-current-step">
            {stepLabel(state.currentStep)}
          </div>
        )}
        {totalSteps > 0 && (
          <div className={styles.progress} data-testid="boot-progress">
            Step {currentStepIndex} of {totalSteps}
          </div>
        )}
      </div>
    </div>
  );
}
