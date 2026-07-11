import type { ResolvedTask } from './types';
import type { TaskBodySections } from './bodyRender';
import { ProjectService } from '../projects/ProjectService';
import { NotionClient } from '../notion/NotionClient';
import { NotionTaskBackend } from './NotionTaskBackend';
import { LocalTaskBackend } from './LocalTaskBackend';
import { JiraClient } from './JiraClient';
import {
  JiraTaskSourceProvider,
  type JiraProjectConfig,
} from './JiraTaskSourceProvider';
import {
  GithubTaskSourceProvider,
  type GithubProjectConfig,
} from './GithubTaskSourceProvider';
import { GitHubClient } from '../github/GitHubClient';
import { JIRA_HOST, JIRA_TOKEN, JIRA_EMAIL } from '../config';
import { recordEvent } from '../audit/AuditLog';
import { upsertTaskCache } from '../db/queries';

/**
 * Per-project configuration that identifies where non-milestone tasks are sourced from.
 * Stored as JSON in projects.non_milestone_source_config.
 */
export interface NonMilestoneSourceConfig {
  /** Notion database ID (for notion-backed projects). */
  notionDatabaseId?: string;
  /** tasks.yaml milestone id (for yaml-backed projects). */
  milestoneId?: string;
}

export interface UpdateStatusOptions {
  source?: 'orchestrator' | 'human';
  sessionId?: string | null;
}

/** Provenance options shared by the write-side port methods (create / deps). */
export type TaskWriteOptions = UpdateStatusOptions;

/**
 * Fields accepted by createTask. Status is intentionally absent — every
 * implementation hard-codes the initial Backlog status regardless of input.
 */
export interface NewTaskFields {
  /** Parent database/board ID (e.g. Notion database ID) the task is created under. */
  databaseId: string;
  title: string;
  /** Display-format type, e.g. '💻 Code'. */
  type?: string;
  /** Display-format priority, e.g. '🔴 High'. */
  priority?: string;
  /** Task IDs (prefixed, e.g. 'notion:abc123') this task depends on. */
  dependsOn?: string[];
}

/**
 * Cosmetic properties settable via setProperties — Priority and Task Name
 * only. Status, Type, and Depends On are execution-governing and have their
 * own validated write commands.
 */
export interface TaskPropertiesPatch {
  /** Display-format priority, e.g. '🔴 High'. */
  priority?: string;
  /** Task Name (title property), plain text. */
  title?: string;
}

/**
 * Project-scoped task tracker. An instance is bound to a single project via the
 * factory `getTaskBackend(projectId)` — callers do not pass projectId to methods.
 */
export interface TaskBackend {
  /** Backend identifier; reflects the project's task_source. */
  readonly type: 'notion' | 'local' | 'jira' | 'github';

  /**
   * Fetch tasks that are ready to be dispatched for the given milestone.
   * For Notion projects, milestoneId is resolved to the milestone row's source_id
   * (the Notion database ID). For YAML projects, pass null to fetch all tasks
   * across all milestones, or a milestone id to scope to one.
   */
  fetchReadyTasks(
    milestoneId: string | null,
    skipCache?: boolean,
  ): Promise<ResolvedTask[]>;

  /** Mark a task as in-review and attach a PR URL. */
  attachPR(taskId: string, prUrl: string): Promise<void>;

  /** Update task status (display-format string with emoji prefix). */
  updateStatus(
    taskId: string,
    status: string,
    options?: UpdateStatusOptions,
  ): Promise<void>;

  /** Fetch the full task page body as markdown (for review/session context). */
  fetchTaskPage(taskId: string): Promise<string>;

  /**
   * Fetch tasks ready to launch that are not tied to a milestone.
   * sourceConfig identifies which source (Notion database or YAML milestone) to query.
   * Returns [] when sourceConfig is null or the source is not configured.
   */
  fetchNonMilestoneReadyTasks(
    sourceConfig: NonMilestoneSourceConfig | null,
    projectId?: string,
  ): Promise<ResolvedTask[]>;

  /** Overwrite the Notes property on a task page. */
  updateNotes(taskId: string, notes: string): Promise<void>;

  /** Append a line to the "Implementation Notes" section in the task page body. */
  appendImplementationNote(taskId: string, note: string): Promise<void>;

  /**
   * List all tasks currently at the given display status (e.g. '🔄 In Progress').
   * Used by the orphaned-task sweep to find tasks that need reconciliation.
   * Implementations may return from cache rather than making live API calls.
   */
  listTasksByStatus(status: string): Promise<ResolvedTask[]>;

  /**
   * Create a new task page. Always created at the initial Backlog status,
   * regardless of any status implied by `fields`. Optional — only backends
   * that support programmatic task creation implement this (Notion today;
   * other stores can add support later since the port stays store-agnostic).
   */
  createTask?(
    fields: NewTaskFields,
    options?: TaskWriteOptions,
  ): Promise<string>;

