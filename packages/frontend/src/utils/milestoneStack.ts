import type { StagedIntent } from '../api/stagedIntents';

/** Best-effort task ref carried by most staged-intent kinds — absent for task.create/decision.pickOne, which don't resolve to an existing task on the payload itself. */
export function taskIdFromIntent(intent: StagedIntent): string | null {
  const payload = intent.payload as { taskId?: unknown } | null;
  return typeof payload?.taskId === 'string' ? payload.taskId : null;
}

/**
 * Task id to show for a staged intent — its own payload.taskId when present,
 * otherwise the task of its originating session (e.g. a decision.pickOne
 * question, which deliberately carries no taskId of its own; see
 * routes/stagedIntents.ts's extractPromptKey). Display only: never persisted
 * back onto the intent and never treated as an apply target.
 */
export function taskIdForIntentDisplay(
  intent: StagedIntent,
  sessionTaskId: string | null,
): string | null {
  return taskIdFromIntent(intent) ?? sessionTaskId;
}
