import type { TaskBackend, NonMilestoneSourceConfig } from './TaskBackend';
import type { ResolvedTask } from './types';
import { formatTaskId } from './taskId';
import { NotionClient } from '../notion/NotionClient';
import { ProjectService } from '../projects/ProjectService';
import { upsertTaskCache } from '../db/queries';

/**
 * Notion-backed implementation of TaskBackend. Resolves the Notion database ID
 * from the milestone row's `source_id`, then delegates to NotionClient.
 *
 * All public methods accept prefixed task IDs (e.g. 'notion:abc123') and strip
 * the prefix before calling the Notion API.
 */
export class NotionTaskBackend implements TaskBackend {
  readonly type = 'notion' as const;

  constructor(private readonly client: NotionClient) {}

  async fetchReadyTasks(
    milestoneId: string | null,
    skipCache?: boolean,
  ): Promise<ResolvedTask[]> {
    if (milestoneId === null) {
      throw new Error(
        `[NotionTaskBackend] milestoneId is required for Notion projects`,
      );
    }
    const milestone = ProjectService.getMilestone(milestoneId);
    if (!milestone) {
      throw new Error(
        `[NotionTaskBackend] milestone not found: ${milestoneId}`,
      );
    }
    if (!milestone.sourceId) {
      throw new Error(
        `[NotionTaskBackend] milestone ${milestoneId} has no source_id — set it to the Notion database ID`,
      );
    }
    const tasks = await this.client.fetchReadyTasks(
      milestone.sourceId,
      skipCache,
    );
    const prefixed = tasks.map((r) => {
      const prefixedId = formatTaskId('notion', r.task.id);
      const prefixedDependsOn = r.task.dependsOn.map((dep) =>
        formatTaskId('notion', dep),
      );
      // Also cache under the prefixed key so getTaskTitleFromCache works with
      // prefixed session.task_id lookups.
      upsertTaskCache(
        prefixedId,
        JSON.stringify({
          ...r.task,
          id: prefixedId,
          dependsOn: prefixedDependsOn,
        }),
      );
      return {
        ...r,
        task: { ...r.task, id: prefixedId, dependsOn: prefixedDependsOn },
        source: 'notion' as const,
      };
    });
    // Overwrite board cache with prefixed IDs so /api/tasks/active joins correctly
    // against per-task rows (fixes post-D3 mismatch where raw IDs were stored).
    upsertTaskCache(
      `board:${milestone.sourceId}`,
      JSON.stringify(prefixed.map((r) => r.task)),
    );
    return prefixed;
  }

  async attachPR(taskId: string, prUrl: string): Promise<void> {
    return this.client.attachPR(taskId, prUrl);
  }

  async updateStatus(taskId: string, status: string): Promise<void> {
    return this.client.updateStatus(taskId, status);
  }

  async fetchTaskPage(taskId: string): Promise<string> {
    const page = await this.client.fetchTaskPage(taskId);
    return page.rawMarkdown;
  }

  async fetchNonMilestoneReadyTasks(
    sourceConfig: NonMilestoneSourceConfig | null,
    projectId?: string,
  ): Promise<ResolvedTask[]> {
    if (!sourceConfig?.notionDatabaseId) return [];
    const tasks = await this.client.fetchReadyTasks(
      sourceConfig.notionDatabaseId,
      true,
    );
    const resolved = tasks.map((r) => {
      const prefixedId = formatTaskId('notion', r.task.id);
      const prefixedDependsOn = r.task.dependsOn.map((dep) =>
        formatTaskId('notion', dep),
      );
      upsertTaskCache(
        prefixedId,
        JSON.stringify({
          ...r.task,
          id: prefixedId,
          dependsOn: prefixedDependsOn,
        }),
      );
      return {
        ...r,
        task: { ...r.task, id: prefixedId, dependsOn: prefixedDependsOn },
        source: 'notion' as const,
      };
    });
    // Cache full task list under the project's non-milestone key so the HTTP endpoint can serve it.
    if (projectId) {
      upsertTaskCache(
        `non_milestone:${projectId}`,
        JSON.stringify(resolved.map((r) => r.task)),
      );
    }
    return resolved;
  }
}
