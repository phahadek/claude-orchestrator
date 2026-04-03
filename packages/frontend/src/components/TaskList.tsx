import { useState, useEffect, useCallback } from 'react';
import type { TaskView, DisplayStatus } from '../types/taskView';
import { TaskCard } from './TaskCard';
import styles from './TaskList.module.css';

interface Props {
  activeProjectId: string | null;
  boardId: string | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  /** Latest task_updated WS message — merges a single task in-place without a full re-fetch. */
  lastTaskUpdate?: TaskView | null;
}

const GROUP_ORDER: DisplayStatus[] = [
  'needs_attention',
  'ready_to_merge',
  'in_progress',
  'in_review',
  'ready',
  'done',
];

const GROUP_LABELS: Record<DisplayStatus, string> = {
  needs_attention: '⚠️ Needs Attention',
  ready_to_merge: '✅ Ready to Merge',
  in_progress: '🔄 In Progress',
  in_review: '👀 In Review',
  ready: '🗂️ Ready',
  done: '✔️ Done',
};

const PRIORITY_RANK: Record<string, number> = {
  '🔴 High': 0,
  '🟡 Medium': 1,
  '🟢 Low': 2,
};

function priorityRank(p: string): number {
  return PRIORITY_RANK[p] ?? 99;
}

export function TaskList({ activeProjectId, boardId, selectedTaskId, onSelectTask, lastTaskUpdate }: Props) {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [doneExpanded, setDoneExpanded] = useState(false);

  const fetchTasks = useCallback(async () => {
    if (!activeProjectId) {
      setLoading(false);
      return;
    }
    try {
      const params = new URLSearchParams({ projectId: activeProjectId });
      if (boardId) params.set('boardId', boardId);
      const res = await fetch(`/api/tasks/active?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json() as TaskView[];
      setTasks(data);
    } catch {
      // ignore fetch errors — stale data remains visible
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, boardId]);

  // Full re-fetch only on mount and when projectId/boardId changes
  useEffect(() => {
    setLoading(true);
    setTasks([]);
    void fetchTasks();
  }, [fetchTasks]);

  // Merge a single task in-place when a task_updated WS message arrives
  useEffect(() => {
    if (!lastTaskUpdate) return;
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.taskId === lastTaskUpdate.taskId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = lastTaskUpdate;
        return next;
      }
      // New task not yet in list — append it
      return [...prev, lastTaskUpdate];
    });
  }, [lastTaskUpdate]);

  if (loading) {
    return (
      <div className={styles.loading} data-testid="task-list-loading">
        <span className={styles.loadingSpinner} aria-hidden="true" />
        <span>Loading tasks…</span>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className={styles.empty} data-testid="task-list-empty">
        No active tasks found.
      </div>
    );
  }

  const groups = GROUP_ORDER.map((status) => ({
    status,
    tasks: tasks
      .filter((t) => t.displayStatus === status)
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority)),
  })).filter((g) => g.tasks.length > 0);

  return (
    <div className={styles.taskList} data-testid="task-list">
      {groups.map(({ status, tasks: groupTasks }) => {
        const isDone = status === 'done';
        const isExpanded = isDone ? doneExpanded : true;
        const label = GROUP_LABELS[status];

        return (
          <div key={status} className={styles.group} data-status={status}>
            <div
              className={`${styles.groupHeader}${isDone ? ` ${styles.groupHeaderToggle}` : ''}`}
              onClick={isDone ? () => setDoneExpanded((v) => !v) : undefined}
              role={isDone ? 'button' : undefined}
              aria-expanded={isDone ? isExpanded : undefined}
            >
              <span className={styles.groupLabel}>{label}</span>
              <span className={styles.groupCount}>{groupTasks.length}</span>
              {isDone && (
                <span className={styles.toggle} aria-hidden="true">
                  {isExpanded ? '▼' : '▶'}
                </span>
              )}
            </div>

            {isExpanded && (
              <div className={styles.groupCards}>
                {groupTasks.map((task) => (
                  <TaskCard
                    key={task.taskId}
                    task={task}
                    selected={task.taskId === selectedTaskId}
                    onClick={() => onSelectTask(task.taskId)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
