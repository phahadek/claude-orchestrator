import { useState } from 'react';
import type { SessionState } from '../hooks/useSessionStore';
import type { ProjectConfig } from '@claude-dashboard/backend/src/config';
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

// Catppuccin Mocha palette for project color-coding
const PROJECT_PALETTE = [
  '#89b4fa', // blue
  '#cba6f7', // mauve
  '#a6e3a1', // green
  '#fab387', // peach
  '#f38ba8', // pink
  '#74c7ec', // sapphire
  '#f9e2af', // yellow
  '#b4befe', // lavender
];

function hashProjectId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function projectColor(projectId: string): string {
  return PROJECT_PALETTE[hashProjectId(projectId) % PROJECT_PALETTE.length];
}

interface Props {
  sessions: SessionState[];
  projects: ProjectConfig[];
  onSelect: (sessionId: string) => void;
  selectedId: string | null;
  keyboardSelectedId: string | null;
  synced: boolean;
  onArchiveAll: () => void;
  filtersActive?: boolean;
  onClearFilters?: () => void;
  onResumeAll?: () => void;
  onResume?: (sessionId: string) => void;
  onToggleFavorite?: (sessionId: string, favorited: boolean) => void;
  cardPreviewLines?: number;
}

export function SessionGrid({ sessions, projects, onSelect, selectedId, keyboardSelectedId, synced, onArchiveAll, filtersActive, onClearFilters, onResumeAll, onResume, onToggleFavorite, cardPreviewLines }: Props) {
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
  const rateLimitedCount = visibleSessions.filter((s) => s.isRateLimited).length;

  const filtered = activeFilters.size === 0
    ? visibleSessions
    : visibleSessions.filter((s) => activeFilters.has(s.status as Status));

  const sorted = [...filtered].sort((a, b) => {
    const favoritedDiff = (b.favorited ? 1 : 0) - (a.favorited ? 1 : 0);
    if (favoritedDiff !== 0) return favoritedDiff;
    const rank = statusRank(a.status) - statusRank(b.status);
    if (rank !== 0) return rank;
    return (b.started_at ?? 0) - (a.started_at ?? 0);
  });

  const statusesInUse = new Set(visibleSessions.map((s) => s.status as Status));

  // Build a map from project_id → { color, name } for card rendering
  const projectMap = new Map(projects.filter((p) => p.id).map((p) => [p.id, { color: projectColor(p.id), name: p.name }]));
  const multiProject = projects.length > 1;

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
          {rateLimitedCount > 0 && onResumeAll && (
            <button
              className={styles['resume-all-button']}
              onClick={onResumeAll}
            >
              ▶ Resume All ({rateLimitedCount})
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

      {synced && sorted.length === 0 && visibleSessions.length === 0 && !filtersActive && (
        <div className={styles['session-grid-empty']}>
          <p>No sessions yet. Dispatch a task to get started.</p>
        </div>
      )}

      {synced && visibleSessions.length === 0 && filtersActive && (
        <div className={styles['session-grid-empty']}>
          <p>No sessions match your filters.</p>
          {onClearFilters && (
            <button type="button" onClick={onClearFilters}>Clear filters</button>
          )}
        </div>
      )}

      {sorted.length === 0 && visibleSessions.length > 0 && (
        <div className={styles['session-grid-empty']}>
          <p>No sessions match the selected filters.</p>
        </div>
      )}

      {sorted.length > 0 && (
        <div className={styles['session-grid']}>
          {sorted.map((s) => {
            const proj = s.project_id ? projectMap.get(s.project_id) : undefined;
            return (
              <div
                key={s.sessionId}
                className={s.sessionId === keyboardSelectedId ? styles['card-keyboard-selected'] : undefined}
              >
                <SessionCard
                  session={s}
                  selected={s.sessionId === selectedId}
                  onClick={() => onSelect(s.sessionId)}
                  projectColor={proj?.color}
                  projectName={multiProject ? proj?.name : undefined}
                  onResume={onResume ? () => onResume(s.sessionId) : undefined}
                  onToggleFavorite={onToggleFavorite ? () => onToggleFavorite(s.sessionId, !s.favorited) : undefined}
                  previewLines={cardPreviewLines}
                />
              </div>
            );
          })}
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
