import type {
  PlanUsage,
  UsageWindow,
} from '@claude-orchestrator/backend/src/ws/types';
import styles from './PlanUsageBars.module.css';

interface Props {
  usage?: PlanUsage | null;
}

function formatResetTime(resetsAt: string): string {
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) return resetsAt;
  const time = reset.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const diffMs = reset.getTime() - Date.now();
  if (diffMs <= 0) return `${time} (resetting soon)`;
  const totalMinutes = Math.round(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const relative = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return `${time} (in ${relative})`;
}

function severityClass(severity: string): string {
  switch (severity) {
    case 'normal':
      return styles.severityNormal;
    case 'warning':
    case 'high':
      return styles.severityWarning;
    case 'critical':
    case 'exceeded':
      return styles.severityCritical;
    default:
      return styles.severityNormal;
  }
}

function Bar({ label, window }: { label: string; window: UsageWindow }) {
  const title = `${label}: ${window.percent}% · resets ${formatResetTime(window.resetsAt)}`;
  return (
    <div
      className={styles.barTrack}
      title={title}
      data-testid={`plan-usage-bar-${label.toLowerCase()}`}
    >
      <div
        className={`${styles.barFill} ${severityClass(window.severity)}`}
        style={{ width: `${Math.min(100, Math.max(0, window.percent))}%` }}
      />
    </div>
  );
}

export function PlanUsageBars({ usage }: Props) {
  if (!usage || !usage.available) return null;
  if (!usage.fiveHour && !usage.weekly) return null;

  return (
    <div
      className={`${styles.wrapper} ${usage.stale ? styles.stale : ''}`}
      data-testid="plan-usage-bars"
      title={
        usage.stale ? 'Showing last known usage (poll pending)' : undefined
      }
    >
      {usage.fiveHour && <Bar label="Hourly" window={usage.fiveHour} />}
      {usage.weekly && <Bar label="Weekly" window={usage.weekly} />}
    </div>
  );
}