  /**
   * Overwrite the Depends On property with the given task IDs. Optional for
   * the same reason as createTask.
   */
  setDependsOn?(
    taskId: string,
    dependsOn: string[],
    options?: TaskWriteOptions,
  ): Promise<void>;

  /**
   * Render the task-writing.md section model into the page body, replacing
   * any existing content. Optional for the same reason as createTask.
   */
  updateBody?(
    taskId: string,
    sections: TaskBodySections,
    options?: TaskWriteOptions,
  ): Promise<void>;

  /**
   * Overwrite the Type select property (display-format, e.g. '💻 Code').
   * Optional for the same reason as createTask.
   */
  setType?(
    taskId: string,
    type: string,
    options?: TaskWriteOptions,
  ): Promise<void>;

  /**
   * Overwrite cosmetic properties (Priority / Task Name). Optional for the
   * same reason as createTask.
   */
  setProperties?(
    taskId: string,
    patch: TaskPropertiesPatch,
    options?: TaskWriteOptions,
  ): Promise<void>;
}

// ── AuditingTaskBackend ──────────────────────────────────────────────────────

/**
 * Thin wrapper that emits a status_updated audit event on every updateStatus call.
 * Applied at the factory boundary so all implementations are covered automatically.
 */
export class AuditingTaskBackend implements TaskBackend {
  constructor(
    readonly inner: TaskBackend,
    private readonly projectId: string,
  ) {}

  get type(): 'notion' | 'local' | 'jira' | 'github' {
    return this.inner.type;
  }

  async fetchReadyTasks(
    milestoneId: string | null,
    skipCache?: boolean,
  ): Promise<ResolvedTask[]> {
    const results = await this.inner.fetchReadyTasks(milestoneId, skipCache);
    if (this.inner.type === 'github') {
      for (const r of results) {
        upsertTaskCache(r.task.id, JSON.stringify(r.task));
      }
      if (milestoneId !== null) {
        upsertTaskCache(
          `board:${milestoneId}`,
          JSON.stringify(results.map((r) => r.task)),
        );
      }
    }
    return results;
  }

  attachPR(taskId: string, prUrl: string) {
    return this.inner.attachPR(taskId, prUrl);
  }

  async updateStatus(
    taskId: string,
    status: string,
    options?: UpdateStatusOptions,
  ): Promise<void> {
    await this.inner.updateStatus(taskId, status);
    const source = options?.source ?? 'orchestrator';
    const sessionId = options?.sessionId ?? null;
    recordEvent({
      event_type: 'status_updated',
      actor_type: source === 'human' ? 'human' : 'system',
      actor_id: sessionId,
      project_id: this.projectId,
      task_id: taskId,
      payload: {
        from: null,
        to: status,
        source,
        notes: 'previous status not captured',
      },
    });
  }

  fetchTaskPage(taskId: string) {
    return this.inner.fetchTaskPage(taskId);
  }

  fetchNonMilestoneReadyTasks(
    sourceConfig: NonMilestoneSourceConfig | null,
    projectId?: string,
  ) {
    return this.inner.fetchNonMilestoneReadyTasks(sourceConfig, projectId);
  }

  updateNotes(taskId: string, notes: string) {
    return this.inner.updateNotes(taskId, notes);
  }

  appendImplementationNote(taskId: string, note: string) {
    return this.inner.appendImplementationNote(taskId, note);
  }

  listTasksByStatus(status: string) {
    return this.inner.listTasksByStatus(status);
  }

  async createTask(
    fields: NewTaskFields,
    options?: TaskWriteOptions,
  ): Promise<string> {
    if (!this.inner.createTask) {
      throw new Error(
        `[AuditingTaskBackend] createTask is not supported by backend type "${this.inner.type}"`,
      );
    }
    const taskId = await this.inner.createTask(fields);
    const source = options?.source ?? 'orchestrator';
    recordEvent({
      event_type: 'task_created',
      actor_type: source === 'human' ? 'human' : 'system',
      actor_id: options?.sessionId ?? null,
      project_id: this.projectId,
      task_id: taskId,
      payload: { title: fields.title, source },
    });
    return taskId;
  }

  async setDependsOn(
    taskId: string,
    dependsOn: string[],
    options?: TaskWriteOptions,
  ): Promise<void> {
    if (!this.inner.setDependsOn) {
      throw new Error(
        `[AuditingTaskBackend] setDependsOn is not supported by backend type "${this.inner.type}"`,
      );
    }
    await this.inner.setDependsOn(taskId, dependsOn);
    const source = options?.source ?? 'orchestrator';
    recordEvent({
      event_type: 'task_deps_updated',
      actor_type: source === 'human' ? 'human' : 'system',
      actor_id: options?.sessionId ?? null,
      project_id: this.projectId,
      task_id: taskId,
      payload: { dependsOn, source },
    });
  }

