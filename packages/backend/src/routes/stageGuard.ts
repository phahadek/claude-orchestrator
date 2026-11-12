import { recordEvent } from '../audit/AuditLog';
import { AVOIDABLE_GUARD_CLASSES } from '../db/types';
import type { AvoidableGuardClass } from '../db/types';

export function isAvoidableGuardClass(
  value: unknown,
): value is AvoidableGuardClass {
  return (
    typeof value === 'string' &&
    (AVOIDABLE_GUARD_CLASSES as readonly string[]).includes(value)
  );
}

export class StageGuardRejectionError extends Error {
  constructor(
    readonly guardId: string,
    readonly evidence: string,
  ) {
    super(
      `[stagedIntents] stage guard "${guardId}" rejected this intent: ${evidence}`,
    );
    this.name = 'StageGuardRejectionError';
  }
}

export interface StageGuardRejectionContext {
  guardId: string;
  evidence: string;
  sessionId: string | null;
  taskId: string | null;
  projectId?: string | null;
  intentKind: string;
}

/**
 * Rejects a stage request in-turn: writes exactly one stage_guard_rejected
 * audit event keyed by guard id, then throws. Call before the intent is
 * inserted so a rejected intent is never persisted.
 */
export function rejectStageGuard(ctx: StageGuardRejectionContext): never {
  recordEvent({
    event_type: 'stage_guard_rejected',
    actor_type: 'system',
    actor_id: ctx.sessionId,
    project_id: ctx.projectId ?? null,
    task_id: ctx.taskId,
    payload: {
      guardId: ctx.guardId,
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
      intentKind: ctx.intentKind,
      evidence: ctx.evidence,
    },
  });
  throw new StageGuardRejectionError(ctx.guardId, ctx.evidence);
}
