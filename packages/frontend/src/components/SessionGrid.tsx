import { useState } from 'react';
import type { SessionState } from '../hooks/useSessionStore';
import { SessionCard } from './SessionCard';
import styles from './SessionGrid.module.css';

const ALL_STATUSES = ['running', 'starting', 'needs_permission', 'done', 'error', 'killed'] as const;
type Status = typeof ALL_STATUSES[number];

const STATUS_LABELS: Record<Status, string> = {
  running: 'Running',
  starting: 'Starting',
  needs_permission: 'Permission',
  done: 'Done',
  error: 'Error',
  killed: 'Killed',
};

interface Props {
  sessions: SessionState[];
  onSelect: (sessionId: string) => void;
  selectedId: string | null;
  synced: boolean;
  onArchiveAll: () => void;
}

export function SessionGrid({ sessions, onSelect, selectedId, synced, onArchiveAll }: Props) {
  const [activeFilters, setActiveFilters] = useState<Set<Status>>(new Set());

  function toggleFilter(status: Status) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  }

  const visibleSessions = sessions.filter((s) => !s.archived);
  const archivableCount = visibleSessions.filter((s) => ['done', 'error', 'killed'].includes(s.status)).length;

  const filtered = activeFilters.size === 0
    ? visibleSessions
    : visibleSessions.filter((s) => activeFilters.has(s.status as Status));

  const sorted = [...filtered].sort((a, b) => {
    const rank = statusRank(a.status) - statusRank(b.status);
    if (rank !== 0) return rank;
    return (b.started_at ?? 0) - (a.started_at ?? 0);
  });

  const statusesInUse = new Set(visibleSessions.map((s) => s.status as Status));

  return (
    <div>
      {visibleSessions.length > 0 && (
        <div className={styles['filter-bar']}>
          {ALL_STATUSES.filter((s) => statusesInUse.has(s)).map((status) => (
            <button
              key={status}
              className={[
                styles['filter-toggle'],
                activeFilters.has(status) ? styles['filter-toggle--active'] : '',
              ].join(' ')}
              onClick={() => toggleFilter(status)}
            >
              {STATUS_LABELS[status]}
            </button>
          ))}
          {activeFilters.size > 0 && (
            <button
              className={styles['filter-clear']}
              onClick={() => setActiveFilters(new Set())}
            >
              Clear
            </button>
          )}
          {archivableCount > 0 && (
            <button
              className={styles['archive-all-button']}
              onClick={onArchiveAll}
            >
              Archive done/error/killed
            </button>
          )}
        </div>
      )}

      {!synced && visibleSessions.length === 0 && (
        <div className={styles['session-grid']}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles['skeleton-card']}>
              <div className={styles['skeleton-line']} style={{ width: '60%' }} />
              <div className={styles['skeleton-line']} style={{ width: '40%' }} />
              <div className={styles['skeleton-line']} style={{ width: '80%' }} />
            </div>
          ))}
        </div>
      )}

      {synced && sorted.length === 0 && visibleSessions.length === 0 && (
        <div className={styles['session-grid-empty']}>
          <p>No sessions yet. Dispatch a task to get started.</p>
        </div>
      )}

      {sorted.length === 0 && visibleSessions.length > 0 && (
        <div className={styles['session-grid-empty']}>
          <p>No sessions match the selected filters.</p>
        </div>
      )}

      {sorted.length > 0 && (
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
      )}
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
