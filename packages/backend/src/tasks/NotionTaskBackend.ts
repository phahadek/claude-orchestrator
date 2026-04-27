import type { TaskBackend } from './TaskBackend';
import type { ResolvedTask } from '../notion/types';
import { NotionClient } from '../notion/NotionClient';
import { ProjectService } from '../projects/ProjectService';

/**
 * Notion-backed implementation of TaskBackend. Resolves the Notion database ID
 * from the milestone row's `source_id`, then delegates to NotionClient.
 */
export class NotionTaskBackend implements TaskBackend {
  readonly type = 'notion' as const;

  constructor(private readonly client: NotionClient) {}

  async fetchReadyTasks(milestoneId: string, skipCache?: boolean): Promise<ResolvedTask[]> {
    const milestone = ProjectService.getMilestone(milestoneId);
    if (!milestone) {
      throw new Error(`[NotionTaskBackend] milestone not found: ${milestoneId}`);
    }
    if (!milestone.sourceId) {
      throw new Error(
        `[NotionTaskBackend] milestone ${milestoneId} has no source_id — set it to the Notion database ID`,
      );
    }
    return this.client.fetchReadyTasks(milestone.sourceId, skipCache);
  }

  attachPR(taskId: string, prUrl: string): Promise<void> {
    return this.client.attachPR(taskId, prUrl);
  }

  updateStatus(taskId: string, status: string): Promise<void> {
    return this.client.updateStatus(taskId, status);
  }

  async fetchTaskPage(taskId: string): Promise<string> {
    const page = await this.client.fetchTaskPage(taskId);
    return page.rawMarkdown;
  }
}
