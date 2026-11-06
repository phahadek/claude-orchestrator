import {
  getPRByNotionTaskId,
  getLatestCodeSessionByNotionTaskId,
  getTaskCache,
  getTaskPauseReason,
  getLastRecordedDisplayStatus,
  setLastRecordedDisplayStatus,
} from '../db/queries';
import {
  parsePauseReason,
  isAutomaticRecoveryPending,
} from '../db/pauseReason';
import { typedGetSetting } from '../config/settings';
import { recordEvent } from '../audit/AuditLog';
import type { PauseReasonStruct } from '../db/types';

export type DisplayStatus =
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'needs_attention'
  | 'auto_recovering'
  | 'ready_to_merge'
  | 'done'
  | 'backlog'
  | 'blocked'
  | 'deferred';

export interface TaskStatusInput {
  notionStatus: string; // raw Notion status string
  codeSessionStatus: string | null; // 'running' | 'idle' | 'done' | 'error' | null
  prState: string | null; // 'open' | 'merged' | 'closed' | null
  prDraft: boolean; // true if PR is draft
  reviewVerdict: string | null; // 'approved' | 'needs_changes' | 'incomplete' | null
  reviewIterationCount: number; // how many review cycles
  reviewIterationCap: number; // configurable cap from settings
  pauseReason?: PauseReasonStruct | null; // non-null forces needs_attention (unless terminal/approved)
  flakeRecoveryAttempts?: number; // pull_requests.flake_recovery_attempts — how many automatic recovery attempts have run
  flakeRecoveryMaxRetries?: number; // flake_recovery_max_retries setting — budget for automatic recovery
}

/**
 * Pure, stateless function that derives a display status for a task.
 * Notion status is the primary source of truth for grouping.
 * Local signals (PR state, review verdict) are used only for enrichment
 * within the Notion-derived group, not for overriding it.
 * Exception: a merged or closed PR always results in 'done'.
 */
export function deriveDisplayStatus(input: TaskStatusInput): DisplayStatus {
  const {
    notionStatus,
    prState,
    reviewVerdict,
    pauseReason,
    flakeRecoveryAttempts = 0,
    flakeRecoveryMaxRetries = 0,
  } = input;

  // A pause whose automatic recovery budget isn't exhausted yet surfaces as a
  // distinct, lower-weight status instead of escalating to a human — see
  // isAutomaticRecoveryPending. Once the budget is exhausted it falls through
  // to the needs_attention checks below, unchanged from today's behavior.
  const autoRecovering = isAutomaticRecoveryPending(
    pauseReason,
    flakeRecoveryAttempts,
    flakeRecoveryMaxRetries,
  );

  // 1. done — PR merged (terminal override, takes precedence over Notion)
  // Closed-without-merge is NOT terminal: Notion status remains the source of truth
  // so a retired PR doesn't hide an In Progress task still being re-worked.
  if (prState === 'merged') {
    return 'done';
  }

  // 2. Notion status is the primary source of truth for grouping
  if (notionStatus.includes('Done')) return 'done';

  if (notionStatus.includes('In Review')) {
    // Enrich with review-specific sub-states within the In Review group.
    // ready_to_merge wins over needs_attention so approved PRs surface
    // promptly even if a stale pause_reason hasn't been cleared yet.
    if (reviewVerdict === 'approved' && prState === 'open')
      return 'ready_to_merge';
    if (autoRecovering) return 'auto_recovering';
    if (pauseReason) return 'needs_attention';
    return 'in_review';
  }

  // Explicit Notion status wins over pause_reason so a 🚫 Blocked task is never
  // silently demoted to needs_attention or backlog. The pause detail still surfaces
  // in the tooltip via the pauseReason field on the task view.
  if (notionStatus.includes('Blocked')) return 'blocked';
  if (notionStatus.includes('Deferred')) return 'deferred';

  // Any non-null pause_reason marks the task as needing attention — unless it's
  // still within its automatic recovery budget (see autoRecovering above).
  if (autoRecovering) return 'auto_recovering';
  if (pauseReason) return 'needs_attention';

  if (notionStatus.includes('In Progress')) return 'in_progress';

  if (notionStatus.includes('Backlog')) return 'backlog';

  // 3. ready — only for explicitly recognized Ready status
  if (notionStatus.includes('Ready')) return 'ready';

  // Empty or unrecognized notionStatus (e.g. no task_cache row) must not surface
  // as launchable. Default to backlog so stale/unknown tasks don't appear in Ready.
  return 'backlog';
}

