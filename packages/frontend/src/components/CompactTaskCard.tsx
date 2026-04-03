import type { TaskView } from '../types/taskView';
import styles from './CompactTaskCard.module.css';

interface Props {
  task: TaskView;
  /** Show checkbox (Wave 1 code tasks only). */
  showCheckbox: boolean;
  checked: boolean;
  onCheckChange: (taskId: string, checked: boolean) => void;
  onClick: () => void;
}

const PRIORITY_ICONS: Record<string, string> = {
  '🔴 High': '🔴',
  '🟡 Medium': '🟡',
  '🟢 Low': '🟢',
};

export function CompactTaskCard({ task, showCheckbox, checked, onCheckChange, onClick }: Props) {
  const priorityIcon = PRIORITY_ICONS[task.priority] ?? '';
  const isBlocked = task.blocked;

  return (
    <div
      className={`${styles.row}${isBlocked ? ` ${styles.blocked}` : ''}`}
      data-status={task.displayStatus}
      data-testid="compact-task-card"
    >
      <div className={styles.main} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}>
        {showCheckbox ? (
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={checked}
            onChange={(e) => {
              e.stopPropagation();
              onCheckChange(task.taskId, e.target.checked);
            }}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${task.taskName}`}
          />
        ) : (
          <span className={styles.checkboxPlaceholder} aria-hidden="true" />
        )}

        <span className={styles.priorityDot} aria-label={task.priority}>{priorityIcon}</span>
        <span className={styles.typeIcon} aria-hidden="true">{task.taskType.split(' ')[0]}</span>
        <span className={styles.taskName}>{task.taskName}</span>
      </div>

      {isBlocked && task.blockerNames.length > 0 && (
        <div className={styles.blockers} data-testid="blocker-names">
          {task.blockerNames.slice(0, 2).map((name, i) => (
            <span key={i} className={styles.blockerName}>↳ blocked by: {name}</span>
          ))}
          {task.blockerNames.length > 2 && (
            <span className={styles.blockerName}>↳ +{task.blockerNames.length - 2} more</span>
          )}
        </div>
      )}
    </div>
  );
}
