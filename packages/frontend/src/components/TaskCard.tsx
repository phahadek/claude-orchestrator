import type { TaskView, DisplayStatus } from '../types/taskView';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';
import type { ProjectConfig } from '@claude-dashboard/backend/src/config';
import { useDispatch } from '../hooks/useDispatch';
import styles from './TaskCard.module.css';

interface Props {
  task: TaskView;
  selected: boolean;
  onClick: () => void;
  send: (msg: ClientMessage) => void;
  project: ProjectConfig | null;
}

const STATUS_LABELS: Record<DisplayStatus, string> = {
  needs_attention: '⚠️ Needs Attention',
  ready_to_merge: '✅ Ready to Merge',
  in_progress: '🔄 In Progress',
  in_review: '👀 In Review',
  ready: '🗂️ Ready',
  done: '✔️ Done',
  backlog: '🗂️ Backlog',
};

function verdictLabel(verdict: string): string {
  if (verdict === 'approved') return '✅ Approved';
  if (verdict === 'needs_changes') return '🔁 Needs changes';
  if (verdict === 'incomplete') return '❌ Incomplete';
  return verdict;
}

function launchTooltip(task: TaskView): string {
  if (task.notionStatus !== '🗂️ Ready') return 'Task is not Ready';
  if (!task.taskType.includes('💻')) return 'Non-code task';
  if (task.blocked) return `Blocked by ${task.blockerNames.join(', ')}`;
  return '';
}

export function TaskCard({ task, selected, onClick, send, project }: Props) {
  const { codeSession, pr, review } = task;
  const statusKey = task.displayStatus.replace(/_/g, '-') as string;
  const dispatchTask = useDispatch(send, project);
  const isNonCode = !task.taskType.includes('💻');

  // Only Ready code tasks that aren't blocked can be launched.
  // In Progress and In Review tasks already have an active session — launching
  // another would create a duplicate.
  const isLaunchable =
    task.notionStatus === '🗂️ Ready' &&
    !isNonCode &&
    !task.blocked;

  const tooltip = isLaunchable ? '' : launchTooltip(task);

  const handleLaunch = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isLaunchable) return;
    dispatchTask([{ taskUrl: task.notionUrl, taskType: task.taskType }]);
  };

  return (
    <div
      className={`${styles.card} ${selected ? styles.selected : ''} ${isNonCode ? styles.nonCode : ''}`}
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

      {!codeSession && <span className={styles.placeholder}>—</span>}

      {pr ? (
        <div className={styles.prRow}>
          <a
            href={pr.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.prLink}
            onClick={(e) => e.stopPropagation()}
          >
            #{pr.prNumber}
          </a>
          <span className={styles.prState}>{pr.draft ? 'draft' : pr.state}</span>
          {review?.verdict && (
            <span className={`${styles.verdict} ${styles[`verdict-${review.verdict.replace(/_/g, '-')}`] ?? ''}`}>
              {verdictLabel(review.verdict)}
            </span>
          )}
        </div>
      ) : (
        <span className={styles.placeholder}>—</span>
      )}

      <div className={styles.cardFooter}>
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
        {isNonCode ? (
          <span className={styles.taskTypeLabel}>{task.taskType}</span>
        ) : (
          <button
            className={styles.launchButton}
            disabled={!isLaunchable}
            onClick={handleLaunch}
            title={tooltip || 'Launch session'}
            aria-label={isLaunchable ? `Launch session for ${task.taskName}` : tooltip}
          >
            🚀
          </button>
        )}
      </div>
    </div>
  );
}
