import styles from './PRHistoryRow.module.css';
import type { PRWorkItem } from './WorkItemCard';

function humanizedAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 1) return 'today';
  if (diffDays === 1) return '1d ago';
  return `${diffDays}d ago`;
}

interface Props {
  pr: PRWorkItem;
  onViewSession?: (sessionId: string) => void;
}

export function PRHistoryRow({ pr, onViewSession }: Props) {
  const stateLabel = pr.state === 'merged' ? 'Merged' : 'Closed';
  const ago = humanizedAgo(pr.updatedAt);

  return (
    <div className={styles.row}>
      <a
        href={pr.prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.title}
      >
        {pr.title}
      </a>
      <div className={styles.meta}>
        {pr.notionTaskId && (
          <a
            href={`https://notion.so/${pr.notionTaskId.replace(/-/g, '')}`}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.taskLink}
          >
            Task
          </a>
        )}
        {pr.sessionId && onViewSession && (
          <button
            type="button"
            className={styles.sessionLink}
            onClick={() => onViewSession(pr.sessionId!)}
          >
            Coder
          </button>
        )}
        {pr.reviewSessionId && onViewSession && (
          <button
            type="button"
            className={styles.reviewerLink}
            onClick={() => onViewSession(pr.reviewSessionId!)}
          >
            Reviewer
          </button>
        )}
        <span className={styles.date}>
          {stateLabel} {ago}
        </span>
      </div>
    </div>
  );
}
