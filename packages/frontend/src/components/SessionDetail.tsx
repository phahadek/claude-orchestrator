import { useState, useRef, useEffect } from 'react';
import type { SessionState } from '../hooks/useSessionStore';
import type { ClientMessage } from '@claude-dashboard/backend/src/ws/types';
import { StatusBadge } from './StatusBadge';
import styles from './SessionDetail.module.css';

interface Props {
  session: SessionState | null;
  send: (msg: ClientMessage) => void;
  onClose: () => void;
}

export function SessionDetail({ session, send, onClose }: Props) {
  const [draftMessage, setDraftMessage] = useState('');
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [session?.events.length]);

  if (!session) return null;

  const isActive = session.status === 'running' || session.status === 'needs_permission';

  function handleKill() {
    if (!session) return;
    if (confirm('Kill this session? It will have 15 seconds to wrap up.')) {
      send({ type: 'kill', sessionId: session.sessionId });
      onClose();
    }
  }

  function handleSend() {
    if (!session || !draftMessage.trim()) return;
    send({ type: 'send_message', sessionId: session.sessionId, message: draftMessage });
    setDraftMessage('');
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.taskName}>{session.taskName}</span>
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
          <button className={styles.killButton} onClick={handleKill}>
            Kill
          </button>
        )}
        <button className={styles.closeButton} onClick={onClose} aria-label="Close panel">
          ✕
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

      {session.permissionDenials && session.permissionDenials.length > 0 && (
        <div className={styles.permissionRequest}>
          <p className={styles.permissionTitle}>
            <strong>Permission Denials</strong> — add rules in Settings to allow these tools next time
          </p>
          {session.permissionDenials.map((d, i) => (
            <div key={i} className={styles.proposedAction}>
              <strong>{d.tool_name}</strong>
              <pre>{JSON.stringify(d.tool_input, null, 2)}</pre>
            </div>
          ))}
        </div>
      )}

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

const TERMINAL_STATUSES = new Set(['done', 'error', 'killed']);

function ElapsedTime({ session }: { session: SessionState }) {
  const startTs = session.events[0]?.timestamp ?? session.started_at;
  if (startTs == null) return null;

  const isTerminal = TERMINAL_STATUSES.has(session.status);
  const endTs = isTerminal
    ? (session.events.at(-1)?.timestamp ?? session.ended_at ?? Date.now())
    : Date.now();

  const ms = endTs - startTs;
  const label = formatDuration(ms);
  const prefix = session.started_at != null && session.events.length === 0 ? '~' : '';

  return <span className={styles.elapsed}>{prefix}{label}</span>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '< 1s';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

// ── EventRow ──────────────────────────────────────────────────────

interface EventRowProps {
  event: { eventType: string; content: string; timestamp: number };
}

export function EventRow({ event }: EventRowProps) {
  switch (event.eventType) {
    case 'text':
      return <p className={styles.eventText}>{event.content}</p>;

    case 'tool_use': {
      const parsed = tryParseToolUse(event.content);
      return (
        <div className={styles.eventToolUse}>
          <div className={styles.toolHeader}>
            🔧 {parsed?.toolName ?? 'tool_use'}
          </div>
          <pre className={styles.toolArgs}>
            {parsed ? JSON.stringify(parsed.input, null, 2) : event.content}
          </pre>
        </div>
      );
    }

    case 'tool_result':
      return (
        <div className={styles.eventToolResult}>
          <pre className={styles.toolResultContent}>{event.content}</pre>
        </div>
      );

    case 'system':
      return <p className={styles.eventSystem}>{event.content}</p>;

    case 'error':
      return (
        <div className={styles.eventError}>
          <pre>{event.content}</pre>
        </div>
      );

    default:
      return <p className={styles.eventText}>{event.content}</p>;
  }
}

function tryParseToolUse(content: string): { toolName: string; input: unknown } | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'toolName' in parsed &&
      'input' in parsed
    ) {
      return parsed as { toolName: string; input: unknown };
    }
    return null;
  } catch {
    return null;
  }
}
