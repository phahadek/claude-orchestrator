import type { ResolvedTask } from '../notion/types';

// ── Server → Client ──────────────────────────────────────────────
export interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

export type ServerMessage =
  | { type: 'session_started';       sessionId: string; taskName: string; notionTaskUrl: string; taskType?: string; started_at?: number; ended_at?: number; archived?: boolean }
  | { type: 'session_event';         sessionId: string; eventType: 'text' | 'tool_use' | 'tool_result' | 'system' | 'user_message'; content: string }
  | { type: 'session_status';        sessionId: string; status: 'starting' | 'running' | 'needs_permission' | 'done' | 'error' | 'killed' }
  | { type: 'permission_request';    sessionId: string; toolName: string; proposedAction: string }
  | { type: 'permission_denials';    sessionId: string; denials: PermissionDenial[] }
  | { type: 'session_ended';         sessionId: string; status: string; prUrl?: string }
  | { type: 'tasks_ready';           tasks: ResolvedTask[] }
  | { type: 'error';                 message: string };

// ── Client → Server ──────────────────────────────────────────────
export type ClientMessage =
  | { type: 'dispatch';     tasks: { taskUrl: string; projectContextUrl: string; taskType?: string }[] }
  | { type: 'approve';      sessionId: string }
  | { type: 'deny';         sessionId: string; reason?: string }
  | { type: 'send_message'; sessionId: string; message: string }
  | { type: 'kill';         sessionId: string }
  | { type: 'fetch_tasks';  boardId: string };
