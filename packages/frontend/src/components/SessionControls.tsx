import { useState, useEffect } from 'react';
import type { SessionState } from '../hooks/useSessionStore';
import type { ClientMessage } from '@claude-orchestrator/backend/src/ws/types';
import type { ProjectConfig } from '@claude-orchestrator/backend/src/config';
import { getTaskSourceLinkLabel } from '../utils/taskSourceLabel';
import { calcElapsedMs, formatDuration } from '../utils/sessionTimer';
import { StatusBadge } from './StatusBadge';
import { formatModelName } from './SessionCard';
import {
  formatTokenCount,
  formatCost,
  calculateCost,
} from '@claude-orchestrator/backend/src/utils/usage';
import { ContextBadge } from './ContextBadge';
import styles from './SessionControls.module.css';

interface Props {
  session: SessionState;
  send: (msg: ClientMessage) => void;
  sessionMode?: string;
  project?: ProjectConfig | null;
  setSessionArchived: (sessionId: string, archived: boolean) => void;
  setSessionFavorited: (sessionId: string, favorited: boolean) => void;
  onDeleted?: (sessionId: string) => void;
  onResume?: (sessionId: string) => void;
  onClose?: () => void;
  embedded?: boolean;
}

export function SessionControls({
  session,
  send,
  sessionMode,
  project = null,
  setSessionArchived,
  setSessionFavorited,
  onDeleted,
  onResume,
  onClose,
  embedded = false,
}: Props) {
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [noteValue, setNoteValue] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [compactOpen, setCompactOpen] = useState(false);

  useEffect(() => {
    setEditingNote(false);
    setNoteValue(session?.note ?? '');
    setTagInput('');
    setCompactOpen(false);
    // Reset local state only on session switch — intentionally excludes session?.note
    // to avoid resetting the input while the user is editing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId]);

  const isActive =
    session.status === 'running' || session.status === 'needs_permission';

  function handleKill() {
    if (confirm('Kill this session? It will have 15 seconds to wrap up.')) {
      send({ type: 'kill', sessionId: session.sessionId });
    }
  }

  function handleEndSession() {
    if (
      confirm(
        'End this session? The CLI will finish its current step then exit cleanly.',
      )
    ) {
      send({ type: 'end_session', sessionId: session.sessionId });
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this session? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${session.sessionId}`, { method: 'DELETE' });
      onDeleted?.(session.sessionId);
    } catch {
      setDeleting(false);
    }
  }

  async function handleArchive() {
    setArchiving(true);
    try {
      await fetch(`/api/sessions/${session.sessionId}/archive`, {
        method: 'PATCH',
      });
      setSessionArchived(session.sessionId, true);
    } finally {
      setArchiving(false);
    }
  }

  async function handleUnarchive() {
    setArchiving(true);
    try {
      await fetch(`/api/sessions/${session.sessionId}/unarchive`, {
        method: 'PATCH',
      });
      setSessionArchived(session.sessionId, false);
    } finally {
      setArchiving(false);
    }
  }

  async function handleToggleFavorite() {
    if (session.favorited) {
      await fetch(`/api/sessions/${session.sessionId}/unfavorite`, {
        method: 'PATCH',
      });
      setSessionFavorited(session.sessionId, false);
    } else {
      await fetch(`/api/sessions/${session.sessionId}/favorite`, {
        method: 'PATCH',
      });
      setSessionFavorited(session.sessionId, true);
    }
  }

  async function handleNoteCommit() {
    setEditingNote(false);
    const trimmed = noteValue.trim() || null;
    await fetch(`/api/sessions/${session.sessionId}/note`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: trimmed }),
    });
  }

  async function handleAddTag() {
    const tag = tagInput.trim();
    if (!tag) return;
    const existing = session.tags ?? [];
    if (existing.includes(tag)) {
      setTagInput('');
      return;
    }
    const tags = [...existing, tag];
    setTagInput('');
    await fetch(`/api/sessions/${session.sessionId}/tags`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    });
  }

  async function handleRemoveTag(tag: string) {
    const tags = (session.tags ?? []).filter((t) => t !== tag);
    await fetch(`/api/sessions/${session.sessionId}/tags`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    });
  }

  const adminChromeClass = `${styles.adminChrome} ${compactOpen ? styles['adminChrome--open'] : ''}`;
  const headerControlsClass = `${styles.headerControls}${embedded ? ` ${styles['headerControls--embedded']}` : ''}`;

  return (
    <>
      <div className={headerControlsClass}>
        <StatusBadge
          status={session.status}
          isRateLimited={session.isRateLimited}
        />
        {session.model && (
          <span className={styles.modelBadge}>
            {formatModelName(session.model)}
          </span>
        )}
        <ContextBadge
          contextOccupancyTokens={session.context_occupancy_tokens}
          compactionCount={session.compaction_count}
          model={session.model}
        />

        {/* Admin chrome group A: cost + favorite — CSS-hidden on mobile until disclosure opens */}
        <div className={adminChromeClass}>
          {(session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0) >
            0 && (
            <span className={styles.tokenCount}>
              {sessionMode === 'api'
                ? formatCost(
                    calculateCost(
                      session.totalInputTokens ?? 0,
                      session.totalOutputTokens ?? 0,
                      session.model,
                    ),
                  )
                : `${formatTokenCount((session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0))} tokens (~${formatCost(calculateCost(session.totalInputTokens ?? 0, session.totalOutputTokens ?? 0, session.model))} est.)`}
            </span>
          )}
          <button
            className={`${styles.favoriteButton} ${session.favorited ? styles['favoriteButton--active'] : ''}`}
            onClick={() => void handleToggleFavorite()}
            aria-label={
              session.favorited ? 'Unfavorite session' : 'Favorite session'
            }
            title={session.favorited ? 'Unfavorite' : 'Favorite'}
          >
            {session.favorited ? '★' : '☆'}
          </button>
        </div>

        {session.isRateLimited && onResume && (
          <button
            className={styles.resumeButton}
            onClick={() => onResume(session.sessionId)}
          >
            Resume
          </button>
        )}
        {session.notionTaskUrl && (
          <a
            href={session.notionTaskUrl}
            target="_blank"
            rel="noreferrer"
            className={styles.notionLink}
          >
            {getTaskSourceLinkLabel(project?.taskSource ?? 'notion')}
          </a>
        )}

        {/* Admin chrome group B: elapsed time — CSS-hidden on mobile until disclosure opens */}
        <div className={adminChromeClass}>
          <ElapsedTime session={session} />
        </div>

        {isActive && (
          <button
            className={styles.endSessionButton}
            onClick={handleEndSession}
          >
            End Session
          </button>
        )}
        {isActive && (
          <button className={styles.killButton} onClick={handleKill}>
            Kill
          </button>
        )}

        {/* Admin chrome group C: archive + delete (inactive sessions) — CSS-hidden on mobile */}
        {!isActive && (
          <div className={adminChromeClass}>
            {session.archived ? (
              <button
                className={styles.archiveButton}
                onClick={() => void handleUnarchive()}
                disabled={archiving}
              >
                {archiving ? '…' : 'Unarchive'}
              </button>
            ) : (
              <button
                className={styles.archiveButton}
                onClick={() => void handleArchive()}
                disabled={archiving}
              >
                {archiving ? '…' : 'Archive'}
              </button>
            )}
            <button
              className={styles.deleteButton}
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              {deleting ? '…' : 'Delete'}
            </button>
          </div>
        )}

        {/* Compact disclosure toggle — CSS shows only on narrow viewports (≤768px) */}
        <button
          className={styles.disclosureToggle}
          aria-expanded={compactOpen}
          aria-label={
            compactOpen ? 'Hide session details' : 'Show session details'
          }
          onClick={() => setCompactOpen((o) => !o)}
        >
          {compactOpen ? '− details' : '⋯ details'}
        </button>

        {onClose && (
          <button
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close panel"
          >
            ✕
          </button>
        )}
      </div>

      <div
        className={`${styles.noteTagArea} ${compactOpen ? styles['noteTagArea--open'] : ''}`}
      >
        <div className={styles.noteRow}>
          {editingNote ? (
            <input
              className={styles.noteInput}
              autoFocus
              value={noteValue}
              onChange={(e) => setNoteValue(e.target.value)}
              onBlur={() => void handleNoteCommit()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleNoteCommit();
                }
                if (e.key === 'Escape') {
                  setEditingNote(false);
                  setNoteValue(session.note ?? '');
                }
              }}
              placeholder="Add a note..."
            />
          ) : (
            <button
              className={styles.notePlaceholder}
              onClick={() => {
                setNoteValue(session.note ?? '');
                setEditingNote(true);
              }}
            >
              {session.note ? session.note : '+ Add a note...'}
            </button>
          )}
        </div>

        <div className={styles.tagRow}>
          {(session.tags ?? []).map((tag) => (
            <span key={tag} className={styles.tagPill}>
              {tag}
              <button
                className={styles.tagRemove}
                onClick={() => void handleRemoveTag(tag)}
                aria-label={`Remove tag ${tag}`}
              >
                ×
              </button>
            </span>
          ))}
          <input
            className={styles.tagInput}
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleAddTag();
              }
            }}
            placeholder="Add tag..."
          />
        </div>
      </div>
    </>
  );
}

function ElapsedTime({ session }: { session: SessionState }) {
  const ms = calcElapsedMs(session);
  if (ms == null) return null;

  const prefix =
    session.started_at != null && session.events.length === 0 ? '~' : '';
  return (
    <span className={styles.elapsed}>
      {prefix}
      {formatDuration(ms)}
    </span>
  );
}
