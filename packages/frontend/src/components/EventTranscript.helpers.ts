import { tryParseJson } from '../utils/eventParsing';
import type { CallPair } from './ToolCallGroup';

export type SessionEvent = {
  eventType: string;
  content: string;
  timestamp: number;
  messageId?: string;
};

type RenderItem =
  | { kind: 'event'; event: SessionEvent }
  | { kind: 'group'; toolName: string; calls: CallPair[] };

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
        const calls: CallPair[] = [
          { textEvent: events[startIdx], resultEvent: events[firstEndIdx] },
        ];
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

        items.push({ kind: 'group', toolName, calls });
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
