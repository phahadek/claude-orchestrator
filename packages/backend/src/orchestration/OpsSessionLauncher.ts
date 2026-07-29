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
import { loadGroomContext, GroomTaskSourceUnsupportedError } from '../groom/groomLoad';
import { loadDesignContext } from '../design/designLoad';
import { getProjectRowById } from '../db/queries';
import { resolveMilestoneForProject } from '../projects/milestoneResolver';
import { isPlanningSession } from '../session/sessionPredicates';
import { toExternalId, normalizeTaskId } from '../tasks/taskId';

/** Strips a `source:` prefix for URL-building; falls back to the raw id if unprefixed. */
function bareTaskId(id: string): string {
  try {
    return toExternalId(id);
  } catch {
    return id;
  }
}
import {
  assemblePlanningProcedure,
  deriveGroomDigestSlice,
  deriveDesignDigestSlice,
  deriveOpsDigestSlice,
  GroomWorklistTaskNotFoundError,
  type PlanningDigest,
} from '../planning/procedureAssembler';

const POLL_INTERVAL_MS = 15_000;

// ── TaskCacheRefresher hook ───────────────────────────────────────────────────
// Same seam TaskWriteCommands.ts uses — without it, a freshly launched planning
// session's task.planningSession stays null in the task cache until the next
// scheduled TaskCacheRefresher tick, so it doesn't appear inline right away.
let refreshProjectFn:
  | ((projectId: string, skipCache?: boolean) => Promise<void>)
  | null = null;

export function setOpsSessionLauncherRefreshFn(
  fn: (projectId: string, skipCache?: boolean) => Promise<void>,
): void {
  refreshProjectFn = fn;
}

/**
 * Session types dispatched by this launcher — see planningLaunch.ts's
 * workflow -> sessionType resolution.
 */
export type PlanningSessionType =
  | 'groom'
  | 'design'
  | 'ops'
  | 'split'
  | 'standard';

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

/**
 * Human-facing session name for a planning dispatch: `<Prefix>: <title>` so
 * the dashboard shows what the session is and what it's grooming/designing,
 * never a raw task id or url. sessionTypes without a defined prefix (e.g.
 * 'standard', 'split') keep the bare title, unchanged from prior behavior.
 */
function formatPlanningSessionName(
  sessionType: PlanningSessionType,
  title: string,
): string {
  switch (sessionType) {
    case 'groom':
      return `Grooming: ${title}`;
    case 'design':
      return `Design: ${title}`;
    case 'ops':
      return `Ops: ${title}`;
    default:
      return title;
  }
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
  failed: { taskId: string; reason: string }[];
}

