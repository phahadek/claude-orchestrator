import type {
  TaskBackend,
  NonMilestoneSourceConfig,
  NewTaskFields,
  TaskPropertiesPatch,
} from './TaskBackend';
import type { ResolvedTask } from './types';
import type { NotionTask } from '../notion/types';
import { formatTaskId, normalizeTaskId } from './taskId';
import { NotionClient } from '../notion/NotionClient';
import { ProjectService } from '../projects/ProjectService';
import {
  upsertTaskCache,
  getTaskCache,
  getTasksByStatusFromCache,
} from '../db/queries';
import { renderTaskBody, type TaskBodySections } from './bodyRender';

/**
 * Notion-backed implementation of TaskBackend. Resolves the Notion database ID
 * from the milestone row's `source_id`, then delegates to NotionClient.
 *
 * Public methods that take a `taskId` accept either an already-prefixed task
 * ID (e.g. 'notion:abc123') or a raw Notion UUID, and normalize it to
 * `notion:<id>` before calling into NotionClient/cache lookups.
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
    // Keyed on the DB milestone UUID (not source_id) so the cache key scheme
    // matches every other backend and stays project-scoped by construction.
    upsertTaskCache(
      `board:${milestoneId}`,
      JSON.stringify(prefixed.map((r) => r.task)),
    );
    return prefixed;
  }

  async attachPR(taskId: string, prUrl: string): Promise<void> {
    return this.client.attachPR(normalizeTaskId(taskId), prUrl);
  }

  async updateStatus(taskId: string, status: string): Promise<void> {
    return this.client.updateStatus(normalizeTaskId(taskId), status);
  }

  async fetchTaskPage(taskId: string): Promise<string> {
    const page = await this.client.fetchTaskPage(normalizeTaskId(taskId));
    return page.rawMarkdown;
  }

  async updateNotes(taskId: string, notes: string): Promise<void> {
    return this.client.updateNotes(normalizeTaskId(taskId), notes);
  }

  async appendImplementationNote(taskId: string, note: string): Promise<void> {
    return this.client.appendImplementationNote(
      normalizeTaskId(taskId),
      note,
    );
  }

  async listTasksByStatus(status: string): Promise<ResolvedTask[]> {
    const rows = getTasksByStatusFromCache(status, 'notion:');
    const results: ResolvedTask[] = [];
    for (const row of rows) {
      try {
        const task = JSON.parse(row.raw_json) as NotionTask;
        results.push({
          task,
          source: 'notion' as const,
          blocked: false,
          blockers: [],
          nonCode: false,
          wave: 0,
        });
      } catch {
        // skip malformed cache entries
      }
    }
    return results;
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

  async createTask(fields: NewTaskFields): Promise<string> {
    const task = await this.client.createTask(fields.databaseId, {
      title: fields.title,
      type: fields.type,
      priority: fields.priority,
      dependsOn: fields.dependsOn,
    });
    const prefixedId = formatTaskId('notion', task.id);
    const prefixedDependsOn = task.dependsOn.map((dep) =>
      formatTaskId('notion', dep),
    );
    upsertTaskCache(
      prefixedId,
      JSON.stringify({ ...task, id: prefixedId, dependsOn: prefixedDependsOn }),
    );
    return prefixedId;
  }

  async setDependsOn(taskId: string, dependsOn: string[]): Promise<void> {
    const normalizedId = normalizeTaskId(taskId);
    await this.client.setDependsOn(normalizedId, dependsOn);
    const row = getTaskCache(normalizedId);
    if (!row) return;
    try {
      const parsed = JSON.parse(row.raw_json);
      parsed.dependsOn = dependsOn;
      upsertTaskCache(normalizedId, JSON.stringify(parsed));
    } catch {
      // ignore malformed cache entries
    }
  }

  async updateBody(taskId: string, sections: TaskBodySections): Promise<void> {
    const blocks = renderTaskBody(sections);
    await this.client.updateBody(normalizeTaskId(taskId), blocks);
  }

  async setType(taskId: string, type: string): Promise<void> {
    const normalizedId = normalizeTaskId(taskId);
    await this.client.setType(normalizedId, type);
    const row = getTaskCache(normalizedId);
    if (!row) return;
    try {
      const parsed = JSON.parse(row.raw_json);
      parsed.type = type;
      upsertTaskCache(normalizedId, JSON.stringify(parsed));
    } catch {
      // ignore malformed cache entries
    }
  }

  async setProperties(
    taskId: string,
    patch: TaskPropertiesPatch,
  ): Promise<void> {
    const normalizedId = normalizeTaskId(taskId);
    await this.client.setProperties(normalizedId, patch);
    const row = getTaskCache(normalizedId);
    if (!row) return;
    try {
      const parsed = JSON.parse(row.raw_json);
      if (patch.priority !== undefined) parsed.priority = patch.priority;
      if (patch.title !== undefined) parsed.title = patch.title;
      upsertTaskCache(normalizedId, JSON.stringify(parsed));
    } catch {
      // ignore malformed cache entries
    }
  }

  async archive(taskId: string): Promise<void> {
    await this.client.archive(normalizeTaskId(taskId));
  }
}
