import type { StagedIntent } from '../api/stagedIntents';

/** Best-effort task ref carried by most staged-intent kinds — absent for task.create/decision.pickOne, which don't resolve to an existing task. */
export function taskIdFromIntent(intent: StagedIntent): string | null {
  const payload = intent.payload as { taskId?: unknown } | null;
  return typeof payload?.taskId === 'string' ? payload.taskId : null;
}
