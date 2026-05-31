import { useState, useEffect } from 'react';
import { taskNameFromNotionUrl } from '../utils/notionUrl';
import { StatusBadge } from './StatusBadge';
import styles from './HistoryGrid.module.css';

interface ArchivedSession {
  session_id: string;
  task_url: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  pr_url: string | null;
}

interface HistoryGridProps {
  onSelect: (sessionId: string) => void;
}

export function HistoryGrid({ onSelect }: HistoryGridProps) {
  const [sessions, setSessions] = useState<ArchivedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/sessions/archived')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<ArchivedSession[]>;
      })
      .then((data) => {
        setSessions(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(String(err));
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <div className={styles.loading}>Loading history…</div>;
  }

  if (error) {
    return <div className={styles.error}>Failed to load history: {error}</div>;
  }

  if (sessions.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No archived sessions yet.</p>
      </div>
    );
  }

  return (
    <div className={styles.list}>
      {sessions.map((s) => {
        const taskName = s.task_url
          ? taskNameFromNotionUrl(s.task_url)
          : s.session_id.slice(0, 8);
        const duration =
          s.started_at != null
            ? formatDuration((s.ended_at ?? s.started_at) - s.started_at)
            : null;
        const endDate =
          s.ended_at != null ? new Date(s.ended_at).toLocaleDateString() : null;

        return (
          <div
            key={s.session_id}
            className={styles.row}
            onClick={() => onSelect(s.session_id)}
          >
            <div className={styles.rowMain}>
              <span className={styles.taskName}>{taskName}</span>
              <StatusBadge status={s.status} />
            </div>
            <div className={styles.rowMeta}>
              {endDate && <span>{endDate}</span>}
              {duration && <span>{duration}</span>}
              {s.pr_url && (
                <a
                  href={s.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.prLink}
                >
                  PR ↗
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
