import type { TaskBackend } from './TaskBackend';
import type { ResolvedTask } from './types';
import type { NotionTask } from '../notion/types';
import { formatTaskId, toExternalId } from './taskId';
import { JiraClient } from './JiraClient';
import { DependencyResolver } from '../notion/DependencyResolver';
import { upsertTaskCache } from '../db/queries';

export interface JiraProjectConfig {
  host: string;
  project_key: string;
  /** Full JQL override. When set, ready_statuses is ignored for fetchReadyTasks. */
  default_jql?: string;
  /** Jira status names that map to "ready to launch". Defaults to DEFAULT_READY_STATUSES. */
  ready_statuses?: string[];
  /**
   * Maps orchestrator display statuses (emoji-prefixed) to Jira status names.
   * Defaults to DEFAULT_STATUS_MAPPING.
   */
  status_mapping?: Record<string, string>;
}

const DEFAULT_READY_STATUSES = ['To Do', 'Ready'];

const DEFAULT_STATUS_MAPPING: Record<string, string> = {
  '🔲 Backlog': 'Backlog',
  '🗂️ Ready': 'To Do',
  '🔄 In Progress': 'In Progress',
  '👀 In Review': 'In Review',
  '✅ Done': 'Done',
};

const TYPE_MAP: Record<string, string> = {
  Bug: '🧪 Testing',
  Task: '💻 Code',
  Story: '💻 Code',
  Epic: '📋 Planning',
};

function mapIssueType(issuetype: string): string {
  return TYPE_MAP[issuetype] ?? '💻 Code';
}

const resolver = new DependencyResolver();

export class JiraTaskSourceProvider implements TaskBackend {
  readonly type = 'jira' as const;

  constructor(
    private readonly client: JiraClient,
    private readonly projectConfig: JiraProjectConfig,
  ) {}

  async fetchReadyTasks(
    milestoneId: string | null,
    _skipCache?: boolean,
  ): Promise<ResolvedTask[]> {
    const jql = this.buildReadyJql();
    const issues = await this.client.searchIssues(jql);

    const tasks: NotionTask[] = issues.map((issue) => ({
      id: issue.key,
      title: issue.fields.summary,
      status: issue.fields.status.name,
      type: mapIssueType(issue.fields.issuetype.name),
      dependsOn: [],
      notionUrl: '',
      priority: issue.fields.priority?.name,
    }));

    for (const task of tasks) {
      const prefixedId = formatTaskId('jira', task.id);
      upsertTaskCache(prefixedId, JSON.stringify({ ...task, id: prefixedId }));
    }

    const resolved = resolver.resolve(tasks, 'jira');
    const prefixed = resolved.map((r) => ({
      ...r,
      task: {
        ...r.task,
        id: formatTaskId('jira', r.task.id),
        dependsOn: r.task.dependsOn.map((dep) => formatTaskId('jira', dep)),
      },
    }));
    // Overwrite board cache with prefixed IDs so /api/tasks/active joins correctly.
    if (milestoneId !== null) {
      upsertTaskCache(
        `board:${milestoneId}`,
        JSON.stringify(prefixed.map((r) => r.task)),
      );
    }
    return prefixed;
  }

  async attachPR(taskId: string, prUrl: string): Promise<void> {
    const externalId = toExternalId(taskId);
    await this.client.addComment(externalId, `PR: ${prUrl}`);
  }

  async updateStatus(taskId: string, status: string): Promise<void> {
    const externalId = toExternalId(taskId);
    const mapping = this.projectConfig.status_mapping ?? DEFAULT_STATUS_MAPPING;
    const targetJiraStatus = mapping[status];
    if (!targetJiraStatus) {
      throw new Error(
        `[JiraTaskSourceProvider] no Jira status mapping for: "${status}"`,
      );
    }
    const transitions = await this.client.getTransitions(externalId);
    const transition = transitions.find(
      (t) => t.to.name.toLowerCase() === targetJiraStatus.toLowerCase(),
    );
    if (!transition) {
      throw new Error(
        `[JiraTaskSourceProvider] no transition to "${targetJiraStatus}" for issue ${externalId}`,
      );
    }
    await this.client.transitionIssue(externalId, transition.id);
  }

  async fetchTaskPage(taskId: string): Promise<string> {
    const externalId = toExternalId(taskId);
    const issue = await this.client.getIssue(externalId);
    const lines: string[] = [`# ${issue.fields.summary}`];
    lines.push(`**Status:** ${issue.fields.status.name}`);
    lines.push(`**Type:** ${issue.fields.issuetype.name}`);
    if (issue.fields.priority) {
      lines.push(`**Priority:** ${issue.fields.priority.name}`);
    }
    const desc = issue.fields.description;
    if (desc && typeof desc === 'string' && desc.trim()) {
      lines.push('', '## Description', desc.trim());
    }
    return lines.join('\n');
  }

  async fetchNonMilestoneReadyTasks(): Promise<ResolvedTask[]> {
    return [];
  }

  async updateNotes(_taskId: string, _notes: string): Promise<void> {
    // Jira backend does not support Notion-specific Notes property
  }

  async appendImplementationNote(
    _taskId: string,
    _note: string,
  ): Promise<void> {
    // Jira backend does not support Notion page block appending
  }

  private buildReadyJql(): string {
    if (this.projectConfig.default_jql) {
      return this.projectConfig.default_jql;
    }
    const readyStatuses =
      this.projectConfig.ready_statuses ?? DEFAULT_READY_STATUSES;
    return this.client.buildReadyJql(
      this.projectConfig.project_key,
      readyStatuses,
    );
  }
}
