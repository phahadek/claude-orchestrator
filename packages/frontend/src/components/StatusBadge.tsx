import styles from './StatusBadge.module.css';

const BADGE_CONFIG: Record<string, { label: string; className: string }> = {
  starting:          { label: '⏳ Starting', className: styles['badge-starting'] },
  running:           { label: '🔄 Running',  className: styles['badge-running'] },
  needs_permission:  { label: '⚠️ Waiting',  className: styles['badge-waiting'] },
  done:              { label: '✅ Done',      className: styles['badge-done'] },
  error:             { label: '❌ Error',     className: styles['badge-error'] },
  killed:            { label: '🛑 Killed',   className: styles['badge-killed'] },
};

interface Props {
  status: string;
}

export function StatusBadge({ status }: Props) {
  const config = BADGE_CONFIG[status] ?? { label: status, className: styles['badge-unknown'] };
  return <span className={`${styles.badge} ${config.className}`}>{config.label}</span>;
}
