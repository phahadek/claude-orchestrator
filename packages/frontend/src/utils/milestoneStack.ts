import type { StagedIntent } from '../api/stagedIntents';

/** Best-effort task ref carried by most staged-intent kinds — absent for task.create/decision.pickOne, which don't resolve to an existing task on the payload itself. */
export function taskIdFromIntent(intent: StagedIntent): string | null {
  const payload = intent.payload as { taskId?: unknown } | null;
  return typeof payload?.taskId === 'string' ? payload.taskId : null;
}

/**
 * True for a session/task_id sentinel of the form `gate-item:<id>` —
 * SessionGateItemVerifier's synthetic task_id for a one-shot gate-verify
 * session (mirrors the backend's isGateVerifySession in
 * session/sessionPredicates.ts). Never a real Notion task id, so nothing
 * downstream should try to resolve it as one.
 */
export function isGateItemTaskId(
  taskId: string | null | undefined,
): boolean {
  return typeof taskId === 'string' && taskId.startsWith('gate-item:');
}

/** True for a gate.verify staged intent — carries a gate item ref rather than a task ref. */
export function isGateVerifyIntent(intent: StagedIntent): boolean {
  return intent.kind === 'gate.verify';
}

/** The gate item id a gate.verify intent's disposition applies to, read directly off its payload. */
export function gateItemIdFromIntent(intent: StagedIntent): string | null {
  const payload = intent.payload as { gateItemId?: unknown } | null;
  return typeof payload?.gateItemId === 'string' ? payload.gateItemId : null;
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
