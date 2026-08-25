import { logger } from '../logger';
import { normalizeBoardId } from '../tasks/taskId';
import { recordEvent } from '../audit/AuditLog';
import type { PlanningDispatchLaunchedPayload } from '../audit/types';
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
  isNoOpSuppressed,
  isPlanningKillSuppressed,
  listMilestonesByProject,
  setTaskPauseReason,
} from '../db/queries';
import type { MilestoneRow } from '../db/types';
import type { NotionTask } from '../notion/types';
import { typedGetSetting } from '../config/settings';
import { CrashBudget } from './crashBudget';
import { isUsageAdmitted } from './usageAdmission';
import {
  isGroomCandidate,
  isOpsCandidate,
  isDesignCandidate,
  isDesignEligibleType,
  isDocsCandidate,
} from './planningCandidates';
import type { ProjectDepResolution } from './planningCandidates';

const MIN_POLL_INTERVAL_MS = 5_000;

/** Yields to the event loop so a pending HTTP request gets serviced mid-scan. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
 * Reads a milestone board straight off its task_cache row — no Notion round
 * trip, no memo. Returns null when the board has no cache row (or the row
 * fails to parse), distinct from an empty-but-cached board: a caller doing
 * project-wide dep resolution needs to tell "this board proves the dep
 * absent" apart from "this board hasn't been fetched yet, so it proves
 * nothing" (see resolveProjectDepStatus). The class's own `loadBoardTasks`
 * collapses that same case to `[]` instead, which is fine for its callers
 * (they only care found-vs-not, not why), but wrong for a caller that must
 * distinguish dangling from unknown.
 */
function loadBoardTasksFromCache(milestoneId: string): NotionTask[] | null {
  const row = getTaskCache(`board:${milestoneId}`);
  if (!row) return null;
  try {
    return JSON.parse(row.raw_json) as NotionTask[];
  } catch {
    return null;
  }
}

/**
 * Project-wide dependency resolution off task_cache board rows only (zero
 * Notion network calls) — the shared logic behind
 * DispatchTriggerEvaluator.resolveProjectDep, exposed here so the route-side
 * groom-dep-blocked annotator (routes/tasks.ts) can reuse the exact same
 * "absent from every board" determination the dispatcher uses, instead of
 * re-deriving it. `loadBoardTasks` is injectable so the class can thread its
 * memoized reader through for the dispatcher's own hot loop; callers with no
 * particular perf need (e.g. a single route request) can omit it and get
 * `loadBoardTasksFromCache`.
 */
export function resolveProjectDepStatus(
  projectId: string,
  depId: string,
  loadBoardTasks: (
    milestoneId: string,
  ) => NotionTask[] | null = loadBoardTasksFromCache,
): ProjectDepResolution {
  const normalized = normalizeBoardId(depId);
  let sawUncachedBoard = false;
  for (const milestone of listMilestonesByProject(projectId)) {
    const tasks = loadBoardTasks(milestone.id);
    if (tasks === null) {
      sawUncachedBoard = true;
      continue;
    }
    const found = tasks.find((t) => normalizeBoardId(t.id) === normalized);
    if (found) return { status: 'found', task: found };
  }
  return sawUncachedBoard ? { status: 'unknown' } : { status: 'dangling' };
}

/**
 * Auto-dispatch trigger evaluator — a Scheduler job (sibling to AutoLauncher)
 * that scans armed flows across projects/milestones and dispatches planning
 * sessions. Groom/design/docs dispatch via the shared dispatchPlanningFlow
 * helper; ops dispatches directly via OpsSessionLauncher.launchSelected, using the
 * richer OpsTaskEntry/loadOpsContext data dispatchPlanningFlow's manual
 * PlanningTaskEntry path doesn't carry (see planningCandidates.ts).
 *
 * Scan scope: per project, every non-Done milestone (wrapped_at IS NULL) ×
 * armed flows — not restricted to a project's autoLaunchMilestoneId.
 * Backpressure is capacity-checked once per tick (skip-till-next-tick, no
 * throttling loop): at most `cap - humanReserve - activePlanning` sessions
 * are dispatched, spent groom-first, then ops, then design, then docs within
 * a project.
 * Fairness rotates the starting project each tick and walks candidates
 * FIFO-by-age (board list order, the closest proxy available — NotionTask
 * carries no created_at) within a project.
 */
