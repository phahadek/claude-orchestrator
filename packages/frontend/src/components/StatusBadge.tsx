import styles from './StatusBadge.module.css';

const BADGE_CONFIG: Record<string, { label: string; className: string }> = {
  starting: { label: '⏳ Starting', className: styles['badge-starting'] },
  running: { label: '🔄 Running', className: styles['badge-running'] },
  needs_permission: { label: '⚠️ Waiting', className: styles['badge-waiting'] },
  idle: { label: '⏸️ Idle', className: styles['badge-idle'] },
  done: { label: '✅ Done', className: styles['badge-done'] },
  error: { label: '❌ Error', className: styles['badge-error'] },
  killed: { label: '🛑 Killed', className: styles['badge-killed'] },
  review: { label: '🔍 Review', className: styles['badge-review'] },
  rate_limited: {
    label: '⏸️ Rate Limited',
    className: styles['badge-rate-limited'],
  },
  retrying: { label: '🔁 Retrying', className: styles['badge-retrying'] },
};

interface Props {
  status: string;
  sessionType?: string;
  isRateLimited?: boolean;
}

export function StatusBadge({ status, sessionType, isRateLimited }: Props) {
  const key = isRateLimited
    ? 'rate_limited'
    : sessionType === 'review'
      ? 'review'
      : status;
  const config = BADGE_CONFIG[key] ?? {
    label: status,
    className: styles['badge-unknown'],
  };
  return (
    <span className={`${styles.badge} ${config.className}`}>
      {config.label}
    </span>
  );
}
