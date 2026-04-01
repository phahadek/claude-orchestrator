import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { SessionState } from '../hooks/useSessionStore';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';
import { taskNameFromNotionUrl } from '../utils/notionUrl';
import { calcElapsedMs, formatDuration } from '../utils/sessionTimer';
import { StatusBadge } from './StatusBadge';
import styles from './SessionDetail.module.css';

interface Props {
  session: SessionState | null;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
  onDelete: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  onUnarchive: (sessionId: string) => void;
}

export function SessionDetail({ session, send, onClose, onDelete, onArchive, onUnarchive }: Props) {
  const [draftMessage, setDraftMessage] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [dismissedDenials, setDismissedDenials] = useState<Set<string>>(new Set());
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isAtBottom, setIsAtBottom] = useState(true);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [editingNote, setEditingNote] = useState(false);
  const [noteValue, setNoteValue] = useState('');
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    const el = transcriptRef.current;
    if (el && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [session?.events.length]);

  useEffect(() => {
    setDismissedDenials(new Set());
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

  function handleSend() {
    if (!session || !draftMessage.trim()) return;
    send({ type: 'send_message', sessionId: session.sessionId, message: draftMessage });
    setDraftMessage('');
  }

  async function handleCopy() {
    if (!session) return;
    const text = session.events.map((e) => {
      const payload = tryParseJson(e.content);
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
                return parts.join('\n');
              }
            }
          }
          return extractText(payload, e.content);
        }
        case 'tool_use': {
          const parsed = extractToolUse(payload);
          if (!parsed) return e.content;
          const bashCmd = parsed.toolName === 'Bash' ? extractBashCommand(parsed.input) : null;
          if (bashCmd != null) return `🔧 ${parsed.toolName}\n$ ${bashCmd}`;
          return `🔧 ${parsed.toolName}\n${JSON.stringify(parsed.input, null, 2)}`;
        }
        case 'tool_result': return extractToolResult(payload, e.content);
        case 'system': return extractSystem(payload, e.content).display;
        case 'error': {
          const p = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null;
          return p ? String(p.message ?? e.content) : e.content;
        }
        default: return e.content;
      }
    }).join('\n---\n');

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
          <StatusBadge status={session.status} />
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
          {session.events.map((e, i) => (
            <EventRow key={`${i}-${e.timestamp}-${e.eventType}`} event={e} />
          ))}
          {session.events.length === 0 && (
            <p className={styles.emptyTranscript}>No events yet.</p>
          )}
        </div>
      </div>

      {(() => {
        const allDenials = session.permissionDenials ?? [];
        const visibleDenials = allDenials.filter((d) => !dismissedDenials.has(d.tool_use_id));
        if (visibleDenials.length === 0) return null;
        return (
          <div className={styles.permissionRequest}>
            <div className={styles.permissionTitleRow}>
              <p className={styles.permissionTitle}>
                <strong>Permission Denials</strong> — add rules in Settings to allow these tools next time
              </p>
              {visibleDenials.length >= 2 && (
                <button
                  className={styles.clearAllBtn}
                  onClick={() => setDismissedDenials(new Set(allDenials.map((d) => d.tool_use_id)))}
                >
                  Clear all
                </button>
              )}
            </div>
            {visibleDenials.map((d) => (
              <div key={d.tool_use_id} className={styles.proposedAction}>
                <button
                  className={styles.denialCloseBtn}
                  onClick={() => setDismissedDenials((prev) => new Set([...prev, d.tool_use_id]))}
                  aria-label="Dismiss"
                >
                  ✕
                </button>
                <strong>{d.tool_name}</strong>
                <pre>{JSON.stringify(d.tool_input, null, 2)}</pre>
              </div>
            ))}
          </div>
        );
      })()}

      {isActive && (
        <div className={styles.composer}>
          <input
            className={styles.composerInput}
            value={draftMessage}
            onChange={(e) => setDraftMessage(e.target.value)}
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
                  <div key={idx} className={styles.eventToolUse}>
                    <div className={styles.toolHeader}>🔧 {toolName}</div>
                    {isBash && bashCmd != null ? (
                      <pre className={styles.bashCommand}>$ {bashCmd}</pre>
                    ) : (
                      <pre className={styles.toolArgs}>{JSON.stringify(input, null, 2)}</pre>
                    )}
                  </div>
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
      const parsed = extractToolUse(payload);
      const isBash = parsed?.toolName === 'Bash';
      const bashCmd = isBash ? extractBashCommand(parsed?.input) : null;
      return (
        <div className={styles.eventToolUse}>
          <div className={styles.toolHeader}>
            🔧 {parsed?.toolName ?? 'tool_use'}
          </div>
          {isBash && bashCmd != null ? (
            <pre className={styles.bashCommand}>$ {bashCmd}</pre>
          ) : (
            <pre className={styles.toolArgs}>
              {parsed ? JSON.stringify(parsed.input, null, 2) : event.content}
            </pre>
          )}
        </div>
      );
    }

    case 'tool_result': {
      const result = extractToolResult(payload, event.content);
      return <ToolResultRow result={result} />;
    }

    case 'system': {
      const { rawType, display } = extractSystem(payload, event.content);
      if (rawType === 'result') return null;
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
      <pre className={styles.toolResultContent}>{displayed}</pre>
      {shouldCollapse && (
        <button className={styles.expandButton} onClick={toggle}>
          {expanded ? '▲ Collapse' : `▼ Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

// ── Payload extraction helpers ────────────────────────────────────

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Extract displayable text from a text/assistant event payload. */
function extractText(payload: unknown, rawContent: string): string {
  if (typeof payload === 'string') return payload;
  if (payload === null || typeof payload !== 'object') return rawContent;

  const p = payload as Record<string, unknown>;

  // Full assistant event: {type:'assistant', message:{content:[{type:'text',text:'...'}]}}
  if (p.type === 'assistant' || p.type === 'message') {
    const msg = p.message as Record<string, unknown> | undefined;
    if (msg) {
      const content = msg.content;
      if (Array.isArray(content)) {
        const texts = content
          .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
          .filter((b) => b.type === 'text')
          .map((b) => String(b.text ?? ''));
        if (texts.length > 0) return texts.join('\n');
        // No text blocks — content (e.g. tool_use blocks) handled by EventRow directly
        return '';
      }
      if (typeof content === 'string') return content;
    }
    return ''; // assistant/message type but no extractable text
  }

  if (typeof p.text === 'string') return p.text;
  if (typeof p.content === 'string') return p.content;

  return rawContent;
}

/** Extract the command string from a Bash tool input object. */
function extractBashCommand(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const cmd = (input as Record<string, unknown>).command;
  return typeof cmd === 'string' ? cmd : null;
}

/** Extract tool name and input from a tool_use event payload. */
function extractToolUse(payload: unknown): { toolName: string; input: unknown } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  let rawInput: unknown;
  let toolName: string;

  // Claude CLI format: {type:'tool_use', name:'...', input:{...}}
  if (typeof p.name === 'string' && 'input' in p) {
    toolName = p.name;
    rawInput = p.input;
  } else if (typeof p.toolName === 'string') {
    // Legacy format: {toolName:'...', input:{...}}
    toolName = p.toolName;
    rawInput = p.input;
  } else {
    return null;
  }

  // If input arrived as a JSON-encoded string, parse it into an object so
  // JSON.stringify can produce indented output instead of a single escaped line.
  let input = rawInput;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { /* leave as string */ }
  }

  return { toolName, input };
}

/** Extract displayable content from a tool_result event payload. */
function extractToolResult(payload: unknown, rawContent: string): string {
  if (typeof payload === 'string') return payload.replace(/\\n/g, '\n');
  if (payload === null || typeof payload !== 'object') return rawContent;

  const p = payload as Record<string, unknown>;

  let result: string | null = null;
  if (typeof p.content === 'string') {
    result = p.content;
  } else if (Array.isArray(p.content)) {
    result = p.content
      .map((b): string => {
        if (typeof b === 'object' && b !== null) {
          const block = b as Record<string, unknown>;
          return String(block.text ?? block.content ?? JSON.stringify(b));
        }
        return String(b);
      })
      .join('\n');
  }

  if (result !== null) {
    // Unescape literal \n sequences that the CLI encodes as \\n
    return result.replace(/\\n/g, '\n');
  }

  return rawContent;
}

const SYSTEM_SUBTYPE_LABELS: Record<string, string> = {
  init: '[init]',
  rate_limit: '[rate limit]',
  rate_limited: '[rate limit]',
  thinking: '[thinking]',
  success: '[done]',
  error_during_execution: '[execution error]',
};

/** Extract displayable content from a system/user/file-history-snapshot event payload. */
function extractSystem(
  payload: unknown,
  rawContent: string,
): { rawType: string; display: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { rawType: 'system', display: typeof payload === 'string' ? payload : rawContent };
  }

  const p = payload as Record<string, unknown>;
  const rawType = typeof p.type === 'string' ? p.type : 'system';

  if (rawType === 'file-history-snapshot') {
    return { rawType, display: 'File history snapshot' };
  }

  if (rawType === 'user') {
    const msg = p.message as Record<string, unknown> | undefined;
    const content = msg?.content ?? p.content;
    if (typeof content === 'string') {
      const stripped = content.replace(/<[^>]+>/g, '').trim();
      return { rawType, display: stripped };
    }
  }

  if (rawType === 'result') {
    const subtype = typeof p.subtype === 'string' ? p.subtype : '';
    const label = SYSTEM_SUBTYPE_LABELS[subtype] ?? `[result: ${subtype || 'unknown'}]`;
    return { rawType, display: label };
  }

  if (typeof p.subtype === 'string') {
    const label = SYSTEM_SUBTYPE_LABELS[p.subtype] ?? `[system: ${p.subtype}]`;
    return { rawType, display: label };
  }

  if (typeof p.content === 'string') return { rawType, display: p.content };

  // Avoid dumping raw JSON — show a generic label instead
  return { rawType, display: `[${rawType}]` };
}
