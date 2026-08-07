import styles from './AdmissionStallBanner.module.css';

export type AdmissionBlockReason =
  | 'memory_admission'
  | 'usage_deferral'
  | 'usage_threshold_paused'
  | 'capacity_exhausted';

interface Props {
  reason: AdmissionBlockReason;
  eligibleCount: number;
  onDismiss: () => void;
}

const REASON_LABEL: Record<AdmissionBlockReason, string> = {
  memory_admission: 'insufficient host memory headroom',
  usage_deferral: 'plan usage exhausted',
  usage_threshold_paused: 'plan usage threshold reached (proactive pause)',
  capacity_exhausted: 'concurrency cap reached',
};

export function AdmissionStallBanner({
  reason,
  eligibleCount,
  onDismiss,
}: Props) {
  return (
    <div
      className={styles.banner}
      role="alert"
      aria-label="Dispatch admission blocked"
    >
      <span className={styles.icon}>⚠️</span>
      <span className={styles.message}>
        Dispatch is blocked —{' '}
        <span className={styles.reason}>{REASON_LABEL[reason]}</span>
        {' — '}
        {eligibleCount} eligible task{eligibleCount === 1 ? '' : 's'} waiting
      </span>
      <button className={styles.dismissBtn} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
