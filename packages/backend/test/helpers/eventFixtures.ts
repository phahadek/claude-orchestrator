import type { EventKind } from '../../src/session/eventKind';

export interface TestEventRow {
  event_type: string;
  payload: string;
}

/**
 * Both storage shapes for a given event kind.
 *
 * live  — full raw event payload (AgentSession: JSON.stringify(rawEvent))
 * jsonl — content/message only  (JsonlReader: JSON.stringify(ev.content ?? ev.message ?? ev))
 *
 * For most kinds the payload.type field differs between shapes, which is why
 * eventKind() must read the event_type column first, then payload.type only
 * for 'system' rows.
 */
export interface EventRowShapes {
  live: TestEventRow;
  jsonl: TestEventRow;
}

/**
 * Return production-shaped fixture rows for both writer shapes for the given
 * EventKind. Use these in tests so eventKind() correctness is verified against
 * realistic data, not synthetic event_type strings.
 */
export function makeEventRow(kind: EventKind): EventRowShapes {
  switch (kind) {
    case 'text':
      return {
        live: {
          event_type: 'text',
          payload: JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Hello' }],
            },
          }),
        },
        jsonl: {
          event_type: 'text',
          payload: JSON.stringify({
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello' }],
          }),
        },
      };

    case 'tool_use':
      return {
        live: {
          event_type: 'tool_use',
          payload: JSON.stringify({
            type: 'tool_use',
            id: 'toolu_01',
            name: 'Write',
            input: { file_path: '/x.ts', content: '' },
          }),
        },
        jsonl: {
          event_type: 'tool_use',
          payload: JSON.stringify({
            id: 'toolu_01',
            name: 'Write',
            input: { file_path: '/x.ts', content: '' },
          }),
        },
      };

    case 'tool_result':
      return {
        live: {
          event_type: 'tool_result',
          payload: JSON.stringify({
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: 'ok',
          }),
        },
        jsonl: {
          event_type: 'tool_result',
          payload: JSON.stringify({ tool_use_id: 'toolu_01', content: 'ok' }),
        },
      };

    case 'error':
      return {
        live: {
          event_type: 'error',
          payload: JSON.stringify({
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded' },
          }),
        },
        // JSONL shape: content only — no outer type field
        jsonl: {
          event_type: 'error',
          payload: JSON.stringify({
            error_type: 'overloaded_error',
            message: 'Overloaded',
          }),
        },
      };

    case 'result':
      // result events have no .content field in JSONL — full object is stored in both shapes
      return {
        live: {
          event_type: 'system',
          payload: JSON.stringify({
            type: 'result',
            subtype: 'success',
            duration_ms: 1000,
          }),
        },
        jsonl: {
          event_type: 'system',
          payload: JSON.stringify({
            type: 'result',
            subtype: 'success',
            duration_ms: 1000,
          }),
        },
      };

    case 'user_message':
      return {
        live: {
          event_type: 'user_message',
          payload: JSON.stringify({
            type: 'user',
            message: { role: 'user', content: 'hello' },
          }),
        },
        jsonl: {
          event_type: 'user_message',
          payload: JSON.stringify({ role: 'user', content: 'hello' }),
        },
      };

    case 'other':
      return {
        live: {
          event_type: 'system',
          payload: JSON.stringify({ type: 'system', subtype: 'init' }),
        },
        jsonl: {
          event_type: 'system',
          payload: JSON.stringify({ type: 'system', subtype: 'init' }),
        },
      };
  }
}
