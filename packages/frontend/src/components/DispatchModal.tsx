import { useState, useEffect } from 'react';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';
import type { ResolvedTask } from '@claude-dashboard/backend/src/notion/types';
import type { ProjectConfig } from '@claude-dashboard/backend/src/config';
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
  boardId?: string;
  onClose: () => void;
}

export function DispatchModal({ tasks, tasksReady, send, resetTasks, project, boardId, onClose }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    resetTasks();
    send({ type: 'fetch_tasks', projectId: project.id, boardId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tasksReady) setLoading(false);
  }, [tasksReady]);

  const ready = tasks.filter((t) => t.task.status === '🗂️ Ready' && !t.blocked && !t.nonCode);
  const blocked = tasks.filter((t) => t.task.status === '🗂️ Ready' && (t.blocked || t.nonCode));
  const inProgress = tasks.filter((t) => t.task.status === '🔄 In Progress');
  const inReview = tasks.filter((t) => t.task.status === '👀 In Review');

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const launch = () => {
    const toDispatch = ready
      .filter((t) => selected.has(t.task.id))
      .map((t) => ({ taskUrl: t.task.notionUrl, projectContextUrl: project.contextUrl, taskType: t.task.type, projectId: project.id }));
    if (toDispatch.length > 0) {
      send({ type: 'dispatch', tasks: toDispatch });
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
              <h3>✅ Ready ({ready.length})</h3>
              {ready.map((t) => (
                <label key={t.task.id} className={styles['ready-task']}>
                  <input
                    type="checkbox"
                    checked={selected.has(t.task.id)}
                    onChange={() => toggle(t.task.id)}
                  />
                  <span className={styles['type-icon']} title={t.task.type}>{taskTypeIcon(t.task.type)}</span>
                  {t.task.title}
                </label>
              ))}
              {ready.length === 0 && <p className={styles.empty}>No unblocked tasks.</p>}
            </section>
            {inProgress.length > 0 && (
              <section>
                <h3>🔄 In Progress ({inProgress.length})</h3>
                {inProgress.map((t) => (
                  <div key={t.task.id} className={styles['blocked-task']}>
                    <span className={styles['type-icon']} title={t.task.type}>{taskTypeIcon(t.task.type)}</span>
                    {t.task.title}
                  </div>
                ))}
              </section>
            )}
            {inReview.length > 0 && (
              <section>
                <h3>👀 In Review ({inReview.length})</h3>
                {inReview.map((t) => (
                  <div key={t.task.id} className={styles['blocked-task']}>
                    <span className={styles['type-icon']} title={t.task.type}>{taskTypeIcon(t.task.type)}</span>
                    {t.task.title}
                  </div>
                ))}
              </section>
            )}
            <section>
              <h3>🚫 Blocked ({blocked.length})</h3>
              {blocked.map((t) => (
                <div key={t.task.id} className={styles['blocked-task']}>
                  <span className={styles['type-icon']} title={t.task.type}>{taskTypeIcon(t.task.type)}</span>
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
            Launch{selected.size > 0 ? ` (${selected.size})` : ''} session{selected.size !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
