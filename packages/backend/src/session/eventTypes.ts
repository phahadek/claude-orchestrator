import type { EventType } from '../db/types';

/**
 * All event type strings emitted by the Claude CLI that we recognise.
 * Shared between JsonlReader (historical import) and AgentSession (live sessions)
 * so both consumers validate against the same set.
 */
export const VALID_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'tool_use',
  'tool_result',
  'system',
  'error',
  // Real Claude CLI event types
  'user',
  'assistant',
  'message',
  'file-history-snapshot',
  'result',
  // Claude CLI 2.1.120+ types
  'ai-title',
  'queue-operation',
  'last-prompt',
  'attachment',
  // Claude CLI rate limit events
  'rate_limit_event',
]);

/**
 * Event types that are known but should not be stored as session events.
 * ai-title is excluded here — it is handled separately for metadata persistence.
 */
export const SILENT_SKIP_TYPES: ReadonlySet<string> = new Set([
  'queue-operation',
  'last-prompt',
  'attachment',
  'rate_limit_event',
]);

/** Map raw Claude CLI event type strings to our internal EventType union. */
export function toEventType(raw: string): EventType {
  switch (raw) {
    case 'assistant':
    case 'text':
    case 'message':
      return 'text';
    case 'tool_use':
      return 'tool_use';
    case 'tool_result':
      return 'tool_result';
    case 'system':
    case 'user':
    case 'file-history-snapshot':
      return 'system';
    case 'error':
      return 'error';
    default:
      return 'system';
  }
}
