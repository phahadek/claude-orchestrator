import type { TaskView } from '../types/taskView';
import { CompactTaskCard } from './CompactTaskCard';
import { sortByPriority } from '../utils/taskSort';
import styles from './TaskList.module.css';

interface Props {
  tasks: TaskView[];
  isExpanded: boolean;
  onToggleCollapse: () => void;
  onSelectTask: (taskId: string) => void;
}

/** Compact single-line section for backlog code tasks — sits directly below the Code section. */
export function BacklogCodeSection({
  tasks,
  isExpanded,
  onToggleCollapse,
  onSelectTask,
}: Props) {
  if (tasks.length === 0) return null;

  const sorted = sortByPriority(tasks);

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
          {sorted.map((task) => (
            <CompactTaskCard
              key={task.taskId}
              task={task}
              showCheckbox={false}
              checked={false}
              onCheckChange={() => {}}
              onClick={() => onSelectTask(task.taskId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
