import type { TaskView, DisplayStatus } from '../types/taskView';
import { formatDuration } from '../utils/sessionTimer';
import styles from './TaskCard.module.css';

interface Props {
  task: TaskView;
  selected: boolean;
  onClick: () => void;
}

const STATUS_ICONS: Record<DisplayStatus, string> = {
  ready: '🗂️',
  in_progress: '🔄',
  in_review: '👁️',
  needs_attention: '⚠️',
  ready_to_merge: '🟢',
  done: '✅',
};

const VERDICT_LABELS: Record<string, string> = {
  approved: '✅ Approved',
  needs_changes: '🔁 Needs changes',
  incomplete: '⏳ Incomplete',
};

function calcElapsedLabel(startedAt: number, endedAt: number | null): string {
  const endMs = endedAt ?? Date.now();
  const ms = endMs - startedAt;
  if (ms <= 0) return '< 1s';
  return formatDuration(ms);
}

export function TaskCard({ task, selected, onClick }: Props) {
  const statusIcon = STATUS_ICONS[task.displayStatus] ?? '';

  return (
    <div
      className={`${styles['task-card']} ${styles[`status-${task.displayStatus}`]} ${selected ? styles.selected : ''}`}
      data-display-status={task.displayStatus}
      onClick={onClick}
    >
      {/* Line 1: status icon + task name + priority badge */}
      <div className={styles['card-header']}>
        <span className={styles['status-icon']}>{statusIcon}</span>
        <span className={styles['task-name']}>{task.taskName}</span>
        {task.priority && (
          <span className={styles['priority-badge']}>{task.priority}</span>
        )}
      </div>

      {/* Line 2: code session status + elapsed + last message */}
      <div className={styles['session-line']}>
        {task.codeSession ? (
          <>
            <span className={styles['session-status']}>{task.codeSession.status}</span>
            <span className={styles['session-elapsed']}>
              {calcElapsedLabel(task.codeSession.startedAt, task.codeSession.endedAt)}
            </span>
            {task.codeSession.lastMessage && (
              <span className={styles['session-message']}>{task.codeSession.lastMessage}</span>
            )}
          </>
        ) : (
          <span className={styles['placeholder']}>—</span>
        )}
      </div>

      {/* Line 3: PR info + review verdict + Notion link */}
      <div className={styles['meta-line']}>
        {task.pr ? (
          <>
            <a
              href={task.pr.prUrl}
              target="_blank"
              rel="noreferrer"
              className={styles['pr-link']}
              onClick={(e) => e.stopPropagation()}
            >
              #{task.pr.prNumber}
            </a>
            <span className={styles['pr-state']}>{task.pr.draft ? 'draft' : task.pr.state}</span>
          </>
        ) : (
          <span className={styles['placeholder']}>—</span>
        )}
        {task.review?.verdict && (
          <span className={styles['verdict-badge']}>
            {VERDICT_LABELS[task.review.verdict] ?? task.review.verdict}
          </span>
        )}
        {task.notionUrl && (
          <a
            href={task.notionUrl}
            target="_blank"
            rel="noreferrer"
            className={styles['notion-link']}
            onClick={(e) => e.stopPropagation()}
          >
            Notion ↗
          </a>
        )}
      </div>
    </div>
  );
}
