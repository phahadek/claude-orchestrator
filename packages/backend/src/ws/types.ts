import type { NotionTask } from '../notion/types';

// ── Server → Client ──────────────────────────────────────────────
export type ServerMessage =
  | { type: 'session_started';    sessionId: string; taskName: string; notionTaskUrl: string }
  | { type: 'session_event';      sessionId: string; eventType: 'text' | 'tool_use' | 'tool_result' | 'system'; content: string }
  | { type: 'session_status';     sessionId: string; status: 'starting' | 'running' | 'needs_permission' | 'done' | 'error' | 'killed' }
  | { type: 'permission_request'; sessionId: string; toolName: string; proposedAction: string }
  | { type: 'session_ended';      sessionId: string; status: string; prUrl?: string }
  | { type: 'tasks_ready';        tasks: NotionTask[] }
  | { type: 'error';              message: string };

// ── Client → Server ──────────────────────────────────────────────
export type ClientMessage =
  | { type: 'dispatch';     tasks: { taskUrl: string; projectContextUrl: string }[] }
  | { type: 'approve';      sessionId: string }
  | { type: 'deny';         sessionId: string; reason?: string }
  | { type: 'send_message'; sessionId: string; message: string }
  | { type: 'kill';         sessionId: string }
  | { type: 'fetch_tasks';  boardId: string };
