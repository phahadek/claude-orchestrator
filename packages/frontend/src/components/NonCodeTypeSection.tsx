import { useState } from 'react';
import type { TaskView, DisplayStatus } from '../types/taskView';
import { CompactTaskCard } from './CompactTaskCard';
import { sortByPriority, STATUS_EMOJI, typeSlug } from '../utils/taskSort';
import styles from './TaskList.module.css';

interface Props {
  /** Non-code, not-Done tasks across all statuses (ready, backlog, in_progress, etc). */
  tasks: TaskView[];
  onSelectTask: (taskId: string) => void;
  /** When provided, 🔲 Backlog-status tasks render a checkbox (Groom selection mode). */
  groomCheckedIds?: Set<string>;
  onGroomCheckChange?: (taskId: string, checked: boolean) => void;
}

const TYPE_ORDER = [
  '📐 Design',
  '🔧 Operational',
  '🔎 Investigation',
  '🛠️ Tooling',
  '📋 Planning',
  '🧪 Testing',
  '📝 Docs',
  '🚦 Gate',
];

const STATUS_BREAKDOWN_ORDER: DisplayStatus[] = [
  'needs_attention',
  'in_progress',
  'in_review',
  'ready_to_merge',
  'ready',
  'backlog',
  'blocked',
  'deferred',
];

function sortTypes(types: string[]): string[] {
  return [...types].sort((a, b) => {
    const ai = TYPE_ORDER.indexOf(a);
    const bi = TYPE_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
}

/** One summary card per non-code Type, each expandable into its remaining (not-Done) tasks. */
export function NonCodeTypeSection({
  tasks,
  onSelectTask,
  groomCheckedIds,
  onGroomCheckChange,
}: Props) {
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());

  if (tasks.length === 0) return null;

  const byType = new Map<string, TaskView[]>();
  for (const task of tasks) {
    if (!byType.has(task.taskType)) byType.set(task.taskType, []);
    byType.get(task.taskType)!.push(task);
  }

  const typeKeys = sortTypes(Array.from(byType.keys()));

  function toggleType(type: string) {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  return (
    <div data-testid="non-code-type-section">
      {typeKeys.map((type) => {
        const typeTasks = sortByPriority(byType.get(type)!);
        const isExpanded = expandedTypes.has(type);
        const slug = typeSlug(type);

        const counts = new Map<DisplayStatus, number>();
        for (const task of typeTasks) {
          counts.set(
            task.displayStatus,
            (counts.get(task.displayStatus) ?? 0) + 1,
          );
        }

        return (
          <div
            key={type}
            className={styles.typeCard}
            data-testid={`type-card-${slug}`}
          >
            <div
              className={`${styles.groupHeader} ${styles.groupHeaderToggle}`}
              onClick={() => toggleType(type)}
              role="button"
              aria-expanded={isExpanded}
              data-testid={`type-card-header-${slug}`}
            >
              <span className={styles.toggle} aria-hidden="true">
                {isExpanded ? '▼' : '▶'}
              </span>
              <span className={styles.groupLabel}>{type}</span>
              <span className={styles.groupCount}>{typeTasks.length}</span>
              <span
                className={styles.statusBreakdown}
                data-testid={`type-card-breakdown-${slug}`}
              >
                {STATUS_BREAKDOWN_ORDER.filter((status) =>
                  counts.get(status),
                ).map((status) => (
                  <span key={status} className={styles.statusBadge}>
                    {STATUS_EMOJI[status]} {counts.get(status)}
                  </span>
                ))}
              </span>
            </div>

            {isExpanded && (
              <div className={styles.groupCards}>
                {typeTasks.map((task) => {
                  const groomable =
                    groomCheckedIds !== undefined &&
                    task.displayStatus === 'backlog';
                  return (
                    <CompactTaskCard
                      key={task.taskId}
                      task={task}
                      showCheckbox={groomable}
                      checked={groomable && groomCheckedIds!.has(task.taskId)}
                      onCheckChange={
                        groomable
                          ? (onGroomCheckChange ?? (() => {}))
                          : () => {}
                      }
                      onClick={() => onSelectTask(task.taskId)}
                      showStatus
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
