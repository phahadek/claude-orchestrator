import { useState, useEffect, useCallback } from 'react';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ResolvedTask } from '@claude-orchestrator/backend/src/notion/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import { useDispatch } from '../hooks/useDispatch';
import styles from './DispatchModal.module.css';

function taskTypeIcon(type: string): string {
  if (type.includes('💻')) return '💻';
  if (type.includes('📋')) return '📋';
  if (type.includes('🧪')) return '🧪';
  return '';
}

interface Props {
  tasks: ResolvedTask[];
  tasksReady: boolean;
  send: (msg: ClientMessage) => void;
  resetTasks: () => void;
  project: ProjectConfig;
  /** Milestone row id — sent as `milestoneId` in fetch_tasks. */
  milestoneId: string;
  onClose: () => void;
}

type GroupKey = 'ready' | 'inProgress' | 'inReview' | 'blocked';

export function DispatchModal({
  tasks,
  tasksReady,
  send,
  resetTasks,
  project,
  milestoneId,
  onClose,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<GroupKey>>(new Set());
  const dispatchTasks = useDispatch(send, project);

  const toggleGroup = useCallback((key: GroupKey) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useEffect(() => {
    resetTasks();
    send({
      type: 'fetch_tasks',
      projectId: project.id,
      milestoneId,
      skipCache: true,
    });
    // Run once on modal open. project/milestoneId are fixed for this modal instance,
    // and including send/resetTasks would refetch on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tasksReady) setLoading(false);
  }, [tasksReady]);

  const ready = tasks.filter(
    (t) =>
      t.task.status === '🗂️ Ready' &&
      !t.blocked &&
      !t.nonCode &&
      t.task.type === '💻 Code',
  );
  const blocked = tasks.filter(
    (t) => t.task.status === '🗂️ Ready' && (t.blocked || t.nonCode),
  );
  const inProgress = tasks.filter((t) => t.task.status === '🔄 In Progress');
  const inReview = tasks.filter((t) => t.task.status === '👀 In Review');

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const launch = () => {
    const toDispatch = ready
      .filter((t) => selected.has(t.task.id))
      .map((t) => ({
        notionUrl: t.task.notionUrl,
        taskId: t.task.id,
        taskType: t.task.type,
        taskName: t.task.title,
        milestoneId,
      }));
    if (toDispatch.length > 0) {
      dispatchTasks(toDispatch);
      onClose();
    }
  };

  return (
    <div className={styles['modal-overlay']} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2>Launch Sessions</h2>
        {loading ? (
          <p className={styles.loading}>Fetching tasks from Notion…</p>
        ) : (
          <div className={styles['modal-body']}>
            <section>
              <h3
                className={styles['section-header']}
                role="button"
                aria-expanded={!collapsed.has('ready')}
                onClick={() => toggleGroup('ready')}
              >
                <span
                  className={`${styles.chevron}${collapsed.has('ready') ? ` ${styles.chevronCollapsed}` : ''}`}
                  aria-hidden="true"
                />
                ✅ Ready ({ready.length})
              </h3>
              {!collapsed.has('ready') && (
                <>
                  {ready.map((t) => (
                    <label key={t.task.id} className={styles['ready-task']}>
                      <input
                        type="checkbox"
                        checked={selected.has(t.task.id)}
                        onChange={() => toggle(t.task.id)}
                      />
                      <span className={styles['type-icon']} title={t.task.type}>
                        {taskTypeIcon(t.task.type)}
                      </span>
                      {t.task.title}
                    </label>
                  ))}
                  {ready.length === 0 && (
                    <p className={styles.empty}>No unblocked tasks.</p>
                  )}
                </>
              )}
            </section>
            {inProgress.length > 0 && (
              <section>
                <h3
                  className={styles['section-header']}
                  role="button"
                  aria-expanded={!collapsed.has('inProgress')}
                  onClick={() => toggleGroup('inProgress')}
                >
                  <span
                    className={`${styles.chevron}${collapsed.has('inProgress') ? ` ${styles.chevronCollapsed}` : ''}`}
                    aria-hidden="true"
                  />
                  🔄 In Progress ({inProgress.length})
                </h3>
                {!collapsed.has('inProgress') &&
                  inProgress.map((t) => (
                    <div key={t.task.id} className={styles['blocked-task']}>
                      <span className={styles['type-icon']} title={t.task.type}>
                        {taskTypeIcon(t.task.type)}
                      </span>
                      {t.task.title}
                    </div>
                  ))}
              </section>
            )}
            {inReview.length > 0 && (
              <section>
                <h3
                  className={styles['section-header']}
                  role="button"
                  aria-expanded={!collapsed.has('inReview')}
                  onClick={() => toggleGroup('inReview')}
                >
                  <span
                    className={`${styles.chevron}${collapsed.has('inReview') ? ` ${styles.chevronCollapsed}` : ''}`}
                    aria-hidden="true"
                  />
                  👀 In Review ({inReview.length})
                </h3>
                {!collapsed.has('inReview') &&
                  inReview.map((t) => (
                    <div key={t.task.id} className={styles['blocked-task']}>
                      <span className={styles['type-icon']} title={t.task.type}>
                        {taskTypeIcon(t.task.type)}
                      </span>
                      {t.task.title}
                    </div>
                  ))}
              </section>
            )}
            <section>
              <h3
                className={styles['section-header']}
                role="button"
                aria-expanded={!collapsed.has('blocked')}
                onClick={() => toggleGroup('blocked')}
              >
                <span
                  className={`${styles.chevron}${collapsed.has('blocked') ? ` ${styles.chevronCollapsed}` : ''}`}
                  aria-hidden="true"
                />
                🚫 Blocked ({blocked.length})
              </h3>
              {!collapsed.has('blocked') &&
                blocked.map((t) => (
                  <div key={t.task.id} className={styles['blocked-task']}>
                    <span className={styles['type-icon']} title={t.task.type}>
                      {taskTypeIcon(t.task.type)}
                    </span>
                    {t.task.title}
                    {t.nonCode && <span className={styles.tag}>non-code</span>}
                    {t.blocked && (
                      <span className={styles.tag}>
                        blocked by: {t.blockers.map((b) => b.title).join(', ')}
                      </span>
                    )}
                  </div>
                ))}
            </section>
          </div>
        )}
        <div className={styles['modal-footer']}>
          <button onClick={onClose}>Cancel</button>
          <button onClick={launch} disabled={selected.size === 0}>
            Launch{selected.size > 0 ? ` (${selected.size})` : ''} session
            {selected.size !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
