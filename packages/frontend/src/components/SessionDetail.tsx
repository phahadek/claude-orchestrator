import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { SessionState } from '../hooks/useSessionStore';
import type { ClientMessage, PermissionDenial } from '@claude-dashboard/backend/src/ws/types';
import { taskNameFromNotionUrl } from '../utils/notionUrl';
import { calcElapsedMs, formatDuration } from '../utils/sessionTimer';
import {
  tryParseJson,
  extractText,
  extractBashCommand,
  extractToolUse,
  extractToolResult,
  extractSystem,
  isHiddenSystemEvent,
} from '../utils/eventParsing';
import { StatusBadge } from './StatusBadge';
import { formatModelName } from './SessionCard';
import { ToolCallGroup } from './ToolCallGroup';
import type { CallPair } from './ToolCallGroup';
import { ReviewDetailView } from './ReviewDetailView';
import styles from './SessionDetail.module.css';

// ── Event grouping ────────────────────────────────────────────────

type SessionEvent = SessionState['events'][number];

type RenderItem =
  | { kind: 'event'; event: SessionEvent }
  | { kind: 'group'; toolName: string; calls: CallPair[] };

/** Extract the first tool_use block's name from a text event, or null if none. */
function getToolNameFromTextEvent(event: SessionEvent): string | null {
  if (event.eventType !== 'text') return null;
  const payload = tryParseJson(event.content);
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== 'assistant' && p.type !== 'message') return null;
  const msg = p.message as Record<string, unknown> | undefined;
  const blocks = msg ? msg.content : p.content;
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_use' && typeof b.name === 'string') return b.name;
  }
  return null;
}

/**
 * Group consecutive same-tool call pairs in the event list.
 * A "call pair" is a text event containing a tool_use block followed by a tool_result event.
 * When 2+ consecutive pairs share the same tool name they become a single group.
 * Single calls and non-tool events pass through unchanged.
 */
export function groupSessionEvents(events: SessionEvent[]): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;

  while (i < events.length) {
    const toolName = getToolNameFromTextEvent(events[i]);

    if (toolName !== null) {
      const startIdx = i;
      // Skip any standalone tool_use events between text and tool_result
      let j = i + 1;
      while (j < events.length && events[j].eventType === 'tool_use') j++;

      if (j < events.length && events[j].eventType === 'tool_result') {
        const firstEndIdx = j;
        const calls: CallPair[] = [{ textEvent: events[startIdx], resultEvent: events[firstEndIdx] }];
        i = firstEndIdx + 1;

        // Accumulate consecutive same-tool pairs
        while (i < events.length) {
          const nextToolName = getToolNameFromTextEvent(events[i]);
          if (nextToolName !== toolName) break;

          let k = i + 1;
          while (k < events.length && events[k].eventType === 'tool_use') k++;

          if (k < events.length && events[k].eventType === 'tool_result') {
            calls.push({ textEvent: events[i], resultEvent: events[k] });
            i = k + 1;
          } else {
            break;
          }
        }

        if (calls.length >= 2) {
          items.push({ kind: 'group', toolName, calls });
        } else {
          // Single call — emit all events individually (preserves null tool_use events)
          for (let k = startIdx; k <= firstEndIdx; k++) {
            items.push({ kind: 'event', event: events[k] });
          }
        }
      } else {
        items.push({ kind: 'event', event: events[i] });
        i++;
      }
    } else {
      items.push({ kind: 'event', event: events[i] });
      i++;
    }
  }

  return items;
}

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
}

