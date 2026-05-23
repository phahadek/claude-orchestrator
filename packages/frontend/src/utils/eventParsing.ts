// Shared event parsing helpers — used by SessionDetail and SessionCard.

export function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Extract displayable text from a text/assistant event payload. */
export function extractText(payload: unknown, rawContent: string): string {
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
          .filter(
            (b): b is Record<string, unknown> =>
              typeof b === 'object' && b !== null,
          )
          .filter((b) => b.type === 'text')
          .map((b) => String(b.text ?? ''));
        if (texts.length > 0) return texts.join('\n');
        return '';
      }
      if (typeof content === 'string') return content;
    }
    return '';
  }

  if (typeof p.text === 'string') return p.text;
  if (typeof p.content === 'string') return p.content;

  return rawContent;
}

/** Extract the command string from a Bash tool input object. */
export function extractBashCommand(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const cmd = (input as Record<string, unknown>).command;
  return typeof cmd === 'string' ? cmd : null;
}

/** Extract a short contextual detail string for common tools (e.g. filename for Read/Write/Edit). */
export function extractToolDetail(
  toolName: string,
  input: unknown,
): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const inp = input as Record<string, unknown>;
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit': {
      if (typeof inp.file_path !== 'string') return null;
      const parts = inp.file_path.split(/[/\\]/);
      return parts[parts.length - 1] || null;
    }
    case 'Glob':
    case 'Grep':
      return typeof inp.pattern === 'string' ? inp.pattern : null;
    case 'Agent':
      return typeof inp.description === 'string' ? inp.description : null;
    default:
      return null;
  }
}

/** Extract tool name and input from a tool_use event payload. */
export function extractToolUse(
  payload: unknown,
): { toolName: string; input: unknown } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  let rawInput: unknown;
  let toolName: string;

  if (typeof p.name === 'string' && 'input' in p) {
    toolName = p.name;
    rawInput = p.input;
  } else if (typeof p.toolName === 'string') {
    toolName = p.toolName;
    rawInput = p.input;
  } else {
    return null;
  }

  let input = rawInput;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      /* leave as string */
    }
  }

  return { toolName, input };
}

/** Extract displayable content from a tool_result event payload. */
export function extractToolResult(
  payload: unknown,
  rawContent: string,
): string {
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
    return result.replace(/\\n/g, '\n');
  }

  return rawContent;
}

export const SYSTEM_SUBTYPE_LABELS: Record<string, string> = {
  thinking: 'Thinking…',
  success: 'Session complete',
  error_during_execution: 'Execution error',
};

/** System event subtypes that are not meaningful to users and should be hidden from the UI. */
const HIDDEN_SYSTEM_SUBTYPES = new Set(['init', 'rate_limit', 'rate_limited']);

/** System event raw payload types that should be hidden from the UI. */
const HIDDEN_SYSTEM_RAW_TYPES = new Set(['rate_limit_event']);

/**
 * Returns true if a system event should be filtered out of the transcript and card preview.
 * Events are still stored in SQLite; this is purely a display-layer filter.
 */
export function isHiddenSystemEvent(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  const rawType = typeof p.type === 'string' ? p.type : '';
  if (HIDDEN_SYSTEM_RAW_TYPES.has(rawType)) return true;
  if (typeof p.subtype === 'string' && HIDDEN_SYSTEM_SUBTYPES.has(p.subtype))
    return true;
  return false;
}

/** Extract displayable content from a system/user/file-history-snapshot event payload. */
export function extractSystem(
  payload: unknown,
  rawContent: string,
): { rawType: string; display: string } {
  if (typeof payload !== 'object' || payload === null) {
    return {
      rawType: 'system',
      display: typeof payload === 'string' ? payload : rawContent,
    };
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
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          // Strip entire tag+content blocks (e.g. <system-reminder>...</system-reminder>),
          // then strip any remaining standalone tags, to remove system-injected content.
          const stripped = b.text
            .replace(
              /<([a-zA-Z][a-zA-Z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g,
              '',
            )
            .replace(/<[^>]+>/g, '')
            .trim();
          if (stripped) parts.push(stripped);
        }
      }
      return { rawType, display: parts.join('\n') };
    }
    return { rawType, display: '' };
  }

  if (rawType === 'result') {
    const subtype = typeof p.subtype === 'string' ? p.subtype : '';
    const label = SYSTEM_SUBTYPE_LABELS[subtype] ?? '';
    return { rawType, display: label };
  }

  if (typeof p.subtype === 'string') {
    const label = SYSTEM_SUBTYPE_LABELS[p.subtype] ?? '';
    return { rawType, display: label };
  }

  if (typeof p.content === 'string') return { rawType, display: p.content };

  return { rawType, display: '' };
}

