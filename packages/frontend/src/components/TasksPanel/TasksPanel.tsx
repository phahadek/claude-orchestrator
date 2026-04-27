import { useMemo } from 'react';
import type { ResolvedTask } from '@claude-orchestrator/backend/src/notion/types';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { SessionState } from '../../hooks/useSessionStore';
import { useTasks } from '../../hooks/useTasks';
import styles from './TasksPanel.module.css';

interface Props {
  projectId: string | null;
  milestoneId: string | null;
  milestoneName: string | null;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  send: (msg: ClientMessage) => boolean;
  /** Tasks slice from useSessionStore — populated by tasks_ready WS messages. */
  tasks: ResolvedTask[];
  /** Active sessions Map values — used to compute Linked Session badges. */
  sessions: SessionState[];
  /** Counter that increments on WS events that should trigger an auto-refresh. */
  refreshTrigger?: number;
}

const STATUS_BUCKET_ORDER = ['in_progress', 'ready', 'backlog', 'done', 'other'] as const;
type StatusBucket = (typeof STATUS_BUCKET_ORDER)[number];

const STATUS_BUCKET_LABELS: Record<StatusBucket, string> = {
  in_progress: '🔄 In Progress',
  ready: '🗂️ Ready',
  backlog: '🔲 Backlog',
  done: '✅ Done',
  other: 'Other',
};

function statusBucket(status: string): StatusBucket {
  if (status.includes('In Progress') || status.includes('In Review') || status.includes('Needs Attention')) {
    return 'in_progress';
  }
  if (status.includes('Ready')) return 'ready';
  if (status.includes('Backlog')) return 'backlog';
  if (status.includes('Done') || status.includes('Deferred')) return 'done';
  return 'other';
}

const PRIORITY_RANK: Record<string, number> = {
  '🔴 High': 0,
  '🟡 Medium': 1,
  '🟢 Low': 2,
};

function priorityRank(p: string | undefined): number {
  if (!p) return 99;
  return PRIORITY_RANK[p] ?? 99;
}

function priorityIcon(p: string | undefined): string {
  if (!p) return '';
  if (p.includes('High')) return '🔴';
  if (p.includes('Medium')) return '🟡';
  if (p.includes('Low')) return '🟢';
  return '';
}

function typeIcon(t: string): string {
  if (t.includes('💻')) return '💻';
  if (t.includes('📋')) return '📋';
  if (t.includes('🧪')) return '🧪';
  return '';
}

/** Find a session whose notionTaskUrl points at the same task as the row. */
function findLinkedSession(task: ResolvedTask, sessions: SessionState[]): SessionState | null {
  const url = task.task.notionUrl;
  const id = task.task.id;
  for (const s of sessions) {
    if (s.archived) continue;
    if (s.sessionType === 'review') continue;
    if (url && s.notionTaskUrl === url) return s;
    if (id && s.notionTaskUrl && s.notionTaskUrl.includes(id.replace(/-/g, ''))) return s;
  }
  return null;
}

export function TasksPanel({
  projectId,
  milestoneId,
  milestoneName,
  selectedTaskId,
  onSelectTask,
  onSelectSession,
  send,
  tasks: storeTasks,
  sessions,
  refreshTrigger,
}: Props) {
  const { tasks, loading, refresh } = useTasks({
    projectId,
    milestoneId,
    send,
    tasks: storeTasks,
    refreshTrigger,
  });

  const grouped = useMemo(() => {
    const buckets: Record<StatusBucket, ResolvedTask[]> = {
      in_progress: [],
      ready: [],
      backlog: [],
      done: [],
      other: [],
    };
    for (const t of tasks) {
      buckets[statusBucket(t.task.status)].push(t);
    }
    for (const key of STATUS_BUCKET_ORDER) {
      buckets[key].sort((a, b) => priorityRank(a.task.priority) - priorityRank(b.task.priority));
    }
    return buckets;
  }, [tasks]);

  const totalTasks = tasks.length;

  const refreshButton = (
    <button
      type="button"
      className={`${styles.refreshBtn}${loading ? ` ${styles.refreshBtnLoading}` : ''}`}
      onClick={refresh}
      disabled={loading || !projectId || !milestoneId}
      aria-busy={loading}
      title="Refresh tasks"
      data-testid="tasks-panel-refresh-btn"
    >
      <span className={styles.refreshIcon} aria-hidden="true">↻</span>
      {loading ? 'Refreshing…' : 'Refresh'}
    </button>
  );

  if (loading && totalTasks === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>Tasks</span>
          {refreshButton}
        </div>
        <div className={styles.loading} data-testid="tasks-panel-loading">
          <span className={styles.loadingSpinner} aria-hidden="true" />
          <span>Loading tasks…</span>
        </div>
      </div>
    );
  }

  if (totalTasks === 0) {
    const milestoneLabel = milestoneName ?? milestoneId ?? 'this milestone';
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>Tasks</span>
          {refreshButton}
        </div>
        <div className={styles.empty} data-testid="tasks-panel-empty">
          No tasks in {milestoneLabel}. Add tasks via Notion or tasks.yaml.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>{totalTasks} task{totalTasks === 1 ? '' : 's'}</span>
        {refreshButton}
      </div>
      <div className={styles.list} data-testid="tasks-panel-list">
        {STATUS_BUCKET_ORDER.map((bucket) => {
          const rows = grouped[bucket];
          if (rows.length === 0) return null;
          return (
            <div key={bucket} data-testid={`tasks-panel-group-${bucket}`}>
              <div className={styles.groupHeader}>
                {STATUS_BUCKET_LABELS[bucket]} ({rows.length})
              </div>
              {rows.map((task) => (
                <TaskRow
                  key={task.task.id}
                  task={task}
                  selected={task.task.id === selectedTaskId}
                  session={findLinkedSession(task, sessions)}
                  onSelect={() => onSelectTask(task.task.id)}
                  onSelectSession={onSelectSession}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RowProps {
  task: ResolvedTask;
  selected: boolean;
  session: SessionState | null;
  onSelect: () => void;
  onSelectSession?: (sessionId: string) => void;
}

function TaskRow({ task, selected, session, onSelect, onSelectSession }: RowProps) {
  const status = task.task.status;
  const prUrl = task.task.prUrl;
  return (
    <div
      className={`${styles.row}${selected ? ` ${styles.rowSelected}` : ''}`}
      data-testid="tasks-panel-row"
      data-task-id={task.task.id}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect();
      }}
    >
      <span className={styles.priorityDot} aria-label={task.task.priority ?? ''}>
        {priorityIcon(task.task.priority)}
      </span>
      <span className={styles.typeIcon} aria-hidden="true">
        {typeIcon(task.task.type)}
      </span>
      <span className={styles.statusBadge}>{status}</span>
      <span className={styles.taskName} title={task.task.title}>{task.task.title}</span>
      <span className={styles.badges}>
        {session && (
          <button
            type="button"
            className={styles.linkBadge}
            onClick={(e) => {
              e.stopPropagation();
              onSelectSession?.(session.sessionId);
            }}
            data-testid="tasks-panel-session-badge"
            title={`Open session ${session.sessionId.slice(0, 8)}`}
          >
            ▶ session
          </button>
        )}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.linkBadge}
            onClick={(e) => e.stopPropagation()}
            data-testid="tasks-panel-pr-badge"
            title={prUrl}
          >
            PR
          </a>
        )}
      </span>
    </div>
  );
}
