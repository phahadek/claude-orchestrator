import type { SessionEvent } from '../db/types';

export type EventKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'result'
  | 'user_message'
  | 'other';

/**
 * Derive the logical kind of a session event.
 *
 * Handles two storage shapes:
 *   live: payload = JSON.stringify(rawEvent) — includes payload.type from the CLI/SDK
 *   JSONL: payload = JSON.stringify(ev.content ?? ev.message ?? ev)
 *
 * For 'system' rows the event_type column alone is ambiguous; payload.type
 * discriminates between result, error, and other system events.
 */
export function eventKind(
  row: Pick<SessionEvent, 'event_type' | 'payload'>,
): EventKind {
  switch (row.event_type) {
    case 'text':
      return 'text';
    case 'tool_use':
      return 'tool_use';
    case 'tool_result':
      return 'tool_result';
    case 'error':
      return 'error';
    case 'user_message':
      return 'user_message';
    case 'system': {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        return 'other';
      }
      const type = typeof parsed.type === 'string' ? parsed.type : undefined;
      if (type === 'result') return 'result';
      if (type === 'error') return 'error';
      return 'other';
    }
    default:
      return 'other';
  }
}
