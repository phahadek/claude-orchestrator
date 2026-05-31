import type { ResolvedTask } from './types';
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
}

/**
 * Backwards-compatible alias for the previous interface name.
 * Prefer `TaskBackend` in new code.
 */
export type TaskTrackerBackend = TaskBackend;

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

  fetchReadyTasks(milestoneId: string | null, skipCache?: boolean) {
    return this.inner.fetchReadyTasks(milestoneId, skipCache);
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
    inner = new LocalTaskBackend(project.projectDir);
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
  let projectConfig: GithubProjectConfig;
  try {
    projectConfig = taskSourceConfigJson
      ? (JSON.parse(taskSourceConfigJson) as GithubProjectConfig)
      : { owner: '', repo: '' };
  } catch {
    projectConfig = { owner: '', repo: '' };
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