/** Produce a human-readable one-line summary of an event for use in SessionCard preview. */
export function summarizeEvent(
  event: { eventType: string; content: string },
  maxLen = 120,
): string {
  const payload = tryParseJson(event.content);

  switch (event.eventType) {
    case 'text': {
      // Handle structured assistant message with tool_use blocks
      if (typeof payload === 'object' && payload !== null) {
        const p = payload as Record<string, unknown>;
        if (p.type === 'assistant' || p.type === 'message') {
          const msg = p.message as Record<string, unknown> | undefined;
          const blocks = msg ? msg.content : p.content;
          if (Array.isArray(blocks)) {
            // Prefer first text block
            for (const block of blocks) {
              if (typeof block !== 'object' || block === null) continue;
              const b = block as Record<string, unknown>;
              if (
                b.type === 'text' &&
                typeof b.text === 'string' &&
                b.text.trim()
              ) {
                return truncateStr(b.text.trim(), maxLen);
              }
            }
            // Fall back to first tool_use block
            for (const block of blocks) {
              if (typeof block !== 'object' || block === null) continue;
              const b = block as Record<string, unknown>;
              if (b.type === 'tool_use') {
                const toolName =
                  typeof b.name === 'string' ? b.name : 'tool_use';
                let input: unknown = b.input;
                if (typeof input === 'string') {
                  try {
                    input = JSON.parse(input);
                  } catch {
                    /* leave */
                  }
                }
                if (toolName === 'Bash') {
                  const bashCmd = extractBashCommand(input);
                  return bashCmd != null
                    ? `🔧 ${toolName} $ ${bashCmd}`
                    : `🔧 ${toolName}`;
                }
                const detail = extractToolDetail(toolName, input);
                if (detail != null) {
                  const truncated =
                    detail.length > 40 ? detail.slice(0, 40) + '…' : detail;
                  return `🔧 ${toolName} (${truncated})`;
                }
                return `🔧 ${toolName}`;
              }
            }
          }
        }
      }
      const text = extractText(payload, event.content);
      return truncateStr(text || event.content, maxLen);
    }

    case 'tool_use': {
      const parsed = extractToolUse(payload);
      if (!parsed) return truncateStr(event.content, maxLen);
      if (parsed.toolName === 'Bash') {
        const bashCmd = extractBashCommand(parsed.input);
        return bashCmd != null
          ? `🔧 ${parsed.toolName} $ ${bashCmd}`
          : `🔧 ${parsed.toolName}`;
      }
      const detail = extractToolDetail(parsed.toolName, parsed.input);
      if (detail != null) {
        const truncated =
          detail.length > 40 ? detail.slice(0, 40) + '…' : detail;
        return `🔧 ${parsed.toolName} (${truncated})`;
      }
      return `🔧 ${parsed.toolName}`;
    }

    case 'tool_result': {
      const result = extractToolResult(payload, event.content);
      return truncateStr(result, maxLen);
    }

    case 'system': {
      if (isHiddenSystemEvent(payload)) return '';
      const { display } = extractSystem(payload, event.content);
      return display;
    }

    case 'user_message':
      return truncateStr(event.content, maxLen);

    case 'error': {
      const p =
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>)
          : null;
      return truncateStr(
        p ? String(p.message ?? event.content) : event.content,
        maxLen,
      );
    }

    default:
      return truncateStr(event.content, maxLen);
  }
}

function truncateStr(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}
