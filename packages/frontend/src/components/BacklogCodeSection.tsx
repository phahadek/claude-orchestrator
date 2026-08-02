import type { TaskView } from '../types/taskView';
import { CompactTaskCard } from './CompactTaskCard';
import { sortByPriority } from '../utils/taskSort';
import styles from './TaskList.module.css';

interface Props {
  tasks: TaskView[];
  isExpanded: boolean;
  onToggleCollapse: () => void;
  onSelectTask: (taskId: string) => void;
  /** Groom selection mode — reuses the same checkedIds + Select All pattern as ReadySection. */
  groomCheckedIds?: Set<string>;
  onGroomCheckChange?: (taskId: string, checked: boolean) => void;
}

/** Compact single-line section for backlog code tasks — sits directly below the Code section. */
export function BacklogCodeSection({
  tasks,
  isExpanded,
  onToggleCollapse,
  onSelectTask,
  groomCheckedIds,
  onGroomCheckChange,
}: Props) {
  if (tasks.length === 0) return null;

  const sorted = sortByPriority(tasks);
  const groomable = groomCheckedIds !== undefined;

  return (
    <div
      className={`${styles.group} ${styles.backlogGroup}`}
      data-status="backlog"
      data-testid="backlog-section"
    >
      <div
        className={`${styles.groupHeader} ${styles.groupHeaderToggle}`}
        onClick={onToggleCollapse}
        role="button"
        aria-expanded={isExpanded}
        data-testid="group-header-backlog"
      >
        <span className={styles.toggle} aria-hidden="true">
          {isExpanded ? '▼' : '▶'}
        </span>
        <span className={styles.groupLabel}>🔲 Backlog — Code</span>
        <span className={styles.groupCount}>{sorted.length}</span>
      </div>

      {isExpanded && (
        <div className={styles.groupCards}>
          {sorted.map((task) => {
            const depBlocked = groomable && !!task.groomDepBlocked;
            return (
              <CompactTaskCard
                key={task.taskId}
                task={task}
                showCheckbox={groomable && !depBlocked}
                checked={
                  groomable && !depBlocked && groomCheckedIds!.has(task.taskId)
                }
                onCheckChange={onGroomCheckChange ?? (() => {})}
                blockedReason={depBlocked ? task.groomDepBlockedReason : null}
                onClick={() => onSelectTask(task.taskId)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
