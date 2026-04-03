import { useState, useEffect, useCallback } from 'react';
import type { TaskView, DisplayStatus } from '../types/taskView';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';
import type { ProjectConfig } from '@claude-dashboard/backend/src/config';
import { TaskCard } from './TaskCard';
import { CompactTaskCard } from './CompactTaskCard';
import { useDispatch } from '../hooks/useDispatch';
import styles from './TaskList.module.css';

interface Props {
  activeProjectId: string | null;
  boardId: string | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  /** Latest task_updated WS message — merges a single task in-place without a full re-fetch. */
  lastTaskUpdate?: TaskView | null;
  /** Incremented when a review session starts or pr_review_complete arrives — triggers a full re-fetch. */
  reviewRefreshTrigger?: number;
  send: (msg: ClientMessage) => void;
  project: ProjectConfig | null;
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

/** Group tasks by wave number, returning a map of wave → sorted tasks. */
function groupByWave(tasks: TaskView[]): Map<number, TaskView[]> {
  const map = new Map<number, TaskView[]>();
  for (const task of tasks) {
    const wave = task.wave ?? 1;
    if (!map.has(wave)) map.set(wave, []);
    map.get(wave)!.push(task);
  }
  for (const [, waveTasks] of map) {
    waveTasks.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  }
  return map;
}

/** Compact wave-grouped section for Ready tasks with Select All / Launch controls. */
function ReadySection({
  tasks,
  nonCodeTasks,
  onSelectTask,
  send,
  project,
  isExpanded,
  onToggleCollapse,
}: {
  tasks: TaskView[];
  nonCodeTasks: TaskView[];
  onSelectTask: (taskId: string) => void;
  send: (msg: ClientMessage) => void;
  project: ProjectConfig | null;
  isExpanded: boolean;
  onToggleCollapse: () => void;
}) {
  const dispatch = useDispatch(send, project);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  // Wave 2+ start collapsed
  const [collapsedWaves, setCollapsedWaves] = useState<Set<number>>(new Set());

  const wave1CodeTasks = tasks.filter((t) => (t.wave ?? 1) === 1 && !t.blocked);
  const totalCount = tasks.length + nonCodeTasks.length;
  const waveMap = groupByWave(tasks);
  const waveNumbers = Array.from(waveMap.keys()).sort((a, b) => a - b);

  function toggleCheck(taskId: string, checked: boolean) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }

  function handleSelectAll() {
    setCheckedIds(new Set(wave1CodeTasks.map((t) => t.taskId)));
  }

  function handleLaunch() {
    const toDispatch = wave1CodeTasks
      .filter((t) => checkedIds.has(t.taskId))
      .map((t) => ({ taskUrl: t.notionUrl, taskType: t.taskType }));
    if (toDispatch.length === 0) return;
    dispatch(toDispatch);
    setCheckedIds(new Set());
  }

  function toggleWaveCollapse(wave: number) {
    setCollapsedWaves((prev) => {
      const next = new Set(prev);
      if (next.has(wave)) next.delete(wave);
      else next.add(wave);
      return next;
    });
  }

  const checkedCount = wave1CodeTasks.filter((t) => checkedIds.has(t.taskId)).length;

