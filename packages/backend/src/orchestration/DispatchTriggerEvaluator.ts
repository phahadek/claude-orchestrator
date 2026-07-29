import { logger } from '../logger';
import type { SessionManager } from '../session/SessionManager';
import type { Scheduler } from './Scheduler';
import type { OpsSessionLauncher } from './OpsSessionLauncher';
import { dispatchPlanningFlow } from '../routes/planningLaunch';
import { loadOpsContext } from '../ops/opsLoad';
import { getAllProjects, runtimeSettings } from '../config';
import type { ProjectConfig } from '../config';
import {
  getArm,
  getMilestoneById,
  getProjectRowById,
  getTaskCache,
  hasActivePlanningSessionForTask,
  hasActiveSessionForTask,
  hasNonIdlePlanningSessionForTask,
  hasUndispositionedStagedIntentForTask,
  listMilestonesByProject,
  setTaskPauseReason,
} from '../db/queries';
import type { MilestoneRow } from '../db/types';
import type { NotionTask } from '../notion/types';
import { typedGetSetting } from '../config/settings';
import { CrashBudget } from './crashBudget';
import {
  isGroomCandidate,
  isOpsCandidate,
  isDesignCandidate,
} from './planningCandidates';

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

interface FlowCandidate {
  projectId: string;
  milestone: MilestoneRow;
  task: NotionTask;
}

