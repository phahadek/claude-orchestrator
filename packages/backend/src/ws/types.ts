import type { ResolvedTask } from '../notion/types';
import type { DisplayStatus } from '../tasks/TaskStatusEngine';

// ── Server → Client ──────────────────────────────────────────────
export interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

/** Full live-state snapshot of a task, sent in task_updated WS messages. */
export interface TaskView {
  taskId: string;
  taskName: string;
  notionStatus: string;
  displayStatus: DisplayStatus;
  priority: string;
  notionUrl: string;
  taskType: string;
  blocked: boolean;
  blockerNames: string[];
  wave: number;
  codeSession: {
    sessionId: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    lastMessage: string;
    inputTokens: number;
    outputTokens: number;
  } | null;
  pr: {
    prNumber: number;
    prUrl: string;
    title: string;
    headBranch: string;
    baseBranch: string;
    state: string;
    draft: boolean;
  } | null;
  review: {
    sessionId: string;
    status: string;
    verdict: string | null;
    summary: string | null;
    iterationCount: number;
  } | null;
}

export type ServerMessage =
  | { type: 'session_started';       sessionId: string; taskName: string; notionTaskUrl: string; taskType?: string; sessionType?: string; prNumber?: number; codeSessionId?: string; started_at?: number; ended_at?: number; archived?: boolean; favorited?: boolean; project_id?: string | null; note?: string | null; tags?: string[]; totalInputTokens?: number; totalOutputTokens?: number; model?: string | null; prUrl?: string }
  | { type: 'session_event';         sessionId: string; eventType: 'text' | 'tool_use' | 'tool_result' | 'system' | 'user_message'; content: string; messageId?: string }
  | { type: 'session_status';        sessionId: string; status: 'starting' | 'running' | 'needs_permission' | 'done' | 'error' | 'killed' }
  | { type: 'permission_request';    sessionId: string; toolName: string; proposedAction: string }
  | { type: 'permission_denials';    sessionId: string; denials: PermissionDenial[] }
  | { type: 'session_ended';         sessionId: string; status: string; prUrl?: string }
  | { type: 'pr_created';            sessionId: string; prUrl: string }
  | { type: 'session_updated';       sessionId: string; note?: string | null; tags?: string[]; totalInputTokens?: number; totalOutputTokens?: number; model?: string }
  | { type: 'tasks_ready';           tasks: ResolvedTask[] }
  | { type: 'pr_review_complete';    prNumber: number; repo: string; verdict: string; summary: string; draft?: boolean }
  | { type: 'push_detected';         sessionId: string; prNumber: number; repo: string }
  | { type: 'review_verdict';        prNumber: number; repo: string; verdict: string; summary: string; iteration: number }
  | { type: 'pr_merged';             prNumber: number; repo: string; sha: string }
  | { type: 'pr_closed';             prNumber: number; repo: string }
  | { type: 'review_escalated';      prNumber: number; repo: string; message: string }
  | { type: 'review_incomplete';     prNumber: number; repo: string; message: string }
  | { type: 'session_audit';         sessionId: string; prOpened: boolean; prTargetsBranch: string | null; violations: string[]; specMismatch: string | null; auditedAt: string }
  | { type: 'task_status_changed';   notionTaskId: string; newStatus: string }
  | { type: 'task_updated';          task: TaskView }
  | { type: 'error';                 message: string };

// ── Client → Server ──────────────────────────────────────────────
export type ClientMessage =
  | { type: 'dispatch';     tasks: { taskUrl: string; projectContextUrl: string; taskType?: string; projectId: string }[] }
  | { type: 'approve';      sessionId: string }
  | { type: 'deny';         sessionId: string; reason?: string }
  | { type: 'send_message'; sessionId: string; message: string }
  | { type: 'kill';         sessionId: string }
  | { type: 'end_session';  sessionId: string }
  | { type: 'fetch_tasks';  projectId: string; boardId?: string; skipCache?: boolean };