export function SessionDetail({ session, send, onClose, onDelete, onArchive, onUnarchive, onResume, onFavorite, onUnfavorite }: Props) {
  const [draftMessage, setDraftMessage] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isAtBottom, setIsAtBottom] = useState(true);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [editingNote, setEditingNote] = useState(false);
  const [noteValue, setNoteValue] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [showReviewTranscript, setShowReviewTranscript] = useState(false);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [session?.events.length]);

  useEffect(() => {
    setIsAtBottom(true);
    setEditingNote(false);
    setNoteValue(session?.note ?? '');
    setTagInput('');
  }, [session?.sessionId]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    }
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

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

  async function handleCopy() {
    if (!session) return;
    const lines: string[] = [];
    for (const e of session.events) {
      const payload = tryParseJson(e.content);
      let line: string | null = null;
      switch (e.eventType) {
        case 'text': {
          if (typeof payload === 'object' && payload !== null) {
            const p = payload as Record<string, unknown>;
            if (p.type === 'assistant' || p.type === 'message') {
              const msg = p.message as Record<string, unknown> | undefined;
              const blocks = msg ? msg.content : p.content;
              if (Array.isArray(blocks)) {
                const parts: string[] = [];
                for (const block of blocks) {
                  if (typeof block !== 'object' || block === null) continue;
                  const b = block as Record<string, unknown>;
                  if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                    parts.push(b.text);
                  } else if (b.type === 'tool_use') {
                    const toolName = typeof b.name === 'string' ? b.name : 'tool_use';
                    let input: unknown = b.input;
                    if (typeof input === 'string') {
                      try { input = JSON.parse(input); } catch { /* leave as string */ }
                    }
                    const bashCmd = toolName === 'Bash' ? extractBashCommand(input) : null;
                    if (bashCmd != null) parts.push(`🔧 ${toolName}\n$ ${bashCmd}`);
                    else parts.push(`🔧 ${toolName}\n${JSON.stringify(input, null, 2)}`);
                  }
                }
                line = parts.join('\n');
              }
            }
          }
          if (line === null) line = extractText(payload, e.content);
          break;
        }
        case 'tool_use': {
          const parsed = extractToolUse(payload);
          if (!parsed) { line = e.content; break; }
          const bashCmd = parsed.toolName === 'Bash' ? extractBashCommand(parsed.input) : null;
          line = bashCmd != null
            ? `🔧 ${parsed.toolName}\n$ ${bashCmd}`
            : `🔧 ${parsed.toolName}\n${JSON.stringify(parsed.input, null, 2)}`;
          break;
        }
        case 'tool_result':
          line = extractToolResult(payload, e.content);
          break;
        case 'system': {
          if (isHiddenSystemEvent(payload)) break;
          const display = extractSystem(payload, e.content).display;
          if (display.trim()) line = display;
          break;
        }
        case 'error': {
          const p = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null;
          line = p ? String(p.message ?? e.content) : e.content;
          break;
        }
        default:
          line = e.content;
      }
      if (line !== null) lines.push(line);
    }
    const text = lines.join('\n---\n');

    let success = false;
    try {
      await navigator.clipboard.writeText(text);
      success = true;
    } catch {
      // Fallback for cases where the Clipboard API fails (focus/permission issues)
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        success = document.execCommand('copy');
      } finally {
        document.body.removeChild(textarea);
      }
    }

    setCopyState(success ? 'copied' : 'failed');
    setTimeout(() => setCopyState('idle'), 1500);
  }

  function handleGoToEnd() {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
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
              {showReviewTranscript && (
                <>
                  {!isAtBottom && (
                    <button className={styles.goToEndButton} onClick={handleGoToEnd}>
                      Go to End ↓
                    </button>
                  )}
                  <button
                    className={styles.copyButton}
                    onClick={handleCopy}
                    disabled={session.events.length === 0}
                  >
                    {copyState === 'copied' ? '✓ Copied' : copyState === 'failed' ? '✗ Failed' : 'Copy'}
                  </button>
                </>
              )}
            </div>
            {showReviewTranscript && (
              <div className={styles.transcript} ref={transcriptRef}>
                {groupSessionEvents(session.events).map((item, i) => {
                  if (item.kind === 'group') {
                    return (
                      <ToolCallGroup key={`group-${i}`} toolName={item.toolName} calls={item.calls} />
                    );
                  }
                  return (
                    <EventRow
                      key={`${i}-${item.event.timestamp}-${item.event.eventType}`}
                      event={item.event}
                    />
                  );
                })}
                {session.events.length === 0 && (
                  <p className={styles.emptyTranscript}>No events yet.</p>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className={styles.transcriptSection}>
            <div className={styles.transcriptHeader}>
              {!isAtBottom && (
                <button className={styles.goToEndButton} onClick={handleGoToEnd}>
                  Go to End ↓
                </button>
              )}
              <button
                className={styles.copyButton}
                onClick={handleCopy}
                disabled={session.events.length === 0}
              >
                {copyState === 'copied' ? '✓ Copied' : copyState === 'failed' ? '✗ Failed' : 'Copy'}
              </button>
            </div>
            <div className={styles.transcript} ref={transcriptRef}>
              {groupSessionEvents(session.events).map((item, i) => {
                if (item.kind === 'group') {
                  return (
                    <ToolCallGroup key={`group-${i}`} toolName={item.toolName} calls={item.calls} />
                  );
                }
                return (
                  <EventRow
                    key={`${i}-${item.event.timestamp}-${item.event.eventType}`}
                    event={item.event}
                  />
                );
              })}
              {session.events.length === 0 && (
                <p className={styles.emptyTranscript}>No events yet.</p>
              )}
              {(session.permissionDenials ?? []).length > 0 && (
                <PermissionDenialsInline denials={session.permissionDenials!} />
              )}
            </div>
          </div>

          {isActive && (
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

// ── EventRow ──────────────────────────────────────────────────────

interface EventRowProps {
  event: { eventType: string; content: string; timestamp: number };
}

export function EventRow({ event }: EventRowProps) {
  const payload = tryParseJson(event.content);

  switch (event.eventType) {
    case 'text': {
      // Handle structured assistant message payloads — extract text and tool_use blocks
      if (typeof payload === 'object' && payload !== null) {
        const p = payload as Record<string, unknown>;
        if (p.type === 'assistant' || p.type === 'message') {
          const msg = p.message as Record<string, unknown> | undefined;
          const blocks = msg ? msg.content : p.content;
          if (Array.isArray(blocks)) {
            const nodes: React.ReactNode[] = [];
            blocks.forEach((block: unknown, idx: number) => {
              if (typeof block !== 'object' || block === null) return;
              const b = block as Record<string, unknown>;
              if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
                nodes.push(<p key={idx} className={styles.eventText}>{b.text}</p>);
              } else if (b.type === 'tool_use') {
                const toolName = typeof b.name === 'string' ? b.name : 'tool_use';
                let input: unknown = b.input;
                if (typeof input === 'string') {
                  try { input = JSON.parse(input); } catch { /* leave as string */ }
                }
                const isBash = toolName === 'Bash';
                const bashCmd = isBash ? extractBashCommand(input) : null;
                nodes.push(
                  <CollapsibleToolUse key={idx} toolName={toolName}>
                    {isBash && bashCmd != null ? (
                      <pre className={styles.bashCommand}>$ {bashCmd}</pre>
                    ) : (
                      <pre className={styles.toolArgs}>{JSON.stringify(input, null, 2)}</pre>
                    )}
                  </CollapsibleToolUse>
                );
              }
            });
            if (nodes.length === 0) return null;
            return <>{nodes}</>;
          }
        }
      }
      const text = extractText(payload, event.content);
      if (!text.trim()) return null;
      return <p className={styles.eventText}>{text}</p>;
    }

    case 'tool_use': {
      // Standalone tool_use events are redundant — the final assistant message
      // (text event) already contains tool_use blocks rendered inline.
      return null;
    }

    case 'tool_result': {
      const result = extractToolResult(payload, event.content);
      if (!result.trim()) return null;
      return <ToolResultRow result={result} />;
    }

    case 'system': {
      if (isHiddenSystemEvent(payload)) return null;
      const { rawType, display } = extractSystem(payload, event.content);
      if (rawType === 'result') return null;
      // Safety net: system-only user events (CLAUDE.md bootstrap, system reminders)
      // are filtered on the backend before broadcast, but return null here in case
      // any slip through (extractSystem strips tags and returns empty display for them).
      if (!display.trim()) return null;
      if (rawType === 'file-history-snapshot') {
        return <p className={styles.eventSystem}>📄 {display}</p>;
      }
      if (rawType === 'user') {
        return <p className={styles.eventUser}>{display}</p>;
      }
      return <p className={styles.eventSystem}>{display}</p>;
    }

    case 'user_message':
      return (
        <div className={styles.eventUserMessage}>
          <span className={styles.userMessageLabel}>You</span>
          <p>{event.content}</p>
        </div>
      );

    case 'error': {
      const errMsg =
        typeof payload === 'object' && payload !== null
          ? String((payload as Record<string, unknown>).message ?? event.content)
          : event.content;
      return (
        <div className={styles.eventError}>
          <pre>{errMsg}</pre>
        </div>
      );
    }

    default:
      return <p className={styles.eventText}>{event.content}</p>;
  }
}

function CollapsibleToolUse({ toolName, children }: { toolName: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.eventToolUse}>
      <div
        className={styles.toolHeader}
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpen((o) => !o); }}
        aria-expanded={open}
      >
        <span className={styles.toolChevron}>{open ? '▼' : '▶'}</span>
        🔧 {toolName}
      </div>
      <div className={open ? styles.toolBody : styles.toolBodyHidden}>
        {children}
      </div>
    </div>
  );
}

const TOOL_RESULT_COLLAPSE_LINES = 20;

function ToolResultRow({ result }: { result: string }) {
  let display = result;
  try {
    const parsed = JSON.parse(result);
    if (typeof parsed === 'object' && parsed !== null) {
      display = JSON.stringify(parsed, null, 2);
    }
  } catch { /* not JSON, use raw string */ }

  const lines = display.split('\n');
  const shouldCollapse = lines.length > TOOL_RESULT_COLLAPSE_LINES;
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((e) => !e), []);

  const displayed =
    shouldCollapse && !expanded ? lines.slice(0, TOOL_RESULT_COLLAPSE_LINES).join('\n') : display;

  return (
    <div className={styles.eventToolResult}>
      <pre className={`${styles.toolResultContent} ${expanded ? styles.toolResultExpanded : ''}`}>{displayed}</pre>
      {shouldCollapse && (
        <button className={styles.expandButton} onClick={toggle}>
          {expanded ? '▲ Collapse' : `▼ Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

// ── Inline permission denials ──────────────────────────────────────

function getDenialInputSummary(toolName: string, input: unknown): string {
  if (toolName === 'Bash') {
    const cmd = extractBashCommand(input);
    if (cmd) return cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd;
  }
  if (typeof input === 'object' && input !== null) {
    const entries = Object.entries(input as Record<string, unknown>);
    if (entries.length > 0) {
      const [k, v] = entries[0];
      const str = `${k}=${String(v)}`;
      return str.length > 60 ? str.slice(0, 57) + '…' : str;
    }
  }
  const str = String(input);
  return str.length > 60 ? str.slice(0, 57) + '…' : str;
}

function PermissionDenialsInline({ denials }: { denials: PermissionDenial[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.inlineDenials}>
      <button
        className={styles.inlineDenialsHeader}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Toggle permission denials"
      >
        <span className={styles.toolChevron}>{open ? '▼' : '▶'}</span>
        🚫 {denials.length} permission denial{denials.length !== 1 ? 's' : ''}
      </button>
      {open && (
        <div className={styles.inlineDenialsBody}>
          {denials.map((d) => (
            <p key={d.tool_use_id} className={styles.inlineDenialItem}>
              🚫 Denied: {d.tool_name}({getDenialInputSummary(d.tool_name, d.tool_input)})
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Payload extraction helpers ────────────────────────────────────
// (helpers are imported from utils/eventParsing.ts)
