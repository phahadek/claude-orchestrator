/**
 * Shared per-task escalating-backoff cooldown + escalate-after-N budget.
 * AutoLauncher uses one instance for pre-spawn launch_failed events;
 * DispatchTriggerEvaluator uses a separate instance for planning-dispatch
 * failures. Any caller-recognized failure signal — a launch failure, a
 * session crash, or the planning "terminal with nothing staged" backstop
 * (PlanningOrchestrator.checkTerminal's planning_terminal_no_decision pause)
 * — counts as one event via recordEvent; this module doesn't care which.
 */

export interface CrashBudgetOptions {
  /** Escalating cooldown windows (ms), indexed by consecutive event count - 1. The last entry repeats for further events. */
  backoffScheduleMs?: number[];
  /** Consecutive events at/above which recordEvent reports escalated=true. */
  escalateAfter?: number;
}

export interface CrashBudgetOutcome {
  /** Consecutive event count for this task after this call. */
  count: number;
  /** True once `count` has reached the escalate-after threshold. */
  escalated: boolean;
  /** Cooldown window (ms) applied by this event. */
  cooldownMs: number;
}

const DEFAULT_BACKOFF_SCHEDULE_MS = [30_000, 2 * 60_000, 10 * 60_000];
const DEFAULT_ESCALATE_AFTER = 3;

export class CrashBudget {
  private readonly attempts = new Map<
    string,
    { count: number; nextRetryAt: number }
  >();
  private readonly backoffScheduleMs: number[];
  private readonly escalateAfter: number;

  constructor(options: CrashBudgetOptions = {}) {
    this.backoffScheduleMs =
      options.backoffScheduleMs ?? DEFAULT_BACKOFF_SCHEDULE_MS;
    this.escalateAfter = options.escalateAfter ?? DEFAULT_ESCALATE_AFTER;
  }

  /** Record one backoff-worthy event for `taskId` and return the updated budget state. */
  recordEvent(taskId: string): CrashBudgetOutcome {
    const prev = this.attempts.get(taskId);
    const count = (prev?.count ?? 0) + 1;
    const cooldownMs =
      this.backoffScheduleMs[
        Math.min(count - 1, this.backoffScheduleMs.length - 1)
      ];
    this.attempts.set(taskId, { count, nextRetryAt: Date.now() + cooldownMs });
    return { count, escalated: count >= this.escalateAfter, cooldownMs };
  }

  /** True while `taskId` is still within the cooldown window from its most recent event. */
  inCooldown(taskId: string): boolean {
    const attempt = this.attempts.get(taskId);
    return !!attempt && Date.now() < attempt.nextRetryAt;
  }

  /** Reset `taskId`'s budget — called on a clean relaunch or an external Ready transition. */
  clear(taskId: string): void {
    this.attempts.delete(taskId);
  }
}
