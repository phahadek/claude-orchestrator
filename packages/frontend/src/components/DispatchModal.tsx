import { useState, useEffect } from 'react';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';
import type { ResolvedTask } from '@claude-dashboard/backend/src/notion/types';
import styles from './DispatchModal.module.css';

const PROJECT_CONTEXT_URL = import.meta.env.VITE_PROJECT_CONTEXT_URL as string;

interface Props {
  tasks: ResolvedTask[];
  tasksReady: boolean;
  send: (msg: ClientMessage) => void;
  boardId: string;
  onClose: () => void;
}

export function DispatchModal({ tasks, tasksReady, send, boardId, onClose }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    send({ type: 'fetch_tasks', boardId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tasksReady) setLoading(false);
  }, [tasksReady]);

  const ready = tasks.filter((t) => !t.blocked && !t.nonCode);
  const blocked = tasks.filter((t) => t.blocked || t.nonCode);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const launch = () => {
    const toDispatch = ready
      .filter((t) => selected.has(t.task.id))
      .map((t) => ({ taskUrl: t.task.notionUrl, projectContextUrl: PROJECT_CONTEXT_URL }));
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
          <p>Fetching tasks from Notion…</p>
        ) : (
          <>
            <section>
              <h3>✅ Ready ({ready.length})</h3>
              {ready.map((t) => (
                <label key={t.task.id} className={styles['ready-task']}>
                  <input
                    type="checkbox"
                    checked={selected.has(t.task.id)}
                    onChange={() => toggle(t.task.id)}
                  />
                  {t.task.title}
                </label>
              ))}
              {ready.length === 0 && <p className={styles.empty}>No unblocked tasks.</p>}
            </section>
            <section>
              <h3>🚫 Blocked ({blocked.length})</h3>
              {blocked.map((t) => (
                <div key={t.task.id} className={styles['blocked-task']}>
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
          </>
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
