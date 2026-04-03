import type { TaskView, DisplayStatus } from '../types/taskView';
import styles from './TaskCard.module.css';

interface Props {
  task: TaskView;
  selected: boolean;
  onClick: () => void;
}

const STATUS_LABELS: Record<DisplayStatus, string> = {
  needs_attention: '⚠️ Needs Attention',
  ready_to_merge: '✅ Ready to Merge',
  in_progress: '🔄 In Progress',
  in_review: '👀 In Review',
  ready: '🗂️ Ready',
  done: '✔️ Done',
};

function verdictLabel(verdict: string): string {
  if (verdict === 'approved') return '✅ Approved';
  if (verdict === 'needs_changes') return '⚠️ Needs changes';
  if (verdict === 'incomplete') return '❌ Incomplete';
  return verdict;
}

export function TaskCard({ task, selected, onClick }: Props) {
  const { codeSession, pr, review } = task;
  const statusKey = task.displayStatus.replace(/_/g, '-') as string;

  return (
    <div
      className={`${styles.card} ${selected ? styles.selected : ''}`}
      onClick={onClick}
      data-status={task.displayStatus}
    >
      <div className={styles.header}>
        <span className={styles.taskName}>{task.taskName}</span>
        <span className={`${styles.statusBadge} ${styles[`status-${statusKey}`] ?? ''}`}>
          {STATUS_LABELS[task.displayStatus]}
        </span>
      </div>

      {task.priority && (
        <div className={styles.priority}>{task.priority}</div>
      )}

      {codeSession && (
        <div className={styles.sessionRow}>
          <span className={`${styles.sessionStatus} ${styles[`session-${codeSession.status}`] ?? ''}`}>
            {codeSession.status}
          </span>
          {codeSession.lastMessage && (
            <span className={styles.lastMessage}>{codeSession.lastMessage}</span>
          )}
        </div>
      )}

      {pr && (
        <div className={styles.prRow}>
          <a
            href={pr.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.prLink}
            onClick={(e) => e.stopPropagation()}
          >
            PR #{pr.prNumber}{pr.draft ? ' (draft)' : ''}
          </a>
          {review?.verdict && (
            <span className={`${styles.verdict} ${styles[`verdict-${review.verdict.replace(/_/g, '-')}`] ?? ''}`}>
              {verdictLabel(review.verdict)}
            </span>
          )}
        </div>
      )}

      {task.notionUrl && (
        <a
          href={task.notionUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={styles.notionLink}
          onClick={(e) => e.stopPropagation()}
        >
          Notion ↗
        </a>
      )}
    </div>
  );
}
