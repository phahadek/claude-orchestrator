import type { TaskTrackerBackend } from './TaskTrackerBackend';
import type { ResolvedTask } from '../notion/types';
import { NotionClient } from '../notion/NotionClient';

/**
 * Notion-backed implementation of TaskTrackerBackend.
 * Thin adapter — all logic stays in NotionClient.
 */
export class NotionTaskBackend implements TaskTrackerBackend {
  readonly type = 'notion' as const;

  constructor(private readonly client: NotionClient) {}

  fetchReadyTasks(boardId: string, skipCache?: boolean): Promise<ResolvedTask[]> {
    return this.client.fetchReadyTasks(boardId, skipCache);
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
