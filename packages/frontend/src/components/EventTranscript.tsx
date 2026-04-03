import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { PermissionDenial } from '@claude-dashboard/backend/src/ws/types';
import {
  tryParseJson,
  extractText,
  extractBashCommand,
  extractToolDetail,
  extractToolUse,
  extractToolResult,
  extractSystem,
  isHiddenSystemEvent,
} from '../utils/eventParsing';
import { ToolCallGroup } from './ToolCallGroup';
import type { CallPair } from './ToolCallGroup';
import styles from './EventTranscript.module.css';

// ── Types ─────────────────────────────────────────────────────────

export type SessionEvent = { eventType: string; content: string; timestamp: number; messageId?: string };

type RenderItem =
  | { kind: 'event'; event: SessionEvent }
  | { kind: 'group'; toolName: string; calls: CallPair[] };

// ── Event grouping ─────────────────────────────────────────────────

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
      let j = i + 1;
      while (j < events.length && events[j].eventType === 'tool_use') j++;

      if (j < events.length && events[j].eventType === 'tool_result') {
        const firstEndIdx = j;
        const calls: CallPair[] = [{ textEvent: events[startIdx], resultEvent: events[firstEndIdx] }];
        i = firstEndIdx + 1;

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

// ── EventRow ──────────────────────────────────────────────────────

interface EventRowProps {
  event: { eventType: string; content: string; timestamp: number };
}

export function EventRow({ event }: EventRowProps) {
  const payload = tryParseJson(event.content);

  switch (event.eventType) {
    case 'text': {
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
                const detail = !isBash ? extractToolDetail(toolName, input) : null;
                nodes.push(
                  <CollapsibleToolUse key={idx} toolName={toolName} detail={detail}>
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

// ── CollapsibleToolUse ─────────────────────────────────────────────

function CollapsibleToolUse({ toolName, detail, children }: { toolName: string; detail?: string | null; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const truncatedDetail = detail != null
    ? (detail.length > 60 ? detail.slice(0, 60) + '…' : detail)
    : null;
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
        {truncatedDetail != null && (
          <span className={styles.toolDetail}>({truncatedDetail})</span>
        )}
      </div>
      <div className={open ? styles.toolBody : styles.toolBodyHidden}>
        {children}
      </div>
    </div>
  );
}

// ── ToolResultRow ─────────────────────────────────────────────────

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

// ── PermissionDenialsInline ────────────────────────────────────────

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

// ── EventTranscript ───────────────────────────────────────────────

interface EventTranscriptProps {
  events: SessionEvent[];
  permissionDenials?: PermissionDenial[];
}

export function EventTranscript({ events, permissionDenials }: EventTranscriptProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isAtBottom, setIsAtBottom] = useState(true);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [events.length]);

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

  async function handleCopy() {
    const lines: string[] = [];
    for (const e of events) {
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

  return (
    <div className={styles.transcriptSection}>
      <div className={styles.transcriptHeader}>
        {!isAtBottom && (
          <button className={styles.goToEndButton} onClick={handleGoToEnd}>
            Go to End ↓
          </button>
        )}
        <button
          className={styles.copyButton}
          onClick={() => void handleCopy()}
          disabled={events.length === 0}
        >
          {copyState === 'copied' ? '✓ Copied' : copyState === 'failed' ? '✗ Failed' : 'Copy'}
        </button>
      </div>
      <div className={styles.transcript} ref={transcriptRef}>
        {groupSessionEvents(events).map((item, i) => {
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
        {events.length === 0 && (
          <p className={styles.emptyTranscript}>No events yet.</p>
        )}
        {(permissionDenials ?? []).length > 0 && (
          <PermissionDenialsInline denials={permissionDenials!} />
        )}
      </div>
    </div>
  );
}