/**
 * Auto-dispatch trigger evaluator — a Scheduler job (sibling to AutoLauncher)
 * that scans armed flows across projects/milestones and dispatches planning
 * sessions. Groom/design dispatch via the shared dispatchPlanningFlow helper;
 * ops dispatches directly via OpsSessionLauncher.launchSelected, using the
 * richer OpsTaskEntry/loadOpsContext data dispatchPlanningFlow's manual
 * PlanningTaskEntry path doesn't carry (see planningCandidates.ts).
 *
 * Scan scope: per project, every non-Done milestone (wrapped_at IS NULL) ×
 * armed flows — not restricted to a project's autoLaunchMilestoneId.
 * Backpressure is capacity-checked once per tick (skip-till-next-tick, no
 * throttling loop): at most `cap - humanReserve - activePlanning` sessions
 * are dispatched, spent groom-first, then ops, then design within a project.
 * Fairness rotates the starting project each tick and walks candidates
 * FIFO-by-age (board list order, the closest proxy available — NotionTask
 * carries no created_at) within a project.
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

      const groomCandidates = this.scanProjectGroomCandidates(project.id);
      dispatched += await this.dispatchUpTo(
        groomCandidates,
        available - dispatched,
        (c) => this.dispatchPlanningCandidate(c, 'groom'),
      );
      if (dispatched >= available) continue;

      const opsCandidates = await this.scanProjectOpsCandidates(project.id);
      dispatched += await this.dispatchUpTo(
        opsCandidates,
        available - dispatched,
        (c) => this.dispatchOpsCandidate(c),
      );
      if (dispatched >= available) continue;

      const designCandidates = this.scanProjectDesignCandidates(project.id);
      dispatched += await this.dispatchUpTo(
        designCandidates,
        available - dispatched,
        (c) => this.dispatchPlanningCandidate(c, 'design'),
      );
    }
    return dispatched;
  }

  /** Dispatches candidates FIFO until `remaining` sessions have launched or the list is exhausted. */
  private async dispatchUpTo<T>(
    candidates: T[],
    remaining: number,
    dispatchFn: (candidate: T) => Promise<boolean>,
  ): Promise<number> {
    let dispatched = 0;
    for (const candidate of candidates) {
      if (dispatched >= remaining) break;
      const launched = await dispatchFn(candidate);
      if (launched) dispatched++;
    }
    return dispatched;
  }

  /** All groom-armed, dependency-cleared, un-dispatched Backlog tasks across a project's non-Done milestones, in board order (FIFO-by-age proxy). */
  private scanProjectGroomCandidates(projectId: string): FlowCandidate[] {
    const candidates: FlowCandidate[] = [];
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
            hasRunningGroomSession: (taskId) =>
              hasNonIdlePlanningSessionForTask(taskId, 'groom'),
            hasUndispositionedGroomIntent: hasUndispositionedStagedIntentForTask,
            inCrashCooldown: (taskId) => this.crashBudget.inCooldown(taskId),
          })
        ) {
          candidates.push({ projectId, milestone, task });
        }
      }
    }
    return candidates;
  }

  /** All ops-armed, dependency-cleared (Done + deployed), un-dispatched Ready ops/investigation/testing tasks across a project's non-Done milestones, in board order. */
  private async scanProjectOpsCandidates(
    projectId: string,
  ): Promise<FlowCandidate[]> {
    const candidates: FlowCandidate[] = [];
    const milestones = listMilestonesByProject(projectId).filter(
      (m) => m.wrapped_at == null,
    );
    for (const milestone of milestones) {
      if (!getArm(milestone.id, 'ops')) continue;
      const tasks = this.loadBoardTasks(milestone.id);
      if (tasks.length === 0) continue;
      const tasksById = new Map(tasks.map((t) => [t.id, t]));
      for (const task of tasks) {
        const candidate = await isOpsCandidate(task, {
          tasksById,
          hasActiveSession: hasActiveSessionForTask,
          hasActiveOpsSession: (taskId) =>
            hasActivePlanningSessionForTask(taskId, 'ops'),
          inCrashCooldown: (taskId) => this.crashBudget.inCooldown(taskId),
          projectId,
        });
        if (candidate) candidates.push({ projectId, milestone, task });
      }
    }
    return candidates;
  }

  /** All design-armed, dependency-cleared, un-dispatched Ready design/planning tasks across a project's non-Done milestones, in board order. */
  private scanProjectDesignCandidates(projectId: string): FlowCandidate[] {
    const candidates: FlowCandidate[] = [];
    const milestones = listMilestonesByProject(projectId).filter(
      (m) => m.wrapped_at == null,
    );
    for (const milestone of milestones) {
      const armed = getArm(milestone.id, 'design');
      if (!armed) continue;
      const tasks = this.loadBoardTasks(milestone.id);
      if (tasks.length === 0) continue;
      const tasksById = new Map(tasks.map((t) => [t.id, t]));
      for (const task of tasks) {
        if (
          isDesignCandidate(task, {
            tasksById,
            hasActiveSession: hasActiveSessionForTask,
            hasActiveDesignSession: (taskId) =>
              hasActivePlanningSessionForTask(taskId, 'design'),
            inCrashCooldown: (taskId) => this.crashBudget.inCooldown(taskId),
            armed,
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

  /** Shared groom/design dispatch via dispatchPlanningFlow's manual-PlanningTaskEntry path. */
  private async dispatchPlanningCandidate(
    candidate: FlowCandidate,
    flow: 'groom' | 'design',
  ): Promise<boolean> {
    const project = getProjectRowById(candidate.projectId);
    const milestone = getMilestoneById(candidate.milestone.id);
    if (!project || !milestone) return false;

    const result = await dispatchPlanningFlow(
      this.launcher,
      milestone,
      project,
      flow,
      [candidate.task.id],
    );

    if (result.launched.length > 0) {
      this.crashBudget.clear(candidate.task.id);
      return true;
    }
    if (result.deferred.length > 0) return false;

    const reason = result.failed[0]?.reason ?? `${flow} dispatch failed`;
    const { count, escalated } = this.crashBudget.recordEvent(
      candidate.task.id,
    );
    logger.warn(
      `[DispatchTriggerEvaluator] ${flow} dispatch failed for task ${candidate.task.id} (attempt ${count}): ${reason}`,
    );
    if (escalated) {
      setTaskPauseReason(candidate.task.id, 'launch_failed', reason);
    }
    return false;
  }

  /**
   * Ops dispatch bypasses dispatchPlanningFlow: it needs the richer
   * OpsTaskEntry (blockingDepIds/blockingDepTitles/mode/etc.) that
   * loadOpsContext produces, which OpsSessionLauncher's ops path injects
   * into the session (buildOpsSessionContext) and uses to derive the
   * planning digest. Calls launchSelected directly with a live-reloaded
   * opsContext; OpsSessionLauncher's own deferral map + 15s poll
   * (register/pollOnce) already retries a task whose dep-gate flips closed
   * between this scan and the live reload, so the evaluator does not
   * re-poll it itself.
   */
  private async dispatchOpsCandidate(
    candidate: FlowCandidate,
  ): Promise<boolean> {
    const project = getProjectRowById(candidate.projectId);
    const milestone = getMilestoneById(candidate.milestone.id);
    if (!project || !milestone) return false;

    let opsContext;
    try {
      opsContext = await loadOpsContext(milestone.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[DispatchTriggerEvaluator] ops dispatch failed to load context for task ${candidate.task.id}: ${reason}`,
      );
      const { count, escalated } = this.crashBudget.recordEvent(
        candidate.task.id,
      );
      logger.warn(
        `[DispatchTriggerEvaluator] ops dispatch failed for task ${candidate.task.id} (attempt ${count}): ${reason}`,
      );
      if (escalated) {
        setTaskPauseReason(candidate.task.id, 'launch_failed', reason);
      }
      return false;
    }

    const entry = opsContext.worklist.executable.find(
      (t) => t.id === candidate.task.id,
    );
    // Not in the live executable worklist (status/dep-gate changed since the
    // cached-board scan) — skip this tick rather than force a stale dispatch.
    if (!entry) return false;

    const result = await this.launcher.launchSelected({
      projectId: project.id,
      projectContextUrl: project.context_url ?? '',
      milestoneId: milestone.id,
      sessionType: 'ops',
      opsContext,
      tasks: [entry],
    });

    if (result.launched.length > 0) {
      this.crashBudget.clear(candidate.task.id);
      return true;
    }
    if (result.deferred.length > 0) return false;

    const reason = result.failed[0]?.reason ?? 'ops dispatch failed';
    const { count, escalated } = this.crashBudget.recordEvent(
      candidate.task.id,
    );
    logger.warn(
      `[DispatchTriggerEvaluator] ops dispatch failed for task ${candidate.task.id} (attempt ${count}): ${reason}`,
    );
    if (escalated) {
      setTaskPauseReason(candidate.task.id, 'launch_failed', reason);
    }
    return false;
  }
}
