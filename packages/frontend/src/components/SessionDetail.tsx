import { useState, useRef, useEffect } from 'react';
import type { SessionState } from '../hooks/useSessionStore';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';
import { taskNameFromNotionUrl } from '../utils/notionUrl';
import { calcElapsedMs, formatDuration } from '../utils/sessionTimer';
import { StatusBadge } from './StatusBadge';
import { formatModelName } from './SessionCard';
import { formatTokenCount, formatCost, calculateCost } from '@claude-dashboard/backend/src/utils/usage';
import { ReviewDetailView } from './ReviewDetailView';
import { EventTranscript } from './EventTranscript';
import { DiffViewer } from './DiffViewer';
import styles from './SessionDetail.module.css';

// Re-export EventRow and groupSessionEvents for consumers (e.g. tests) that import
// them from this module.
export { EventRow, groupSessionEvents } from './EventTranscript';

// ── Props & component ─────────────────────────────────────────────

interface Props {
  session: SessionState | null;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
  onDelete: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  onUnarchive: (sessionId: string) => void;
  onResume?: (sessionId: string) => void;
  onFavorite?: (sessionId: string) => void;
  onUnfavorite?: (sessionId: string) => void;
  sessionMode?: string;
}

export function SessionDetail({ session, send, onClose, onDelete, onArchive, onUnarchive, onResume, onFavorite, onUnfavorite, sessionMode }: Props) {
  const [draftMessage, setDraftMessage] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [noteValue, setNoteValue] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [showReviewTranscript, setShowReviewTranscript] = useState(false);
  const [activeTab, setActiveTab] = useState<'transcript' | 'diff'>('transcript');

  useEffect(() => {
    setEditingNote(false);
    setNoteValue(session?.note ?? '');
    setTagInput('');
    setActiveTab('transcript');
  }, [session?.sessionId]);

  if (!session) return null;

  const isActive = session.status === 'running' || session.status === 'needs_permission';

  function handleKill() {
    if (!session) return;
    if (confirm('Kill this session? It will have 15 seconds to wrap up.')) {
      send({ type: 'kill', sessionId: session.sessionId });
      // Don't close — let session_ended WS message update the status badge to 'killed'
    }
  }

  function handleEndSession() {
    if (!session) return;
    if (confirm('End this session? The CLI will finish its current step then exit cleanly.')) {
      send({ type: 'end_session', sessionId: session.sessionId });
    }
  }

  async function handleDelete() {
    if (!session) return;
    if (!confirm('Delete this session? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${session.sessionId}`, { method: 'DELETE' });
      onDelete(session.sessionId);
    } catch {
      setDeleting(false);
    }
  }

  async function handleArchive() {
    if (!session) return;
    setArchiving(true);
    try {
      await fetch(`/api/sessions/${session.sessionId}/archive`, { method: 'PATCH' });
      onArchive(session.sessionId);
    } finally {
      setArchiving(false);
    }
  }

  async function handleUnarchive() {
    if (!session) return;
    setArchiving(true);
    try {
      await fetch(`/api/sessions/${session.sessionId}/unarchive`, { method: 'PATCH' });
      onUnarchive(session.sessionId);
    } finally {
      setArchiving(false);
    }
  }

  async function handleToggleFavorite() {
    if (!session) return;
    if (session.favorited) {
      await fetch(`/api/sessions/${session.sessionId}/unfavorite`, { method: 'PATCH' });
      onUnfavorite?.(session.sessionId);
    } else {
      await fetch(`/api/sessions/${session.sessionId}/favorite`, { method: 'PATCH' });
      onFavorite?.(session.sessionId);
    }
  }

  function handleSend() {
    if (!session || !draftMessage.trim()) return;
    send({ type: 'send_message', sessionId: session.sessionId, message: draftMessage });
    setDraftMessage('');
    if (composerRef.current) {
      composerRef.current.style.height = 'auto';
    }
  }

  async function handleNoteCommit() {
    if (!session) return;
    setEditingNote(false);
    const trimmed = noteValue.trim() || null;
    await fetch(`/api/sessions/${session.sessionId}/note`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: trimmed }),
    });
  }

  async function handleAddTag() {
    if (!session) return;
    const tag = tagInput.trim();
    if (!tag) return;
    const existing = session.tags ?? [];
    if (existing.includes(tag)) { setTagInput(''); return; }
    const tags = [...existing, tag];
    setTagInput('');
    await fetch(`/api/sessions/${session.sessionId}/tags`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    });
  }

  async function handleRemoveTag(tag: string) {
    if (!session) return;
    const tags = (session.tags ?? []).filter((t) => t !== tag);
    await fetch(`/api/sessions/${session.sessionId}/tags`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    });
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.taskName}>{taskNameFromNotionUrl(session.taskName)}</span>
        <div className={styles.headerControls}>
          <StatusBadge status={session.status} isRateLimited={session.isRateLimited} />
          {session.model && (
            <span className={styles.modelBadge}>{formatModelName(session.model)}</span>
          )}
          {(session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0) > 0 && (
            <span className={styles.tokenCount}>
              {sessionMode === 'api'
                ? formatCost(calculateCost(session.totalInputTokens ?? 0, session.totalOutputTokens ?? 0, session.model))
                : `${formatTokenCount((session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0))} tokens (~${formatCost(calculateCost(session.totalInputTokens ?? 0, session.totalOutputTokens ?? 0, session.model))} est.)`}
            </span>
          )}
          <button
            className={`${styles.favoriteButton} ${session.favorited ? styles['favoriteButton--active'] : ''}`}
            onClick={() => void handleToggleFavorite()}
            aria-label={session.favorited ? 'Unfavorite session' : 'Favorite session'}
            title={session.favorited ? 'Unfavorite' : 'Favorite'}
          >
            {session.favorited ? '★' : '☆'}
          </button>
          {session.isRateLimited && onResume && (
            <button className={styles.resumeButton} onClick={() => onResume(session.sessionId)}>
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
              Notion ↗
            </a>
          )}
          <ElapsedTime session={session} />
          {isActive && (
            <button className={styles.endSessionButton} onClick={handleEndSession}>
              End Session
            </button>
          )}
          {isActive && (
            <button className={styles.killButton} onClick={handleKill}>
              Kill
            </button>
          )}
          {!isActive && (
            session.archived ? (
              <button className={styles.archiveButton} onClick={handleUnarchive} disabled={archiving}>
                {archiving ? '…' : 'Unarchive'}
              </button>
            ) : (
              <button className={styles.archiveButton} onClick={handleArchive} disabled={archiving}>
                {archiving ? '…' : 'Archive'}
              </button>
            )
          )}
          {!isActive && (
            <button className={styles.deleteButton} onClick={handleDelete} disabled={deleting}>
              {deleting ? '…' : 'Delete'}
            </button>
          )}
          <button className={styles.closeButton} onClick={onClose} aria-label="Close panel">
            ✕
          </button>
        </div>
      </div>

      <div className={styles.noteTagArea}>
        <div className={styles.noteRow}>
          {editingNote ? (
            <input
              className={styles.noteInput}
              autoFocus
              value={noteValue}
              onChange={(e) => setNoteValue(e.target.value)}
              onBlur={handleNoteCommit}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleNoteCommit(); } if (e.key === 'Escape') { setEditingNote(false); setNoteValue(session.note ?? ''); } }}
              placeholder="Add a note..."
            />
          ) : (
            <button
              className={styles.notePlaceholder}
              onClick={() => { setNoteValue(session.note ?? ''); setEditingNote(true); }}
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
              >×</button>
            </span>
          ))}
          <input
            className={styles.tagInput}
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAddTag(); } }}
            placeholder="Add tag..."
          />
        </div>
      </div>

      {session.sessionType === 'review' ? (
        <>
          <ReviewDetailView session={session} />

          <div className={styles.transcriptSection}>
            <div className={styles.transcriptHeader}>
              <button
                className={styles.copyButton}
                onClick={() => setShowReviewTranscript((v) => !v)}
                aria-expanded={showReviewTranscript}
              >
                {showReviewTranscript ? '▼ Hide transcript' : '▶ Show session transcript'}
              </button>
            </div>
            {showReviewTranscript && (
              <EventTranscript events={session.events} />
            )}
          </div>
        </>
      ) : (
        <>
          {session.prUrl != null && (
            <div className={styles.tabBar}>
              <button
                className={`${styles.tabButton} ${activeTab === 'transcript' ? styles['tabButton--active'] : ''}`}
                onClick={() => setActiveTab('transcript')}
              >
                Transcript
              </button>
              <button
                className={`${styles.tabButton} ${activeTab === 'diff' ? styles['tabButton--active'] : ''}`}
                onClick={() => setActiveTab('diff')}
              >
                Diff
              </button>
            </div>
          )}

          {activeTab === 'transcript' && (
            <EventTranscript
              events={session.events}
              permissionDenials={session.permissionDenials}
            />
          )}

          {activeTab === 'diff' && session.prUrl != null && (() => {
            const match = /\/pull\/(\d+)/.exec(session.prUrl);
            const prNumber = match ? parseInt(match[1], 10) : null;
            return prNumber != null ? (
              <DiffViewer prNumber={prNumber} projectId={session.project_id} />
            ) : (
              <div className={styles.diffError}>Could not parse PR number from URL.</div>
            );
          })()}

          {activeTab === 'transcript' && isActive && (
            <div className={styles.composer}>
              <textarea
                ref={composerRef}
                className={styles.composerInput}
                value={draftMessage}
                rows={1}
                onChange={(e) => {
                  setDraftMessage(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${e.target.scrollHeight}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && draftMessage.trim()) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Send a message to the session…"
              />
              <button
                className={styles.sendButton}
                onClick={handleSend}
                disabled={!draftMessage.trim()}
              >
                Send
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Elapsed time display ──────────────────────────────────────────

function ElapsedTime({ session }: { session: SessionState }) {
  const ms = calcElapsedMs(session);
  if (ms == null) return null;

  const prefix = session.started_at != null && session.events.length === 0 ? '~' : '';
  return <span className={styles.elapsed}>{prefix}{formatDuration(ms)}</span>;
}
