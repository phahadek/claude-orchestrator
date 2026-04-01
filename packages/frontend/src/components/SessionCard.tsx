import type { SessionState } from '../hooks/useSessionStore';
import { StatusBadge } from './StatusBadge';
import styles from './SessionCard.module.css';

interface Props {
  session: SessionState;
  selected: boolean;
  onClick: () => void;
}

export function SessionCard({ session, selected, onClick }: Props) {
  const lastEvent = session.events.at(-1);
  const elapsed = formatElapsed(session);

  return (
    <div
      className={`${styles['session-card']} ${styles[session.status] ?? ''} ${selected ? styles.selected : ''}`}
      onClick={onClick}
    >
      <div className={styles['card-header']}>
        {session.taskType && (
          <span className={styles['type-icon']} title={session.taskType}>
            {taskTypeIcon(session.taskType)}
          </span>
        )}
        <span className={styles['task-name']}>{session.taskName}</span>
        <StatusBadge status={session.status} />
      </div>
      {session.status === 'needs_permission' && (
        <div className={styles['attention-badge']}>⚠️ Needs permission</div>
      )}
      {lastEvent && (
        <div className={styles['last-event']}>{truncate(lastEvent.content, 120)}</div>
      )}
      <div className={styles['card-footer']}>
        <span className={styles.elapsed}>{elapsed}</span>
        {session.prUrl && (
          <a href={session.prUrl} target="_blank" rel="noreferrer" className={styles['pr-link']}>
            PR ↗
          </a>
        )}
      </div>
    </div>
  );
}

function taskTypeIcon(type: string): string {
  if (type.includes('💻')) return '💻';
  if (type.includes('📋')) return '📋';
  if (type.includes('🧪')) return '🧪';
  return '';
}

const TERMINAL_STATUSES = new Set(['done', 'error', 'killed']);

function formatElapsed(session: SessionState): string {
  const isTerminal = TERMINAL_STATUSES.has(session.status);
  // Prefer server-side timestamps — event timestamps are unreliable (client Date.now() on receipt)
  if (session.started_at != null) {
    const endTs = isTerminal ? (session.ended_at ?? Date.now()) : Date.now();
    return formatDuration(endTs - session.started_at);
  }
  if (session.events.length > 0) {
    const startTs = session.events[0].timestamp;
    const endTs = isTerminal ? session.events[session.events.length - 1].timestamp : Date.now();
    return formatDuration(endTs - startTs);
  }
  return '—';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '< 1s';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}
