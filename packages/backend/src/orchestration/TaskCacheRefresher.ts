import { logger } from '../logger';
import { getAllProjects, runtimeSettings } from '../config';
import type { ProjectConfig } from '../config';
import type { ServerMessage } from '../ws/types';
import { getTaskBackend } from '../tasks/TaskBackend';
import type { TaskBackend } from '../tasks/TaskBackend';
import { JiraApiError } from '../tasks/JiraClient';
import { ProjectService } from '../projects/ProjectService';
import { runWithConcurrency } from '../utils/concurrency';
import type { Scheduler } from './Scheduler';

const MIN_REFRESH_INTERVAL_MS = 10_000;
const JIRA_MIN_REFRESH_INTERVAL_MS = 120_000;
const PROJECT_CONCURRENCY = 5;

/**
 * Background service that refreshes the per-project board cache on a fixed interval
 * without blocking any HTTP or WS request path. After each successful project refresh,
 * it broadcasts `task_cache_updated` so connected frontends can re-read the cache.
 */
export class TaskCacheRefresher {
  // Per-project throttle gate for Jira (epoch ms after which a project may refresh again).
  private readonly jiraNextAllowed = new Map<string, number>();

  constructor(
    private readonly broadcast?: (msg: ServerMessage) => void,
    private readonly options: {
      listProjects?: () => ProjectConfig[];
      resolveBackend?: (projectId: string) => TaskBackend;
    } = {},
  ) {}

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'task_cache_refresher',
      intervalMs: () =>
        Math.max(
          MIN_REFRESH_INTERVAL_MS,
          runtimeSettings.task_cache_refresh_interval_ms,
        ),
      concurrency: 'skip-if-running',
      run: async () => {
        await this.refreshOnce();
      },
    });
  }

  async refreshOnce(): Promise<void> {
    const start = Date.now();
    const listProjects = this.options.listProjects ?? getAllProjects;
    // Warm notion, github, and jira projects; skip yaml (no remote backend).
    // Jira projects in their rate-limit backoff window are skipped this cycle.
    const projects = listProjects().filter((p) => {
      if (p.taskSource === 'yaml') return false;
      if (p.taskSource === 'jira') {
        return start >= (this.jiraNextAllowed.get(p.id) ?? 0);
      }
      return true;
    });
    logger.info(
      `[TaskCacheRefresher] refresh start projects=${projects.length}`,
    );
    try {
      await runWithConcurrency(projects, PROJECT_CONCURRENCY, (project) =>
        this.refreshProject(project),
      );
    } finally {
      logger.info(
        `[TaskCacheRefresher] refresh complete projects=${projects.length} durationMs=${Date.now() - start}`,
      );
    }
  }

  async refreshProjectById(projectId: string): Promise<void> {
    const listProjects = this.options.listProjects ?? getAllProjects;
    const project = listProjects().find((p) => p.id === projectId);
    if (!project) return;
    await this.refreshProject(project);
  }

  private async refreshProject(project: ProjectConfig): Promise<void> {
    const resolveBackend = this.options.resolveBackend ?? getTaskBackend;
    let backend: TaskBackend;
    try {
      backend = resolveBackend(project.id);
    } catch {
      return;
    }

    const milestones = ProjectService.listMilestones(project.id).filter(
      (m) => m.sourceId,
    );

    for (const milestone of milestones) {
      try {
        const tasks = await backend.fetchReadyTasks(milestone.id);
        this.broadcast?.({
          type: 'task_cache_updated',
          projectId: project.id,
          boardId: milestone.id,
          taskCount: tasks.length,
          refreshedAt: Date.now(),
        });
      } catch (err) {
        if (err instanceof JiraApiError && err.statusCode === 429) {
          const backoffMs = Math.max(
            JIRA_MIN_REFRESH_INTERVAL_MS,
            err.retryAfterMs ?? 0,
          );
          this.jiraNextAllowed.set(project.id, Date.now() + backoffMs);
          logger.warn(
            `[TaskCacheRefresher] Jira 429 for project=${project.id} — backing off ${backoffMs}ms`,
          );
          break;
        }
        logger.warn(
          `[TaskCacheRefresher] failed to refresh project=${project.id} milestone=${milestone.id}: ${String(err)}`,
        );
      }
    }

    if (project.nonMilestoneSourceConfig?.notionDatabaseId) {
      try {
        await backend.fetchNonMilestoneReadyTasks(
          project.nonMilestoneSourceConfig,
          project.id,
        );
        this.broadcast?.({
          type: 'task_cache_updated',
          projectId: project.id,
          boardId: '__non_milestone__',
          taskCount: 0,
          refreshedAt: Date.now(),
        });
      } catch (err) {
        logger.warn(
          `[TaskCacheRefresher] failed to refresh non-milestone project=${project.id}: ${String(err)}`,
        );
      }
    }
  }
}