export interface DisplayStatusTransitionInputs {
  notionStatus: string;
  pauseReason: PauseReasonStruct | null;
  flakeRecoveryAttempts: number;
  flakeRecoveryMaxRetries: number;
}

/**
 * Edge-triggered write of task_display_status_changed: records an audit
 * event only when the derived displayStatus actually differs from the last
 * recorded value for this task (persisted in task_display_status_log — see
 * schema.ts), instead of on every deriveDisplayStatus call. deriveDisplayStatus
 * itself stays pure and stateless; this is called separately by each of its
 * call sites (routes/tasks.ts's buildTaskViewFromRow and this file's
 * deriveDisplayStatusFromDb, consumed by SessionManager) against the same
 * shared, DB-backed last-recorded value so neither call site can drift out
 * of sync with the other.
 */
export function recordDisplayStatusTransition(
  taskId: string,
  next: DisplayStatus,
  inputs: DisplayStatusTransitionInputs,
): void {
  const prev = getLastRecordedDisplayStatus(taskId);
  if (prev === next) return;
  setLastRecordedDisplayStatus(taskId, next);
  recordEvent({
    event_type: 'task_display_status_changed',
    actor_type: 'system',
    task_id: taskId,
    payload: {
      from: prev ?? null,
      to: next,
      notion_status: inputs.notionStatus,
      pause_reason: inputs.pauseReason?.reason ?? null,
      pause_severity: inputs.pauseReason?.severity ?? null,
      retry_strategy: inputs.pauseReason?.retry_strategy ?? null,
      flake_recovery_attempts: inputs.flakeRecoveryAttempts,
      flake_recovery_max_retries: inputs.flakeRecoveryMaxRetries,
    },
  });
}

function getReviewIterationCap(): number {
  return typedGetSetting('max_review_iterations');
}

function getFlakeRecoveryMaxRetries(): number {
  return typedGetSetting('flake_recovery_max_retries');
}

/**
 * Fetch the live state for a Notion task from SQLite and derive its display status.
 * Reads the Notion status from the task cache so grouping respects Notion as source of truth.
 */
export function deriveDisplayStatusFromDb(notionTaskId: string): DisplayStatus {
  const prRow = getPRByNotionTaskId(notionTaskId);
  const sessionRow = getLatestCodeSessionByNotionTaskId(notionTaskId);

  let notionStatus = '';
  const taskCacheRow = getTaskCache(notionTaskId);
  if (taskCacheRow) {
    try {
      const task = JSON.parse(taskCacheRow.raw_json) as { status?: string };
      notionStatus = task.status ?? '';
    } catch {
      // ignore malformed cache
    }
  }

  let reviewVerdict: string | null = null;
  if (prRow?.review_result) {
    try {
      const parsed = JSON.parse(prRow.review_result) as { verdict?: string };
      reviewVerdict = parsed.verdict ?? null;
    } catch {
      // ignore malformed review_result
    }
  }

  const pauseReason =
    parsePauseReason(prRow?.pause_reason ?? null) ??
    getTaskPauseReason(notionTaskId) ??
    null;
  const flakeRecoveryAttempts = prRow?.flake_recovery_attempts ?? 0;
  const flakeRecoveryMaxRetries = getFlakeRecoveryMaxRetries();

  const displayStatus = deriveDisplayStatus({
    notionStatus,
    codeSessionStatus: sessionRow?.status ?? null,
    prState: prRow?.state ?? null,
    prDraft: (prRow?.draft ?? 0) === 1,
    reviewVerdict,
    reviewIterationCount: prRow?.review_iteration ?? 0,
    reviewIterationCap: getReviewIterationCap(),
    pauseReason,
    flakeRecoveryAttempts,
    flakeRecoveryMaxRetries,
  });

  recordDisplayStatusTransition(notionTaskId, displayStatus, {
    notionStatus,
    pauseReason,
    flakeRecoveryAttempts,
    flakeRecoveryMaxRetries,
  });

  return displayStatus;
}
