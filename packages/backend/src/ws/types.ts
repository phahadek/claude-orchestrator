import type { ResolvedTask } from '../notion/types';
import type { DisplayStatus } from '../tasks/TaskStatusEngine';
import type { PauseReason } from '../db/types';
import type { EventKind } from '../session/eventKind';

// ── Server → Client ──────────────────────────────────────────────
export interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

/**
 * Persistent state snapshot of a session as synced to frontend clients via
 * `session_started` WS messages. Populated from the `sessions` table joined
 * against `pull_requests` (for prUrl) on each WS connection.
 */
interface SessionState {
  sessionId: string;
  taskName: string;
  notionTaskUrl: string;
  taskType?: string;
  sessionType?: string;
  prNumber?: number;
  codeSessionId?: string;
  started_at?: number;
  ended_at?: number;
  archived?: boolean;
  favorited?: boolean;
  project_id?: string | null;
  note?: string | null;
  tags?: string[];
  totalInputTokens?: number;
  totalOutputTokens?: number;
  compaction_count?: number;
  context_occupancy_tokens?: number;
  model?: string | null;
  /** PR URL linked to this session, resolved from the pull_requests join. */
  prUrl?: string;
  /** Notion task ID this session belongs to — enables targeted in-place task updates. */
  taskId?: string;
}

/** Full live-state snapshot of a task, sent in task_updated WS messages. */
export interface TaskView {
  taskId: string;
  taskName: string;
  notionStatus: string;
  displayStatus: DisplayStatus;
  /** Non-null when the task is paused (e.g. 'max_reviews', 'stuck_timeout'). */
  pauseReason: PauseReason | null;
  priority: string;
  notionUrl: string;
  taskType: string;
  blocked: boolean;
  blockerNames: string[];
  wave: number;
  codeSession: {
    sessionId: string;
    status: string;
    sessionType?: string | null;
    startedAt: number;
    endedAt: number | null;
    lastMessage: string;
    inputTokens: number;
    outputTokens: number;
    context_occupancy_tokens?: number;
    compaction_count?: number;
    model?: string | null;
  } | null;
  pr: {
    prNumber: number;
    prUrl: string;
    title: string;
    headBranch: string;
    baseBranch: string;
    state: string;
    draft: boolean;
    mergeState: string | null;
    preReviewStage?: string | null;
  } | null;
  review: {
    sessionId: string;
    status: string;
    verdict: string | null;
    summary: string | null;
    iterationCount: number;
    inputTokens: number;
    outputTokens: number;
  } | null;
  totalTokens: { input: number; output: number };
  /** Assigned target repo slug for multi-repo projects, e.g. "owner/repo". Null when unassigned. */
  assignedRepo: string | null;
}

