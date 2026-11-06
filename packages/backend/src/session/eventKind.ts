import type { SessionEvent } from '../db/types';

export type EventKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'result'
  | 'user_message'
  | 'other';

/** True if `content` is a message content-block array containing a block of `blockType`. */
function hasContentBlock(content: unknown, blockType: string): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>).type === blockType,
  );
}

/**
 * Derive the logical kind of a session event.
 *
 * Handles two storage shapes:
 *   live: payload = JSON.stringify(rawEvent) — includes payload.type from the CLI/SDK
 *   JSONL: payload = JSON.stringify(ev.content ?? ev.message ?? ev)
 *
 * The DB's event_type column only ever stores 'text' | 'system' |
 * 'user_message' | 'rate_limit' (see EventType in db/types.ts) — 'system' is
 * ambiguous, so payload.type discriminates. A standalone (flat) CLI
 * 'tool_use'/'tool_result' event maps to event_type='system' via
 * toEventType's default branch, with payload.type carrying 'tool_use' /
 * 'tool_result' directly. The CLI also reports some tool results nested
 * inside a raw 'user'-role message instead of a flat 'tool_result' event —
 * payload.type 'user' with a tool_result content block — classified as
 * 'tool_result' too so a fallback scan or heartbeat check can't be fooled by
 * which shape a given CLI version happens to use.
 */
export function eventKind(
  row: Pick<SessionEvent, 'event_type' | 'payload'>,
): EventKind {
  switch (row.event_type) {
    case 'text':
      return 'text';
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
      if (type === 'tool_use') return 'tool_use';
      if (type === 'tool_result') return 'tool_result';
      if (type === 'user') {
        const message = parsed.message as Record<string, unknown> | undefined;
        const content = message?.content ?? parsed.content;
        if (hasContentBlock(content, 'tool_result')) return 'tool_result';
      }
      return 'other';
    }
    default:
      return 'other';
  }
}

/**
 * A usage-limit termination surfaces as a terminating 'result' event (the
 * CLI exits 0), not an 'error' event — eventKind's result/error split masks
 * it, since result payloads carrying api_error_status: 429 never reach the
 * 'error' branch above. Callers that need to distinguish a clean turn
 * completion from a limit-driven death must check this in addition to
 * eventKind.
 */
export function isUsageLimitResult(
  row: Pick<SessionEvent, 'event_type' | 'payload'>,
): boolean {
  if (eventKind(row) !== 'result') return false;
  try {
    const parsed = JSON.parse(row.payload) as Record<string, unknown>;
    return parsed.api_error_status === 429;
  } catch {
    return false;
  }
}