export type LaunchOutcome =
  | { status: 'launched'; taskId: string; sessionId: string }
  | { status: 'deferred'; taskId: string; blockedBy: string[] }
  | { status: 'failed'; taskId: string; reason: string };

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
    const failed: { taskId: string; reason: string }[] = [];
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
      const outcome = await this.launchOne(
        params.projectId,
        params.projectContextUrl,
        params.milestoneId,
        sessionType,
        params.opsContext,
        task,
        params.model,
        params.effort,
      );
      if (outcome.status === 'launched') {
        launched.push(outcome.taskId);
      } else if (outcome.status === 'failed') {
        failed.push({ taskId: outcome.taskId, reason: outcome.reason });
      }
    }

    return { launched, deferred: deferredIds, failed };
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
   * Load the groom digest for `taskId`, reconciling the worklist against a
   * cache miss: `loadGroomContext` reads Notion's board through NotionClient's
   * ~60s board cache, so a task created/moved to Backlog just before dispatch
   * can be absent from the first read even though it's genuinely groomable.
   * On a not-found, retry once with `skipCache: true` to force a fresh board
   * read before concluding the task truly isn't in the worklist.
   */
  private async loadGroomDigestReconciling(
    milestoneKey: string,
    repoRoot: string,
    taskId: string,
    projectId: string,
  ) {
    const result = await loadGroomContext(milestoneKey, {
      repoRoot,
      projectId,
    });
    try {
      return deriveGroomDigestSlice(result, taskId, milestoneKey);
    } catch (err) {
      if (!(err instanceof GroomWorklistTaskNotFoundError)) throw err;
      logger.info(
        `[OpsSessionLauncher] task ${taskId} missing from groom worklist on first read — refreshing worklist and retrying`,
      );
      const refreshed = await loadGroomContext(milestoneKey, {
        repoRoot,
        projectId,
        skipCache: true,
      });
      return deriveGroomDigestSlice(refreshed, taskId, milestoneKey);
    }
  }

  /**
   * Load this workflow's per-task digest and assemble the injected planning
   * procedure (`planning/procedureAssembler.ts`) for a groom/design/ops
   * dispatch. Any assembly failure — including `GroomWorklistTaskNotFoundError`
   * — propagates to the caller, which aborts the dispatch instead of
   * launching a session that then dies one hop later on SessionManager's
   * generic no-injectedProcedureContent fail-loud. Falling back to the
   * code-session context build here would be wrong: it would inject the
   * implement/PR coding scaffold into a worktree-less planning session. Also
   * surfaces the digest's resolved task title (groom/design load real titles
   * even when the caller only had the bare task id) so the session can be
   * named after it instead of the id.
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
        digest = {
          workflow: 'groom',
          data: await this.loadGroomDigestReconciling(
            milestoneKey,
            project.project_dir,
            task.id,
            projectId,
          ),
        };
      } else if (sessionType === 'split') {
        const project = getProjectRowById(projectId);
        if (!project) throw new Error(`unknown project ${projectId}`);
        const milestoneKey = resolveMilestoneForProject(projectId, milestoneId);
        digest = {
          workflow: 'split',
          data: await this.loadGroomDigestReconciling(
            milestoneKey,
            project.project_dir,
            task.id,
            projectId,
          ),
        };
      } else if (sessionType === 'design') {
        const project = getProjectRowById(projectId);
        if (!project) throw new Error(`unknown project ${projectId}`);
        const result = await loadDesignContext(milestoneId, task.id, {
          repoRoot: project.project_dir,
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
        milestoneId,
        projectId,
      });
      return { content, title: resolvedTitle };
    } catch (err) {
      if (err instanceof GroomWorklistTaskNotFoundError) throw err;
      if (err instanceof GroomTaskSourceUnsupportedError) throw err;
      throw new Error(
        `failed to assemble planning procedure for task ${task.id} (${sessionType}): ${err instanceof Error ? err.message : err}`,
        { cause: err },
      );
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
  ): Promise<LaunchOutcome> {
    const taskUrl =
      task.url ||
      `https://www.notion.so/${bareTaskId(task.id).replace(/-/g, '')}`;
    let injectedProcedure: { content: string; title?: string } | undefined;
    if (isPlanningSession(sessionType)) {
      try {
        injectedProcedure = await this.buildInjectedProcedure(
          projectId,
          milestoneId,
          sessionType,
          opsContext,
          task,
          taskUrl,
        );
      } catch (err) {
        // Abort before creating any session — a planning session with no
        // injectedProcedureContent is a guaranteed, one-hop-later refusal
        // in SessionManager.completeStart, and that refusal misattributes
        // the failure as a code mis-wire instead of surfacing the real
        // assembly error. Fail the dispatch here instead, with the actual
        // reason — this also covers GroomTaskSourceUnsupportedError (refusing
        // a groom dispatch for a non-Notion project) and
        // GroomWorklistTaskNotFoundError (a worklist-miss), both rethrown
        // raw (unwrapped) by buildInjectedProcedure so their reason stays
        // distinguishable from a generic assembly failure.
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[OpsSessionLauncher] skipping ${sessionType} dispatch for task ${task.id}: ${reason}`,
        );
        return { status: 'failed', taskId: task.id, reason };
      }
    }
    const injectedProcedureContent = injectedProcedure?.content;
    const resolvedTitle = injectedProcedure?.title || task.title || task.id;
    const taskName = formatPlanningSessionName(sessionType, resolvedTitle);
    try {
      const sessionId = await this.sessionManager.start(
        taskUrl,
        projectContextUrl,
        {
          projectId,
          taskName,
          milestoneId,
          taskKind: 'milestone',
          taskId: normalizeTaskId(task.id),
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
      if (refreshProjectFn) {
        void refreshProjectFn(projectId, true).catch((err: unknown) => {
          logger.warn(
            `[OpsSessionLauncher] cache refresh after launch failed for project ${projectId}: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
      return { status: 'launched', taskId: task.id, sessionId };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[OpsSessionLauncher] failed to launch ops task ${task.id}: ${reason}`,
      );
      return { status: 'failed', taskId: task.id, reason };
    }
  }
}
