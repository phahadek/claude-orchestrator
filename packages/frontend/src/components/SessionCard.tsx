import type { SessionState } from '../hooks/useSessionStore';
import { taskNameFromNotionUrl } from '../utils/notionUrl';
import { formatElapsed } from '../utils/sessionTimer';
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
        <span className={styles['task-name']}>{taskNameFromNotionUrl(session.taskName)}</span>
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

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}