  return (
    <div className={styles.group} data-status="ready" data-testid="ready-section">
      <div
        className={`${styles.groupHeader} ${styles.groupHeaderToggle}`}
        onClick={onToggleCollapse}
        role="button"
        aria-expanded={isExpanded}
        data-testid="group-header-ready"
      >
        <span className={styles.toggle} aria-hidden="true">
          {isExpanded ? '▼' : '▶'}
        </span>
        <span className={styles.groupLabel}>{GROUP_LABELS.ready}</span>
        <span className={styles.groupCount}>{totalCount}</span>
        <div
          className={styles.launchControls}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className={styles.selectAllBtn}
            onClick={handleSelectAll}
            disabled={wave1CodeTasks.length === 0}
            data-testid="select-all-btn"
          >
            Select All
          </button>
          <button
            className={styles.launchBtn}
            onClick={handleLaunch}
            disabled={checkedCount === 0}
            data-testid="launch-btn"
          >
            Launch ({checkedCount})
          </button>
        </div>
      </div>

      {isExpanded && (
      <div className={styles.groupCards}>
        {waveNumbers.map((wave) => {
          const waveTasks = waveMap.get(wave)!;
          const isCollapsed = collapsedWaves.has(wave);
          const isExpanded = !isCollapsed;

          return (
            <div key={wave} className={styles.waveGroup} data-testid={`wave-group-${wave}`}>
              <div
                className={styles.waveHeader}
                onClick={() => { if (wave > 1) toggleWaveCollapse(wave); }}
                role={wave > 1 ? 'button' : undefined}
                aria-expanded={wave > 1 ? isExpanded : undefined}
                data-testid={`wave-header-${wave}`}
              >
                <span className={styles.waveLabel}>Wave {wave}</span>
                {wave > 1 && (
                  <span className={styles.waveToggle} aria-hidden="true">
                    {isExpanded ? '▾' : '▸'}
                  </span>
                )}
              </div>

              {isExpanded && waveTasks.map((task) => (
                <CompactTaskCard
                  key={task.taskId}
                  task={task}
                  showCheckbox={wave === 1 && !task.blocked && task.taskType.includes('💻')}
                  checked={checkedIds.has(task.taskId)}
                  onCheckChange={toggleCheck}
                  onClick={() => onSelectTask(task.taskId)}
                />
              ))}
            </div>
          );
        })}

        {nonCodeTasks.length > 0 && (
          <div className={styles.waveGroup} data-testid="non-code-wave-group">
            <div className={styles.waveHeader} data-testid="non-code-wave-header">
              <span className={styles.waveLabel}>Non-Code</span>
            </div>
            {nonCodeTasks
              .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
              .map((task) => (
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
      )}
    </div>
  );
}

export function TaskList({ activeProjectId, boardId, selectedTaskId, onSelectTask, lastTaskUpdate, reviewRefreshTrigger, send, project }: Props) {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['done']));

  const toggleGroup = useCallback((status: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

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

  // Re-fetch when a review session starts or a pr_review_complete event arrives
  useEffect(() => {
    if (!reviewRefreshTrigger) return;
    void fetchTasks();
  }, [reviewRefreshTrigger, fetchTasks]);

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

  const codeTasks = tasks.filter((t) => t.taskType.includes('💻'));
  const nonCodeTasks = tasks.filter((t) => !t.taskType.includes('💻'));

  const readyCodeTasks = codeTasks.filter((t) => t.displayStatus === 'ready');
  const readyNonCodeTasks = nonCodeTasks.filter((t) => t.displayStatus === 'ready');
  const hasReadyTasks = readyCodeTasks.length > 0 || readyNonCodeTasks.length > 0;

  const nonReadyCodeTasks = codeTasks.filter((t) => t.displayStatus !== 'ready');
  const nonReadyNonCodeTasks = nonCodeTasks
    .filter((t) => t.displayStatus !== 'ready')
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));

  // Build per-status lookup for non-ready code tasks
  const nonReadyGroupMap = new Map<DisplayStatus, TaskView[]>();
  for (const status of GROUP_ORDER) {
    if (status === 'ready') continue;
    nonReadyGroupMap.set(
      status,
      nonReadyCodeTasks
        .filter((t) => t.displayStatus === status)
        .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority)),
    );
  }

  return (
    <div className={styles.taskList} data-testid="task-list">
      {GROUP_ORDER.map((status) => {
        if (status === 'ready') {
          // Compact wave-grouped section for ready tasks
          if (!hasReadyTasks) return null;
          return (
            <ReadySection
              key="ready"
              tasks={readyCodeTasks}
              nonCodeTasks={readyNonCodeTasks}
              onSelectTask={onSelectTask}
              send={send}
              project={project}
              isExpanded={!collapsed.has('ready')}
              onToggleCollapse={() => toggleGroup('ready')}
            />
          );
        }

        const groupTasks = nonReadyGroupMap.get(status) ?? [];
        if (groupTasks.length === 0) return null;

        const isExpanded = !collapsed.has(status);
        const label = GROUP_LABELS[status];

        return (
          <div key={status} className={styles.group} data-status={status}>
            <div
              className={`${styles.groupHeader} ${styles.groupHeaderToggle}`}
              onClick={() => toggleGroup(status)}
              role="button"
              aria-expanded={isExpanded}
              data-testid={`group-header-${status}`}
            >
              <span className={styles.groupLabel}>{label}</span>
              <span className={styles.groupCount}>{groupTasks.length}</span>
              <span className={styles.toggle} aria-hidden="true">
                {isExpanded ? '▼' : '▶'}
              </span>
            </div>

            {isExpanded && (
              <div className={styles.groupCards}>
                {groupTasks.map((task) => (
                  <TaskCard
                    key={task.taskId}
                    task={task}
                    selected={task.taskId === selectedTaskId}
                    onClick={() => onSelectTask(task.taskId)}
                    send={send}
                    project={project}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {nonReadyNonCodeTasks.length > 0 && (
        <div className={`${styles.group} ${styles.nonCodeGroup}`} data-testid="non-code-section">
          <div
            className={`${styles.groupHeader} ${styles.groupHeaderToggle}`}
            onClick={() => toggleGroup('planning')}
            role="button"
            aria-expanded={!collapsed.has('planning')}
            data-testid="group-header-planning"
          >
            <span className={styles.toggle} aria-hidden="true">
              {!collapsed.has('planning') ? '▼' : '▶'}
            </span>
            <span className={styles.groupLabel}>📋 Planning / Testing</span>
            <span className={styles.groupCount}>{nonReadyNonCodeTasks.length}</span>
          </div>
          {!collapsed.has('planning') && (
            <div className={styles.groupCards}>
              {nonReadyNonCodeTasks.map((task) => (
                <TaskCard
                  key={task.taskId}
                  task={task}
                  selected={task.taskId === selectedTaskId}
                  onClick={() => onSelectTask(task.taskId)}
                  send={send}
                  project={project}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
