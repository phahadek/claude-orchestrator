import type { SessionState } from '../hooks/useSessionStore';
import { taskNameFromNotionUrl } from '../utils/notionUrl';
import { formatElapsed } from '../utils/sessionTimer';
import { summarizeEvent } from '../utils/eventParsing';
import { StatusBadge } from './StatusBadge';
import styles from './SessionCard.module.css';

interface Props {
  session: SessionState;
  selected: boolean;
  onClick: () => void;
  projectColor?: string;
  projectName?: string;
  onResume?: () => void;
}

export function SessionCard({ session, selected, onClick, projectColor, projectName, onResume }: Props) {
  const lastEvent = session.events.at(-1);
  const elapsed = formatElapsed(session);

  const isReview = session.sessionType === 'review';
  const borderStyle = isReview
    ? undefined
    : projectColor
    ? { borderLeft: `3px solid ${projectColor}` }
    : undefined;

  return (
    <div
      className={`${styles['session-card']} ${selected ? styles.selected : ''} ${isReview ? styles.review : ''}`}
      style={borderStyle}
      onClick={onClick}
    >
      <div className={styles['card-header']}>
        {session.taskType && (
          <span className={styles['type-icon']} title={session.taskType}>
            {taskTypeIcon(session.taskType)}
          </span>
        )}
        <span className={styles['task-name']}>{taskNameFromNotionUrl(session.taskName)}</span>
        <StatusBadge status={session.status} sessionType={session.sessionType} isRateLimited={session.isRateLimited} />
      </div>
      {projectName && (
        <div className={styles['project-tag']}>{projectName}</div>
      )}
      {session.status === 'needs_permission' && (
        <div className={styles['attention-badge']}>⚠️ Needs permission</div>
      )}
      {session.isRateLimited && (
        <div className={styles['rate-limited-row']}>
          <span className={styles['rate-limited-badge']}>⏸️ Rate limited — waiting for reset</span>
          {onResume && (
            <button
              className={styles['resume-button']}
              onClick={(e) => { e.stopPropagation(); onResume(); }}
            >
              Resume
            </button>
          )}
        </div>
      )}
      {session.tags && session.tags.length > 0 && (
        <div className={styles['tag-pills']}>
          {session.tags.map((tag) => (
            <span key={tag} className={styles['tag-pill']}>{tag}</span>
          ))}
        </div>
      )}
      {lastEvent && (
        <div className={styles['last-event']}>{summarizeEvent(lastEvent)}</div>
      )}
      <div className={styles['card-footer']}>
        <span className={styles.elapsed}>{elapsed}</span>
        <span className={styles['footer-right']}>
          {session.note && (
            <span className={styles['note-icon']} title={session.note}>📝</span>
          )}
          {session.prUrl && (
            <a href={session.prUrl} target="_blank" rel="noreferrer" className={styles['pr-link']}>
              PR ↗
            </a>
          )}
        </span>
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
