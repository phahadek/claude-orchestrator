import { logger } from '../logger';
import type { SessionManager } from '../session/SessionManager';
import type { Scheduler } from './Scheduler';
import {
  loadOpsContext,
  type OpsLoadResult,
  type OpsTaskEntry,
} from '../ops/opsLoad';
import { buildOpsSessionContext } from '../ops/opsSessionContext';
import { getEntry as getOpsJournalEntry } from '../ops/opsJournal';
import { loadGroomContext } from '../groom/groomLoad';
import { loadDesignContext } from '../design/designLoad';
import { getProjectRowById } from '../db/queries';
import { resolveMilestoneForProject } from '../projects/milestoneResolver';
import { isPlanningSession } from '../session/sessionPredicates';
import {
  assemblePlanningProcedure,
  deriveGroomDigestSlice,
  deriveDesignDigestSlice,
  deriveOpsDigestSlice,
  type PlanningDigest,
} from '../planning/procedureAssembler';

const POLL_INTERVAL_MS = 15_000;

/**
 * Session types dispatched by this launcher — see planningLaunch.ts's
 * workflow -> sessionType resolution.
 */
export type PlanningSessionType = 'groom' | 'design' | 'ops' | 'standard';

/**
 * Minimal per-task shape this launcher needs to dispatch a session.
 * `OpsTaskEntry` (richer, ops-specific) structurally satisfies this.
 */
export interface PlanningTaskEntry {
  id: string;
  title: string;
  url: string;
  blockingDepIds: string[];
}

export interface OpsLaunchParams {
  projectId: string;
  projectContextUrl: string;
  milestoneId: string;
  /** Defaults to 'standard' — the pre-existing Ops(N) dispatch behavior. */
  sessionType?: PlanningSessionType;
  /**
   * Present for the ops/investigation dispatch path, which injects rich
   * classification + journal context per task. Omitted for groom/design,
   * which have no ops-specific context to inject.
   */
  opsContext?: OpsLoadResult;
  tasks: PlanningTaskEntry[];
  /** Per-launch model/effort override, forwarded to SessionManager.start(). */
  model?: string;
  effort?: string;
}

export interface OpsLaunchResult {
  launched: string[];
  deferred: string[];
}

interface DeferredOpsTask {
  projectId: string;
  projectContextUrl: string;
  milestoneId: string;
  sessionType: PlanningSessionType;
  opsContext?: OpsLoadResult;
  task: PlanningTaskEntry;
  model?: string;
  effort?: string;
}

/**
 * Human-triggered per-task planning session launcher behind the Groom(N) /
 * Ops(N) buttons — the individual-session replacement for the old combined
 * ops run, generalized to dispatch whichever planning session type the
 * caller resolves (groom/design/ops via /api/planning/launch). Each selected
 * task launches its own session via SessionManager.start(), the same code
 * path as a manual UI launch. A task whose Depends On isn't all ✅ Done is
 * deferred and retried on the next poll, mirroring AutoLauncher's Depends-On
 * gate — but only for tasks a human already selected. Nothing here is
 * auto-dispatched onto tasks the operator didn't pick.
 */