export type ServerMessage =
  | ({ type: 'session_starting' } & SessionState)
  | ({ type: 'session_started' } & SessionState)
  | {
      type: 'session_event';
      sessionId: string;
      eventType: EventKind;
      content: string;
      messageId?: string;
    }
  | {
      type: 'session_status';
      sessionId: string;
      status:
        | 'starting'
        | 'running'
        | 'needs_permission'
        | 'idle'
        | 'done'
        | 'error'
        | 'killed'
        | 'retrying';
      replay?: boolean;
    }
  | {
      type: 'permission_request';
      sessionId: string;
      toolName: string;
      proposedAction: string;
    }
  | {
      type: 'permission_denials';
      sessionId: string;
      denials: PermissionDenial[];
    }
  | {
      type: 'session_ended';
      sessionId: string;
      status: string;
      prUrl?: string;
      taskId?: string;
    }
  | { type: 'pr_created'; sessionId: string; prUrl: string; taskId?: string }
  | {
      type: 'session_updated';
      sessionId: string;
      note?: string | null;
      tags?: string[];
      totalInputTokens?: number;
      totalOutputTokens?: number;
      compactionCount?: number;
      model?: string;
      contextOccupancyTokens?: number;
      contextOccupancyFraction?: number;
    }
  | { type: 'tasks_ready'; tasks: ResolvedTask[] }
  | {
      type: 'pr_review_complete';
      prNumber: number;
      repo: string;
      verdict: string;
      summary: string;
      draft?: boolean;
      replay?: boolean;
    }
  | { type: 'push_detected'; sessionId: string; prNumber: number; repo: string }
  | {
      type: 'review_verdict';
      prNumber: number;
      repo: string;
      verdict: string;
      summary: string;
      iteration: number;
      replay?: boolean;
    }
  | { type: 'pr_merged'; prNumber: number; repo: string; sha: string }
  | { type: 'pr_closed'; prNumber: number; repo: string }
  | {
      type: 'pr_state_changed';
      prNumber: number;
      repo: string;
      mergeable: boolean | null;
      mergeState: string | null;
    }
  | {
      type: 'pr_mergeability_changed';
      prNumber: number;
      repo: string;
      mergeable: boolean | null;
      mergeState: string | null;
      failingChecks?: string[] | null;
    }
  | {
      type: 'review_escalated';
      prNumber: number;
      repo: string;
      message: string;
    }
  | {
      type: 'review_failed';
      prNumber: number;
      repo: string;
      message: string;
    }
  | {
      type: 'review_incomplete';
      prNumber: number;
      repo: string;
      message: string;
    }
  | {
      type: 'stuck_session_notified';
      sessionId: string;
      taskName: string;
      message: string;
    }
  | {
      type: 'stuck_session_paused';
      sessionId: string;
      taskName: string;
      prNumber?: number;
      repo?: string;
    }
  | { type: 'stuck_session_killed'; sessionId: string; taskName: string }
  | {
      type: 'stuck_session_idle_open_pr';
      sessionId: string;
      taskId: string | null;
      prUrl: string | null;
    }
  | {
      type: 'api_overloaded_paused';
      sessionId: string;
      prNumber?: number;
      repo?: string;
    }
  | {
      type: 'session_audit';
      sessionId: string;
      prOpened: boolean;
      prTargetsBranch: string | null;
      violations: (string | import('../db/types').WorktreeEscapeViolation)[];
      specMismatch: string | null;
      auditedAt: string;
    }
  | { type: 'task_status_changed'; notionTaskId: string; newStatus: string }
  | { type: 'task_updated'; task: TaskView }
  | {
      type: 'auto_launch';
      projectId: string;
      taskId: string;
      taskTitle: string;
      sessionId: string;
    }
  | {
      type: 'auto_launch_paused';
      taskId: string;
      reason: 'launch_failed';
      detail: string;
    }
  | { type: 'session_launch_failed'; taskId: string; sessionId: string }
  | {
      type: 'github_rate_limit_hit';
      resetAt: string; // ISO-8601
      limit: number;
      used: number;
    }
  | { type: 'github_rate_limit_cleared' }
  | { type: 'error'; message: string }
  | { type: 'pr_pause_cleared'; prNumber: number; repo: string }
  | { type: 'autofix_started'; prNumber: number; repo: string }
  | {
      type: 'autofix_complete';
      prNumber: number;
      repo: string;
      success: boolean;
      summary?: string;
    }
  | { type: 'review_started'; prNumber: number; sessionId: string }
  | {
      type: 'pipeline_stage_entered';
      prNumber: number;
      repo: string;
      stage: string;
    }
  | {
      type: 'pipeline_stage_passed';
      prNumber: number;
      repo: string;
      stage: string;
      summary?: string;
    }
  | {
      type: 'pipeline_stage_failed';
      prNumber: number;
      repo: string;
      stage: string;
      summary?: string;
      failedCommand?: string;
    }
  | {
      type: 'local_branch_submitted';
      projectId: string;
      sessionId: string;
      branchName: string;
      baseBranch: string;
    }
  | {
      type: 'local_branch_merged';
      projectId: string;
      sessionId: string;
      branchName: string;
      commitSha: string | null;
    }
  | {
      type: 'enrollment_request';
      code: string;
      deviceName: string;
      userAgent: string;
      ip: string;
      expiresAt: number;
    }
  | {
      type: 'enrollment_approved';
      code: string;
      deviceId: string;
    }
  | {
      type: 'update_available';
      version: string;
      releaseNotesUrl: string;
    }
  | {
      type: 'ci_billing_blocked';
      prNumber: number;
      repo: string;
      message: string;
    }
  | { type: 'session_archived'; sessionId: string }
  | { type: 'context_overflow_detected'; sessionId: string }
  | { type: 'large_model_escalation_started'; sessionId: string }
  | { type: 'missed_pr_nudge'; sessionId: string }
  | {
      type: 'session_auto_pushed';
      sessionId: string;
      branch: string;
      commits: number;
    }
  | {
      type: 'task_cache_updated';
      projectId: string;
      boardId: string;
      taskCount: number;
      refreshedAt: number;
    }
  | {
      type: 'session_action_failed';
      sessionId: string;
      action: string;
      reason: string;
      detail: string;
    }
  | {
      type: 'boot_reconciliation_started';
      steps: string[];
      started_at: string;
    }
  | {
      type: 'boot_reconciliation_step';
      step: string;
      status: 'started' | 'completed' | 'failed';
      duration_ms?: number;
      items_processed?: number;
      error?: string;
    }
  | {
      type: 'boot_reconciliation_completed';
      duration_ms: number;
      completed_at: string;
    }
  | {
      type: 'scheduler_job_run';
      job: string;
      status: 'ok' | 'failed' | 'skipped';
      started_at: string;
      completed_at: string;
      duration_ms: number;
      next_run_at: string | null;
      items_processed?: number;
      error?: { message: string; stack?: string };
    }
  | {
      type: 'pr_stalled_escalated';
      prNumber: number;
      repo: string;
      kind:
        | 'incomplete_verdict'
        | 'errored_review_session'
        | 'gate_failed'
        | 'analyze_failing'
        | 'pre_review_interrupted';
    };

// ── Client → Server ──────────────────────────────────────────────
export type ClientMessage =
  | {
      type: 'dispatch';
      tasks: {
        taskUrl?: string;
        taskId?: string;
        projectContextUrl: string;
        taskType?: string;
        projectId: string;
        milestoneId?: string | null;
        taskKind?: 'milestone' | 'non_milestone';
        taskName?: string;
      }[];
    }
  | { type: 'approve'; sessionId: string }
  | { type: 'deny'; sessionId: string; reason?: string }
  | { type: 'send_message'; sessionId: string; message: string }
  | { type: 'kill'; sessionId: string }
  | { type: 'end_session'; sessionId: string }
  | {
      type: 'fetch_tasks';
      projectId: string;
      milestoneId: string;
      skipCache?: boolean;
    }
  | { type: 'enrollment_approve'; code: string };