  async updateBody(
    taskId: string,
    sections: TaskBodySections,
    options?: TaskWriteOptions,
  ): Promise<void> {
    if (!this.inner.updateBody) {
      throw new Error(
        `[AuditingTaskBackend] updateBody is not supported by backend type "${this.inner.type}"`,
      );
    }
    await this.inner.updateBody(taskId, sections);
    const source = options?.source ?? 'orchestrator';
    recordEvent({
      event_type: 'task_body_updated',
      actor_type: source === 'human' ? 'human' : 'system',
      actor_id: options?.sessionId ?? null,
      project_id: this.projectId,
      task_id: taskId,
      payload: { source },
    });
  }

  async setType(
    taskId: string,
    type: string,
    options?: TaskWriteOptions,
  ): Promise<void> {
    if (!this.inner.setType) {
      throw new Error(
        `[AuditingTaskBackend] setType is not supported by backend type "${this.inner.type}"`,
      );
    }
    await this.inner.setType(taskId, type);
    const source = options?.source ?? 'orchestrator';
    recordEvent({
      event_type: 'task_type_updated',
      actor_type: source === 'human' ? 'human' : 'system',
      actor_id: options?.sessionId ?? null,
      project_id: this.projectId,
      task_id: taskId,
      payload: { type, source },
    });
  }

  async setProperties(
    taskId: string,
    patch: TaskPropertiesPatch,
    options?: TaskWriteOptions,
  ): Promise<void> {
    if (!this.inner.setProperties) {
      throw new Error(
        `[AuditingTaskBackend] setProperties is not supported by backend type "${this.inner.type}"`,
      );
    }
    await this.inner.setProperties(taskId, patch);
    const source = options?.source ?? 'orchestrator';
    recordEvent({
      event_type: 'task_properties_updated',
      actor_type: source === 'human' ? 'human' : 'system',
      actor_id: options?.sessionId ?? null,
      project_id: this.projectId,
      task_id: taskId,
      payload: { patch, source },
    });
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

let _notionBackend: NotionTaskBackend | undefined;

function getNotionBackend(): NotionTaskBackend {
  _notionBackend ??= new NotionTaskBackend(new NotionClient());
  return _notionBackend;
}

/**
 * Resolve the task backend for a project, honoring its `task_source` column.
 * Throws if the project is not found.
 */
export function getTaskBackend(projectId: string): TaskBackend {
  const project = ProjectService.getById(projectId);
  if (!project) {
    throw new Error(`[getTaskBackend] project not found: ${projectId}`);
  }
  let inner: TaskBackend;
  if (project.taskSource === 'yaml') {
    inner = new LocalTaskBackend(project.projectDir, project.id);
  } else if (project.taskSource === 'jira') {
    inner = buildJiraBackend(project.taskSourceConfig);
  } else if (project.taskSource === 'github') {
    inner = buildGithubBackend(project.taskSourceConfig);
  } else {
    inner = getNotionBackend();
  }
  return new AuditingTaskBackend(inner, projectId);
}

function buildJiraBackend(
  taskSourceConfigJson: string | null,
): JiraTaskSourceProvider {
  let projectConfig: JiraProjectConfig;
  try {
    projectConfig = taskSourceConfigJson
      ? (JSON.parse(taskSourceConfigJson) as JiraProjectConfig)
      : { host: JIRA_HOST, project_key: '' };
  } catch {
    projectConfig = { host: JIRA_HOST, project_key: '' };
  }
  const host = projectConfig.host || JIRA_HOST;
  const token = JIRA_TOKEN;
  const email = JIRA_EMAIL || undefined;
  const client = new JiraClient(host, token, email);
  return new JiraTaskSourceProvider(client, { ...projectConfig, host });
}

function buildGithubBackend(
  taskSourceConfigJson: string | null,
): GithubTaskSourceProvider {
  if (!taskSourceConfigJson) {
    throw new Error(
      '[buildGithubBackend] task_source_config is required for github projects',
    );
  }
  let projectConfig: GithubProjectConfig;
  try {
    projectConfig = JSON.parse(taskSourceConfigJson) as GithubProjectConfig;
  } catch {
    throw new Error(
      `[buildGithubBackend] malformed task_source_config JSON: ${taskSourceConfigJson}`,
    );
  }
  if (!projectConfig.owner) {
    throw new Error('[buildGithubBackend] task_source_config missing "owner"');
  }
  if (!projectConfig.repo) {
    throw new Error('[buildGithubBackend] task_source_config missing "repo"');
  }
  const client = new GitHubClient();
  return new GithubTaskSourceProvider(client, projectConfig);
}

/**
 * Test-only: reset the cached Notion backend so subsequent `getTaskBackend()`
 * calls re-instantiate it. Useful for vi.mocked NotionClient.
 */
export function _resetTaskBackendCacheForTests(): void {
  _notionBackend = undefined;
}