export class DispatchTriggerEvaluator {
  private roundRobinIndex = 0;
  private readonly crashBudget = new CrashBudget();
  /**
   * Parsed-board memo, keyed on the cache row's task_id (`board:<milestoneId>`).
   * Keyed on the row's raw_json content itself (string equality), never on
   * fetched_at: status write-through paths (updateTaskStatusInBoardCaches,
   * updateTaskCacheStatus) intentionally rewrite raw_json while reusing the
   * row's existing fetched_at, and fetched_at is separately relied on
   * elsewhere for real fetch-staleness semantics. A memo keyed on fetched_at
   * would both miss the write-through case and corrupt those signals.
   */
  private readonly boardMemo = new Map<
    string,
    { rawJson: string; parsed: NotionTask[] }
  >();

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
    const startedAt = Date.now();
    let eligibleCount = 0;
    let dispatched = 0;
    try {
      // Usage admission is an account-wide gate, independent of arm/capacity
      // accounting below: when the plan usage is exhausted, don't dispatch at
      // all this tick — the deferral (persisted by isUsageAdmitted) is
      // re-evaluated automatically on the next tick.
      if (!isUsageAdmitted().allowed) return 0;

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
        activePlanningSessions:
          this.sessionManager.getLivePlanningSessionCount(),
      });
      if (available <= 0) return 0;

      for (const project of orderedProjects) {
        if (dispatched >= available) break;
        await yieldToEventLoop();

        const groomCandidates = await this.scanProjectGroomCandidates(
          project.id,
        );
        eligibleCount += groomCandidates.length;
        dispatched += await this.dispatchUpTo(
          groomCandidates,
          available - dispatched,
          (c) => this.dispatchPlanningCandidate(c, 'groom'),
          (c) => this.revalidateGroomCandidate(c),
        );
        if (dispatched >= available) continue;

        const opsCandidates = await this.scanProjectOpsCandidates(project.id);
        eligibleCount += opsCandidates.length;
        dispatched += await this.dispatchUpTo(
          opsCandidates,
          available - dispatched,
          (c) => this.dispatchOpsCandidate(c),
        );
        if (dispatched >= available) continue;

        const designCandidates = await this.scanProjectDesignCandidates(
          project.id,
        );
        eligibleCount += designCandidates.length;
        dispatched += await this.dispatchUpTo(
          designCandidates,
          available - dispatched,
          (c) => this.dispatchPlanningCandidate(c, 'design'),
          (c) => this.revalidateDesignCandidate(c),
        );
        if (dispatched >= available) continue;

        const docsCandidates = await this.scanProjectDocsCandidates(project.id);
        eligibleCount += docsCandidates.length;
        dispatched += await this.dispatchUpTo(
          docsCandidates,
          available - dispatched,
          (c) => this.dispatchPlanningCandidate(c, 'docs'),
          (c) => this.revalidateDocsCandidate(c),
        );
      }
      return dispatched;
    } finally {
      const elapsedMs = Date.now() - startedAt;
      const skippedCount = eligibleCount - dispatched;
      logger.info(
        `[DispatchTriggerEvaluator] poll complete (eligible=${eligibleCount}, launched=${dispatched}, skipped=${skippedCount}) durationMs=${elapsedMs}`,
      );
    }
  }

  /**
   * Dispatches candidates FIFO until `remaining` sessions have launched or
   * the list is exhausted. When `revalidate` is given, it's re-run
   * immediately before each launch against freshly-read state (task_cache,
   * not a live board round-trip) — a candidate that passed the scan-time
   * predicate but no longer qualifies by launch time (status changed, a
   * session appeared) is skipped rather than dispatched, closing the race
   * between candidate selection and the dispatch call for that candidate.
   * Skipped candidates aren't counted here: the caller's `eligibleCount -
   * dispatched` already reports them, since eligibleCount is fixed at
   * scan time and `dispatched` only grows on an actual launch.
   */
  private async dispatchUpTo<T>(
    candidates: T[],
    remaining: number,
    dispatchFn: (candidate: T) => Promise<boolean>,
    revalidate?: (candidate: T) => boolean | Promise<boolean>,
  ): Promise<number> {
    let dispatched = 0;
    for (const candidate of candidates) {
      if (dispatched >= remaining) break;
      if (revalidate && !(await revalidate(candidate))) continue;
      const launched = await dispatchFn(candidate);
      if (launched) dispatched++;
    }
    return dispatched;
  }

  /**
   * All dependency-cleared, un-dispatched Backlog tasks across a project's
   * non-Done milestones, in board order (FIFO-by-age proxy). With the groom
   * arm set, every Type is in scope, unchanged from before. With the groom
   * arm unset but the design arm set, the pool narrows to design-eligible
   * Types only (per isDesignEligibleType, shared with isDesignCandidate) —
   * this lets design self-feed from Backlog without also promoting unrelated
   * Code tasks. With neither armed, the milestone is skipped entirely.
   */
  private async scanProjectGroomCandidates(
    projectId: string,
  ): Promise<FlowCandidate[]> {
    const candidates: FlowCandidate[] = [];
    const milestones = listMilestonesByProject(projectId).filter(
      (m) => m.wrapped_at == null,
    );
    for (const milestone of milestones) {
      await yieldToEventLoop();
      const groomArmed = getArm(milestone.id, 'groom');
      const designArmed = getArm(milestone.id, 'design');
      if (!groomArmed && !designArmed) continue;
      const tasks = this.loadBoardTasks(milestone.id);
      if (tasks.length === 0) continue;
      const tasksById = new Map(tasks.map((t) => [normalizeBoardId(t.id), t]));
      for (const task of tasks) {
        if (!groomArmed && !isDesignEligibleType(task.type)) continue;
        if (
          isGroomCandidate(task, {
            tasksById,
            resolveDep: (depId) => this.resolveProjectDep(projectId, depId),
            hasActiveSession: hasActiveSessionForTask,
            hasActiveGroomSession: (taskId) =>
              hasActivePlanningSessionForTask(taskId, 'groom'),
            inCrashCooldown: (taskId) => this.crashBudget.inCooldown(taskId),
            isNoOpSuppressed,
            isKillSuppressed: (taskId) =>
              isPlanningKillSuppressed(taskId, 'groom'),
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
      await yieldToEventLoop();
      if (!getArm(milestone.id, 'ops')) continue;
      const tasks = this.loadBoardTasks(milestone.id);
      if (tasks.length === 0) continue;
      const tasksById = new Map(tasks.map((t) => [normalizeBoardId(t.id), t]));
      for (const task of tasks) {
        const candidate = await isOpsCandidate(task, {
          tasksById,
          hasActiveSession: hasActiveSessionForTask,
          hasActiveOpsSession: (taskId) =>
            hasActivePlanningSessionForTask(taskId, 'ops'),
          inCrashCooldown: (taskId) => this.crashBudget.inCooldown(taskId),
          projectId,
          isKillSuppressed: (taskId) => isPlanningKillSuppressed(taskId, 'ops'),
        });
        if (candidate) candidates.push({ projectId, milestone, task });
      }
    }
    return candidates;
  }

  /** All design-armed, dependency-cleared, un-dispatched Ready design/planning tasks across a project's non-Done milestones, in board order. */
  private async scanProjectDesignCandidates(
    projectId: string,
  ): Promise<FlowCandidate[]> {
    const candidates: FlowCandidate[] = [];
    const milestones = listMilestonesByProject(projectId).filter(
      (m) => m.wrapped_at == null,
    );
    for (const milestone of milestones) {
      await yieldToEventLoop();
      const armed = getArm(milestone.id, 'design');
      if (!armed) continue;
      const tasks = this.loadBoardTasks(milestone.id);
      if (tasks.length === 0) continue;
      const tasksById = new Map(tasks.map((t) => [normalizeBoardId(t.id), t]));
      for (const task of tasks) {
        if (
          isDesignCandidate(task, {
            tasksById,
            resolveDep: (depId) => this.resolveProjectDep(projectId, depId),
            hasActiveSession: hasActiveSessionForTask,
            hasActiveDesignSession: (taskId) =>
              hasActivePlanningSessionForTask(taskId, 'design'),
            inCrashCooldown: (taskId) => this.crashBudget.inCooldown(taskId),
            armed,
            isKillSuppressed: (taskId) =>
              isPlanningKillSuppressed(taskId, 'design'),
          })
        ) {
          candidates.push({ projectId, milestone, task });
        }
      }
    }
    return candidates;
  }

  /** All docs-armed, dependency-cleared (Done + deployed), un-dispatched Ready 📝 Docs tasks (never 🎨 Assets) across a project's non-Done milestones, in board order. */
  private async scanProjectDocsCandidates(
    projectId: string,
  ): Promise<FlowCandidate[]> {
    const candidates: FlowCandidate[] = [];
    const milestones = listMilestonesByProject(projectId).filter(
      (m) => m.wrapped_at == null,
    );
    for (const milestone of milestones) {
      await yieldToEventLoop();
      const armed = getArm(milestone.id, 'docs');
      if (!armed) continue;
      const tasks = this.loadBoardTasks(milestone.id);
      if (tasks.length === 0) continue;
      const tasksById = new Map(tasks.map((t) => [normalizeBoardId(t.id), t]));
      for (const task of tasks) {
        const candidate = await isDocsCandidate(task, {
          tasksById,
          hasActiveSession: hasActiveSessionForTask,
          hasActiveDocsSession: (taskId) =>
            hasActivePlanningSessionForTask(taskId, 'docs'),
          inCrashCooldown: (taskId) => this.crashBudget.inCooldown(taskId),
          projectId,
          armed,
        });
        if (candidate) candidates.push({ projectId, milestone, task });
      }
    }
    return candidates;
  }

  /**
   * Project-wide dependency lookup — scans every milestone board of the
   * project (not just the one the current candidate lives on) for a dep id.
   * Milestones are seeded ahead of the previous one completing by design, so
   * a Depends-On legitimately lands on a different milestone's board; the
   * per-board `tasksById` map alone can't see it. Reuses loadBoardTasks'
   * memo, so this is cheap after the first scan of a given board this tick.
   */
  private resolveProjectDep(
    projectId: string,
    depId: string,
  ): NotionTask | undefined {
    const result = resolveProjectDepStatus(projectId, depId, (milestoneId) =>
      this.loadBoardTasks(milestoneId),
    );
    return result.status === 'found' ? result.task : undefined;
  }

  /**
   * Re-runs isGroomCandidate against a fresh task_cache read immediately
   * before launch, closing the scan-vs-launch race: loadBoardTasks re-reads
   * the cache row each call and only reuses the parsed board when its
   * raw_json is byte-identical, so a status/session change that landed in
   * task_cache since the scan is picked up here without a live board fetch.
   * Reuses isGroomCandidate itself (not a hand-written subset) so scan-time
   * and launch-time eligibility can never disagree.
   */
  private revalidateGroomCandidate(candidate: FlowCandidate): boolean {
    const tasks = this.loadBoardTasks(candidate.milestone.id);
    const tasksById = new Map(tasks.map((t) => [normalizeBoardId(t.id), t]));
    const task = tasksById.get(normalizeBoardId(candidate.task.id));
    if (!task) return false;
    return isGroomCandidate(task, {
      tasksById,
      resolveDep: (depId) => this.resolveProjectDep(candidate.projectId, depId),
      hasActiveSession: hasActiveSessionForTask,
      hasActiveGroomSession: (taskId) =>
        hasActivePlanningSessionForTask(taskId, 'groom'),
      inCrashCooldown: (taskId) => this.crashBudget.inCooldown(taskId),
      isNoOpSuppressed,
      isKillSuppressed: (taskId) => isPlanningKillSuppressed(taskId, 'groom'),
    });
  }

  /** Same immediately-before-launch re-check as revalidateGroomCandidate, reusing isDesignCandidate. */
  private revalidateDesignCandidate(candidate: FlowCandidate): boolean {
    const tasks = this.loadBoardTasks(candidate.milestone.id);
    const tasksById = new Map(tasks.map((t) => [normalizeBoardId(t.id), t]));
    const task = tasksById.get(normalizeBoardId(candidate.task.id));
    if (!task) return false;
    return isDesignCandidate(task, {
      tasksById,
      resolveDep: (depId) => this.resolveProjectDep(candidate.projectId, depId),
      hasActiveSession: hasActiveSessionForTask,
      hasActiveDesignSession: (taskId) =>
        hasActivePlanningSessionForTask(taskId, 'design'),
      inCrashCooldown: (taskId) => this.crashBudget.inCooldown(taskId),
      armed: getArm(candidate.milestone.id, 'design'),
      isKillSuppressed: (taskId) => isPlanningKillSuppressed(taskId, 'design'),
    });
  }

  /** Same immediately-before-launch re-check as revalidateGroomCandidate, reusing isDocsCandidate. */
  private async revalidateDocsCandidate(
    candidate: FlowCandidate,
  ): Promise<boolean> {
    const tasks = this.loadBoardTasks(candidate.milestone.id);
    const tasksById = new Map(tasks.map((t) => [normalizeBoardId(t.id), t]));
    const task = tasksById.get(normalizeBoardId(candidate.task.id));
    if (!task) return false;
    return isDocsCandidate(task, {
      tasksById,
      hasActiveSession: hasActiveSessionForTask,
      hasActiveDocsSession: (taskId) =>
        hasActivePlanningSessionForTask(taskId, 'docs'),
      inCrashCooldown: (taskId) => this.crashBudget.inCooldown(taskId),
      projectId: candidate.projectId,
      armed: getArm(candidate.milestone.id, 'docs'),
    });
  }

  private loadBoardTasks(milestoneId: string): NotionTask[] {
    const key = `board:${milestoneId}`;
    const row = getTaskCache(key);
    if (!row) return [];
    const memo = this.boardMemo.get(key);
    if (memo && memo.rawJson === row.raw_json) return memo.parsed;
    let parsed: NotionTask[];
    try {
      parsed = JSON.parse(row.raw_json) as NotionTask[];
    } catch {
      parsed = [];
    }
    this.boardMemo.set(key, { rawJson: row.raw_json, parsed });
    return parsed;
  }

  /** Shared groom/design/docs dispatch via dispatchPlanningFlow's manual-PlanningTaskEntry path. */
  private async dispatchPlanningCandidate(
    candidate: FlowCandidate,
    flow: 'groom' | 'design' | 'docs',
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
      const payload: PlanningDispatchLaunchedPayload = {
        trigger_source: 'evaluator',
        flow,
        milestone_id: milestone.id,
      };
      recordEvent({
        event_type: 'planning_dispatch_launched',
        actor_type: 'system',
        project_id: candidate.projectId,
        task_id: candidate.task.id,
        payload: { ...payload },
      });
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
      (t) => normalizeBoardId(t.id) === normalizeBoardId(candidate.task.id),
    );
    // Not in the live executable worklist (status/dep-gate changed since the
    // cached-board scan) — skip this tick rather than force a stale dispatch.
    if (!entry) {
      logger.warn(
        `[DispatchTriggerEvaluator] ops candidate task ${candidate.task.id} not found in executable worklist for milestone ${milestone.id} after normalization — skipping this tick`,
      );
      return false;
    }

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
      const payload: PlanningDispatchLaunchedPayload = {
        trigger_source: 'evaluator',
        flow: 'ops',
        milestone_id: milestone.id,
      };
      recordEvent({
        event_type: 'planning_dispatch_launched',
        actor_type: 'system',
        project_id: candidate.projectId,
        task_id: candidate.task.id,
        payload: { ...payload },
      });
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
