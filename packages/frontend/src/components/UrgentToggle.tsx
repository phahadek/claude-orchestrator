import { useState } from 'react';
import { authedFetch } from '../api/projects';
import type { TaskView } from '../types/taskView';
import { isUrgentToggleVisible } from '../utils/urgent';
import styles from './UrgentToggle.module.css';

interface UrgentToggleProps {
  task: TaskView;
  projectId: string;
}

export function UrgentToggle({ task, projectId }: UrgentToggleProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isUrgentToggleVisible(task)) return null;

  const direct = Boolean(task.urgent);
  const inherited = !direct && Boolean(task.executionRank?.urgentInherited);
  const state = direct ? 'on' : inherited ? 'inherited' : 'off';
  const label = direct
    ? 'Urgent: on (click to clear)'
    : inherited
      ? 'Urgent: inherited from a blocked-by dependent (click to flag directly)'
      : 'Urgent: off (click to flag)';

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await authedFetch(
        `/api/tasks/${encodeURIComponent(task.taskId)}/urgent?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urgent: !task.urgent }),
        },
      );
      if (!res.ok) {
        let message = `${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          /* non-JSON body */
        }
        setError(message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      className={`${styles.siren} ${styles[state]}`}
      data-testid="urgent-toggle"
      data-state={state}
      aria-pressed={direct}
      aria-label={label}
      title={error ? `Failed: ${error}` : label}
      disabled={pending}
      onClick={(e) => void handleClick(e)}
      onKeyDown={(e) => e.stopPropagation()}
    >
      🚨
    </button>
  );
}
