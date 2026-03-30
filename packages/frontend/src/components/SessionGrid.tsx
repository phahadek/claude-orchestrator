import type { SessionState } from '../hooks/useSessionStore';
import { SessionCard } from './SessionCard';
import styles from './SessionGrid.module.css';

interface Props {
  sessions: SessionState[];
  onSelect: (sessionId: string) => void;
  selectedId: string | null;
}

export function SessionGrid({ sessions, onSelect, selectedId }: Props) {
  const sorted = [...sessions].sort((a, b) => statusRank(a.status) - statusRank(b.status));

  if (sorted.length === 0) {
    return (
      <div className={styles['session-grid-empty']}>
        <p>No sessions yet. Dispatch a task to get started.</p>
      </div>
    );
  }

  return (
    <div className={styles['session-grid']}>
      {sorted.map((s) => (
        <SessionCard
          key={s.sessionId}
          session={s}
          selected={s.sessionId === selectedId}
          onClick={() => onSelect(s.sessionId)}
        />
      ))}
    </div>
  );
}

function statusRank(status: string): number {
  const order: Record<string, number> = {
    needs_permission: 0,
    running: 1,
    starting: 2,
    done: 3,
    error: 3,
    killed: 3,
  };
  return order[status] ?? 99;
}
