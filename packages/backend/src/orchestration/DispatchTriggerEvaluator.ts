import { logger } from '../logger';
import type { SessionManager } from '../session/SessionManager';
import type { Scheduler } from './Scheduler';
import type { OpsSessionLauncher } from './OpsSessionLauncher';
import { dispatchPlanningFlow } from '../routes/planningLaunch';
import { getAllProjects, runtimeSettings } from '../config';
import type { ProjectConfig } from '../config';
import {
  getArm,
  getMilestoneById,
  getProjectRowById,
  getTaskCache,
  hasActiveSessionForTask,
  listMilestonesByProject,
  setTaskPauseReason,
} from '../db/queries';
import type { MilestoneRow } from '../db/types';
import type { NotionTask } from '../notion/types';
import { typedGetSetting } from '../config/settings';
import { CrashBudget } from './crashBudget';
import { isGroomCandidate } from './planningCandidates';

const MIN_POLL_INTERVAL_MS = 5_000;

/** available = max(0, cap - humanReserve - active), never negative. */
export function computeAvailableCapacity(params: {
  maxConcurrentPlanningSessions: number;
  humanReserve: number;
  activePlanningSessions: number;
}): number {
  return Math.max(
    0,
    params.maxConcurrentPlanningSessions -
      params.humanReserve -
      params.activePlanningSessions,
  );
}

/** Rotate `items` so it starts at `startIndex` (wrapping) — the round-robin fairness primitive. */
export function rotateFromIndex<T>(items: T[], startIndex: number): T[] {
  if (items.length === 0) return [];
  const start = ((startIndex % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

interface GroomCandidate {
  projectId: string;
  milestone: MilestoneRow;
  task: NotionTask;
}

/**
 * Auto-dispatch trigger evaluator — a Scheduler job (sibling to AutoLauncher)
 * that scans armed flows across projects/milestones and dispatches planning
 * sessions via dispatchPlanningFlow. Wired for the groom flow only; ops/design
 * candidate predicates land in a sibling task and plug into the same scan
 * shape (see planningCandidates.ts).
 *
 * Scan scope: per project, every non-Done milestone (wrapped_at IS NULL) ×
 * armed flows — not restricted to a project's autoLaunchMilestoneId.
 * Backpressure is capacity-checked once per tick (skip-till-next-tick, no
 * throttling loop): at most `cap - humanReserve - activePlanning` sessions
 * are dispatched. Fairness rotates the starting project each tick and walks
 * candidates FIFO-by-age (board list order, the closest proxy available —
 * NotionTask carries no created_at) within a project.
 */
export class DispatchTriggerEvaluator {
  private roundRobinIndex = 0;
  private readonly crashBudget = new CrashBudget();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly launcher: OpsSessionLauncher,
    private readonly options: {
      listProjects?: () => ProjectConfig[];
    } = {},
  ) {}

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'dispatch_trigger_evaluator',
      intervalMs: () =>
        Math.max(
          MIN_POLL_INTERVAL_MS,
          runtimeSettings.auto_launch_poll_interval_ms,
        ),
      concurrency: 'skip-if-running',
      run: async () => {
        const dispatched = await this.tickOnce();
        return { items_processed: dispatched };
      },
    });
  }

  async tickOnce(): Promise<number> {
    const listProjects = this.options.listProjects ?? getAllProjects;
    const projects = listProjects();
    if (projects.length === 0) return 0;

    const orderedProjects = rotateFromIndex(projects, this.roundRobinIndex);
    this.roundRobinIndex = (this.roundRobinIndex + 1) % projects.length;

    const available = computeAvailableCapacity({
      maxConcurrentPlanningSessions: typedGetSetting(
        'max_concurrent_planning_sessions',
      ),
      humanReserve: typedGetSetting('human_reserve'),
      activePlanningSessions: this.sessionManager.getLivePlanningSessionCount(),
    });
    if (available <= 0) return 0;

    let dispatched = 0;
    for (const project of orderedProjects) {
      if (dispatched >= available) break;
      const candidates = this.scanProjectGroomCandidates(project.id);
      for (const candidate of candidates) {
        if (dispatched >= available) break;
        const launched = await this.dispatchGroomCandidate(candidate);
        if (launched) dispatched++;
      }
    }
    return dispatched;
  }

  /** All groom-armed, dependency-cleared, un-dispatched Backlog tasks across a project's non-Done milestones, in board order (FIFO-by-age proxy). */
  private scanProjectGroomCandidates(projectId: string): GroomCandidate[] {
    const candidates: GroomCandidate[] = [];
    const milestones = listMilestonesByProject(projectId).filter(
      (m) => m.wrapped_at == null,
    );
    for (const milestone of milestones) {
      if (!getArm(milestone.id, 'groom')) continue;
      const tasks = this.loadBoardTasks(milestone.id);
      if (tasks.length === 0) continue;
      const tasksById = new Map(tasks.map((t) => [t.id, t]));
      for (const task of tasks) {
        if (
          isGroomCandidate(task, {
            tasksById,
            hasActiveSession: hasActiveSessionForTask,
            inCrashCooldown: (taskId) => this.crashBudget.inCooldown(taskId),
          })
        ) {
          candidates.push({ projectId, milestone, task });
        }
      }
    }
    return candidates;
  }

  private loadBoardTasks(milestoneId: string): NotionTask[] {
    const row = getTaskCache(`board:${milestoneId}`);
    if (!row) return [];
    try {
      return JSON.parse(row.raw_json) as NotionTask[];
    } catch {
      return [];
    }
  }

  private async dispatchGroomCandidate(
    candidate: GroomCandidate,
  ): Promise<boolean> {
    const project = getProjectRowById(candidate.projectId);
    const milestone = getMilestoneById(candidate.milestone.id);
    if (!project || !milestone) return false;

    const result = await dispatchPlanningFlow(
      this.launcher,
      milestone,
      project,
      'groom',
      [candidate.task.id],
    );

    if (result.launched.length > 0) {
      this.crashBudget.clear(candidate.task.id);
      return true;
    }
    if (result.deferred.length > 0) return false;

    const reason = result.failed[0]?.reason ?? 'groom dispatch failed';
    const { count, escalated } = this.crashBudget.recordEvent(
      candidate.task.id,
    );
    logger.warn(
      `[DispatchTriggerEvaluator] groom dispatch failed for task ${candidate.task.id} (attempt ${count}): ${reason}`,
    );
    if (escalated) {
      setTaskPauseReason(candidate.task.id, 'launch_failed', reason);
    }
    return false;
  }
}
