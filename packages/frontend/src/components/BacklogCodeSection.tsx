import type { TaskView } from '../types/taskView';
import { CompactTaskCard } from './CompactTaskCard';
import { sortByPriority } from '../utils/taskSort';
import { MODEL_OPTIONS, EFFORT_OPTIONS } from './Settings.helpers';
import styles from './TaskList.module.css';

interface Props {
  tasks: TaskView[];
  isExpanded: boolean;
  onToggleCollapse: () => void;
  onSelectTask: (taskId: string) => void;
  /** Groom selection mode — reuses the same checkedIds + Select All pattern as ReadySection. */
  groomCheckedIds?: Set<string>;
  onGroomCheckChange?: (taskId: string, checked: boolean) => void;
  /** Total groomable count across code + non-code Backlog tasks, and its selected count. */
  groomableCount?: number;
  groomSelectedCount?: number;
  onGroomSelectAll?: () => void;
  onGroomLaunch?: () => void;
  groomLoading?: boolean;
  /** Per-launch model/effort override for the Groom(N) button — '' falls back to the runtime setting. */
  launchModel?: string;
  onLaunchModelChange?: (value: string) => void;
  launchEffort?: string;
  onLaunchEffortChange?: (value: string) => void;
}

/** Compact single-line section for backlog code tasks — sits directly below the Code section. */
export function BacklogCodeSection({
  tasks,
  isExpanded,
  onToggleCollapse,
  onSelectTask,
  groomCheckedIds,
  onGroomCheckChange,
  groomableCount = 0,
  groomSelectedCount = 0,
  onGroomSelectAll,
  onGroomLaunch,
  groomLoading = false,
  launchModel = '',
  onLaunchModelChange,
  launchEffort = '',
  onLaunchEffortChange,
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
        {groomable && groomableCount > 0 && (
          <div
            className={styles.launchControls}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className={styles.selectAllBtn}
              onClick={onGroomSelectAll}
              disabled={groomableCount === 0 || groomLoading}
              data-testid="groom-select-all-btn"
            >
              Select All
            </button>
            {onLaunchModelChange && (
              <select
                className={styles.select}
                value={launchModel}
                onChange={(e) => onLaunchModelChange(e.target.value)}
                disabled={groomLoading}
                data-testid="groom-model-select"
              >
                {MODEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            {onLaunchEffortChange && (
              <select
                className={styles.select}
                value={launchEffort}
                onChange={(e) => onLaunchEffortChange(e.target.value)}
                disabled={groomLoading}
                data-testid="groom-effort-select"
              >
                {EFFORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            <button
              className={styles.groomBtn}
              onClick={onGroomLaunch}
              disabled={groomSelectedCount === 0 || groomLoading}
              data-testid="groom-btn"
            >
              {groomLoading ? 'Loading…' : `Groom (${groomSelectedCount})`}
            </button>
          </div>
        )}
      </div>

      {isExpanded && (
        <div className={styles.groupCards}>
          {sorted.map((task) => (
            <CompactTaskCard
              key={task.taskId}
              task={task}
              showCheckbox={groomable}
              checked={groomable && groomCheckedIds!.has(task.taskId)}
              onCheckChange={onGroomCheckChange ?? (() => {})}
              onClick={() => onSelectTask(task.taskId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