export class OpsSessionLauncher {
  private readonly deferred = new Map<string, DeferredOpsTask>();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly options: {
      loadOpsContext?: typeof loadOpsContext;
    } = {},
  ) {}

  async launchSelected(params: OpsLaunchParams): Promise<OpsLaunchResult> {
    const launched: string[] = [];
    const deferredIds: string[] = [];
    const sessionType = params.sessionType ?? 'standard';

    for (const task of params.tasks) {
      if (task.blockingDepIds.length > 0) {
        this.deferred.set(task.id, {
          projectId: params.projectId,
          projectContextUrl: params.projectContextUrl,
          milestoneId: params.milestoneId,
          sessionType,
          opsContext: params.opsContext,
          task,
          model: params.model,
          effort: params.effort,
        });
        deferredIds.push(task.id);
        logger.info(
          `[OpsSessionLauncher] deferring ops task ${task.id} — waiting on ${task.blockingDepIds.join(', ')}`,
        );
        continue;
      }
      await this.launchOne(
        params.projectId,
        params.projectContextUrl,
        params.milestoneId,
        sessionType,
        params.opsContext,
        task,
        params.model,
        params.effort,
      );
      launched.push(task.id);
    }

    return { launched, deferred: deferredIds };
  }

  hasDeferred(taskId: string): boolean {
    return this.deferred.has(taskId);
  }

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'ops_session_launcher',
      intervalMs: () => POLL_INTERVAL_MS,
      concurrency: 'skip-if-running',
      run: async () => {
        await this.pollOnce();
      },
    });
  }

  /** Re-check every deferred task's dependency status and launch any now-unblocked ones. */
  async pollOnce(): Promise<void> {
    if (this.deferred.size === 0) return;
    const loadContext = this.options.loadOpsContext ?? loadOpsContext;
    const milestoneIds = new Set(
      [...this.deferred.values()].map((d) => d.milestoneId),
    );

    for (const milestoneId of milestoneIds) {
      let opsContext: OpsLoadResult;
      try {
        opsContext = await loadContext(milestoneId);
      } catch (err) {
        logger.warn(
          `[OpsSessionLauncher] poll: failed to load ops context for milestone ${milestoneId}: ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
      const readyIds = new Set(
        opsContext.worklist.executable
          .filter((t) => t.depStatus === 'ready')
          .map((t) => t.id),
      );

      for (const [taskId, entry] of [...this.deferred]) {
        if (entry.milestoneId !== milestoneId) continue;
        if (!readyIds.has(taskId)) continue;
        this.deferred.delete(taskId);
        await this.launchOne(
          entry.projectId,
          entry.projectContextUrl,
          entry.milestoneId,
          entry.sessionType,
          opsContext,
          entry.task,
          entry.model,
          entry.effort,
        );
      }
    }
  }

  /**
   * Load this workflow's per-task digest and assemble the injected planning
   * procedure (`planning/procedureAssembler.ts`) for a groom/design/ops
   * dispatch. Returns undefined (never throws) on any loader failure — the
   * session still launches, falling back to the code-session context build
   * in that case, but a warning is logged so the gap is visible. Also
   * surfaces the digest's resolved task title (groom/design load real
   * titles even when the caller only had the bare task id) so the session
   * can be named after it instead of the id.
   */
  private async buildInjectedProcedure(
    projectId: string,
    milestoneId: string,
    sessionType: PlanningSessionType,
    opsContext: OpsLoadResult | undefined,
    task: PlanningTaskEntry,
    taskUrl: string,
  ): Promise<{ content: string; title?: string } | undefined> {
    try {
      let digest: PlanningDigest;
      if (sessionType === 'groom') {
        const project = getProjectRowById(projectId);
        if (!project) throw new Error(`unknown project ${projectId}`);
        const milestoneKey = resolveMilestoneForProject(projectId, milestoneId);
        const result = await loadGroomContext(milestoneKey, {
          repoRoot: project.project_dir,
        });
        digest = {
          workflow: 'groom',
          data: deriveGroomDigestSlice(result, task.id),
        };
      } else if (sessionType === 'design') {
        const result = await loadDesignContext(milestoneId, task.id, {
          project: projectId,
        });
        digest = { workflow: 'design', data: deriveDesignDigestSlice(result) };
      } else if (sessionType === 'ops') {
        if (!opsContext)
          throw new Error('ops session launched without opsContext');
        const journalEntry = getOpsJournalEntry(task.id) ?? null;
        digest = {
          workflow: 'ops',
          data: deriveOpsDigestSlice(opsContext, task.id, journalEntry),
        };
      } else {
        return undefined;
      }
      const resolvedTitle = digest.data.task.title;
      const content = assemblePlanningProcedure({
        taskName: resolvedTitle || task.title || taskUrl,
        taskUrl,
        digest,
      });
      return { content, title: resolvedTitle };
    } catch (err) {
      logger.warn(
        `[OpsSessionLauncher] failed to assemble planning procedure for task ${task.id} (${sessionType}): ${err instanceof Error ? err.message : err}`,
      );
      return undefined;
    }
  }

  private async launchOne(
    projectId: string,
    projectContextUrl: string,
    milestoneId: string,
    sessionType: PlanningSessionType,
    opsContext: OpsLoadResult | undefined,
    task: PlanningTaskEntry,
    model?: string,
    effort?: string,
  ): Promise<void> {
    const taskUrl =
      task.url || `https://www.notion.so/${task.id.replace(/-/g, '')}`;
    const injectedProcedure = isPlanningSession(sessionType)
      ? await this.buildInjectedProcedure(
          projectId,
          milestoneId,
          sessionType,
          opsContext,
          task,
          taskUrl,
        )
      : undefined;
    const injectedProcedureContent = injectedProcedure?.content;
    const taskName = injectedProcedure?.title || task.title || taskUrl;
    try {
      const sessionId = await this.sessionManager.start(
        taskUrl,
        projectContextUrl,
        {
          projectId,
          taskName,
          milestoneId,
          taskKind: 'milestone',
          taskId: task.id,
          sessionType,
          ...(opsContext && {
            opsContext: buildOpsSessionContext(
              opsContext,
              task as OpsTaskEntry,
            ),
          }),
          ...(injectedProcedureContent && { injectedProcedureContent }),
          ...(model && { model }),
          ...(effort && { effort }),
        },
      );
      logger.info(
        `[OpsSessionLauncher] launched session ${sessionId.slice(0, 8)} for ops task ${task.id}`,
      );
    } catch (err) {
      logger.warn(
        `[OpsSessionLauncher] failed to launch ops task ${task.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
