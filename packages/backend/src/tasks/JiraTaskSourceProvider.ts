import type { TaskBackend } from './TaskBackend';
import type { ResolvedTask } from './types';
import type { NotionTask } from '../notion/types';
import { formatTaskId, toExternalId } from './taskId';
import { JiraClient, JiraApiError } from './JiraClient';
import type { JiraIssue } from './JiraClient';
import { DependencyResolver } from '../notion/DependencyResolver';
import { upsertTaskCache } from '../db/queries';
import { ProjectService } from '../projects/ProjectService';
import { logger } from '../logger';

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
   *
   * Required Jira workflow configuration:
   * - Your Jira project must have statuses named (or mapped via this field):
   *   Backlog, To Do, In Progress, In Review, Done.
   * - The workflow must allow forward transitions between these states
   *   (e.g. To Do → In Progress → In Review → Done).
   * - Orchestrator-only statuses ('🚫 Blocked', '⏭️ Deferred') are intentionally
   *   excluded — no Jira transition is attempted for them.
   * - If a direct transition is unavailable (e.g. Ready→Done bypass) or the
   *   issue is already in the target state, the update is silently skipped with
   *   a warning log rather than throwing.
   */
  status_mapping?: Record<string, string>;
  /**
   * Maps Jira issue type names to orchestrator type strings.
   * Defaults to DEFAULT_TYPE_MAP.
   */
  type_mapping?: Record<string, string>;
  /**
   * Force a specific JQL field for Epic parent lookups ('parent' or 'Epic Link').
   * When omitted, the provider auto-detects and caches the working field.
   */
  epic_field?: string;
}

const DEFAULT_READY_STATUSES = ['To Do', 'Ready'];

const DEFAULT_STATUS_MAPPING: Record<string, string> = {
  '🔲 Backlog': 'Backlog',
  '🗂️ Ready': 'To Do',
  '🔄 In Progress': 'In Progress',
  '👀 In Review': 'In Review',
  '✅ Done': 'Done',
};

const DEFAULT_TYPE_MAP: Record<string, string> = {
  Story: '📋 Planning',
  Task: '💻 Code',
  'Sub-task': '💻 Code',
  Bug: '💻 Code',
};

const LAUNCHABLE_TYPE = '💻 Code';

const resolver = new DependencyResolver();

export class JiraTaskSourceProvider implements TaskBackend {
  readonly type = 'jira' as const;

  /** Cached result of epic-field auto-detection ('parent' or 'Epic Link'). */
  private epicFieldCache: string | null = null;

  constructor(
    private readonly client: JiraClient,
    private readonly projectConfig: JiraProjectConfig,
  ) {}

  async fetchReadyTasks(
    milestoneId: string | null,
    _skipCache?: boolean,
  ): Promise<ResolvedTask[]> {
    const typeMap = this.projectConfig.type_mapping ?? DEFAULT_TYPE_MAP;
    const readyStatuses = new Set(
      this.projectConfig.ready_statuses ?? DEFAULT_READY_STATUSES,
    );

    let initialIssues: JiraIssue[];
    let dispatchableKeys: Set<string>;

    if (milestoneId !== null) {
      const milestoneRow = ProjectService.getMilestone(milestoneId);
      if (!milestoneRow) {
        throw new Error(
          `[JiraTaskSourceProvider] milestone not found: ${milestoneId}`,
        );
      }
      if (!milestoneRow.sourceId) {
        throw new Error(
          `[JiraTaskSourceProvider] milestone ${milestoneId} has no source_id — set the Jira Epic key`,
        );
      }
      const epicKey = milestoneRow.sourceId;

      // Gap 2: 2-level Epic tree scan
      const level1 = await this.fetchEpicChildren(epicKey);

      // Level 2: sub-tasks of non-Epic, non-SubTask children
      const parentCandidateKeys = level1
        .filter(
          (i) =>
            i.fields.issuetype.name !== 'Epic' &&
            i.fields.issuetype.name !== 'Sub-task',
        )
        .map((i) => i.key);

      let level2: JiraIssue[] = [];
      if (parentCandidateKeys.length > 0) {
        level2 = await this.client.searchIssues(
          this.client.buildSubtaskJql(parentCandidateKeys),
        );
      }

      initialIssues = [...level1, ...level2];

      dispatchableKeys = new Set(
        initialIssues
          .filter(
            (i) =>
              i.fields.issuetype.name !== 'Epic' &&
              readyStatuses.has(i.fields.status.name) &&
              this.mapIssueType(i.fields.issuetype.name, typeMap) ===
                LAUNCHABLE_TYPE,
          )
          .map((i) => i.key),
      );
    } else {
      const jql = this.buildReadyJql();
      initialIssues = await this.client.searchIssues(jql);
      dispatchableKeys = new Set(initialIssues.map((i) => i.key));
    }

    // Build universe: initial issues + extra (blockers + sub-task parents)
    const universe = new Map<string, JiraIssue>(
      initialIssues.map((i) => [i.key, i]),
    );

    // Round 1 extras: own-blocker keys + parent keys of sub-tasks
    const round1Keys = new Set<string>();
    for (const issue of initialIssues) {
      for (const key of this.parseBlockerKeys(issue)) {
        if (!universe.has(key)) round1Keys.add(key);
      }
      if (
        issue.fields.issuetype.name === 'Sub-task' &&
        issue.fields.parent?.key
      ) {
        if (!universe.has(issue.fields.parent.key))
          round1Keys.add(issue.fields.parent.key);
      }
    }

    if (round1Keys.size > 0) {
      const round1 = await this.client.searchIssues(
        this.client.buildKeyInJql([...round1Keys]),
      );
      for (const i of round1) universe.set(i.key, i);

      // Round 2 extras: blockers of newly fetched issues (mainly parents)
      const round2Keys = new Set<string>();
      for (const issue of round1) {
        for (const key of this.parseBlockerKeys(issue)) {
          if (!universe.has(key)) round2Keys.add(key);
        }
      }
      if (round2Keys.size > 0) {
        const round2 = await this.client.searchIssues(
          this.client.buildKeyInJql([...round2Keys]),
        );
        for (const i of round2) universe.set(i.key, i);
      }
    }

    // Build NotionTask list from the universe
    const tasks: NotionTask[] = [];
    for (const issue of universe.values()) {
      const ownBlockers = this.parseBlockerKeys(issue);

      // Gap 1: sub-tasks inherit their parent's blockers
      let allBlockers = [...ownBlockers];
      if (
        issue.fields.issuetype.name === 'Sub-task' &&
        issue.fields.parent?.key
      ) {
        const parent = universe.get(issue.fields.parent.key);
        if (parent) {
          const parentBlockers = this.parseBlockerKeys(parent);
          allBlockers = [...new Set([...allBlockers, ...parentBlockers])];
        }
      }

      tasks.push({
        id: issue.key,
        title: issue.fields.summary,
        status: this.getOrchestratorStatus(issue.fields.status.name),
        type: this.mapIssueType(issue.fields.issuetype.name, typeMap),
        dependsOn: allBlockers,
        notionUrl: '',
        priority: issue.fields.priority?.name,
      });
    }

    // Cache individual dispatchable tasks (unprefixed dependsOn, prefixed id)
    for (const task of tasks) {
      if (dispatchableKeys.has(task.id)) {
        const prefixedId = formatTaskId('jira', task.id);
        upsertTaskCache(
          prefixedId,
          JSON.stringify({ ...task, id: prefixedId }),
        );
      }
    }

    const resolved = resolver.resolve(tasks, 'jira');

    // Filter to dispatchable only, then prefix all IDs
    const prefixed = resolved
      .filter((r) => dispatchableKeys.has(r.task.id))
      .map((r) => ({
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
      // Orchestrator-only statuses (e.g. 🚫 Blocked, ⏭️ Deferred) have no Jira counterpart.
      logger.warn(
        `[JiraTaskSourceProvider] no Jira status mapping for "${status}" on ${externalId} — skipping Jira transition`,
      );
      return;
    }

    const transitions = await this.client.getTransitions(externalId);
    const transition = transitions.find(
      (t) => t.to.name.toLowerCase() === targetJiraStatus.toLowerCase(),
    );

    if (!transition) {
      // No direct transition available — check whether issue is already in the target state.
      const issue = await this.client.getIssue(externalId);
      const currentStatus = issue.fields.status.name;
      if (currentStatus.toLowerCase() === targetJiraStatus.toLowerCase()) {
        return; // Already in target state — treat as success.
      }
      logger.warn(
        `[JiraTaskSourceProvider] no direct transition to "${targetJiraStatus}" for ${externalId} (currently "${currentStatus}") — skipping`,
      );
      return;
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

  async listTasksByStatus(_status: string): Promise<ResolvedTask[]> {
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

  /** Gap 2: Fetch direct children of an Epic, auto-detecting the JQL field. */
  private async fetchEpicChildren(epicKey: string): Promise<JiraIssue[]> {
    const override = this.projectConfig.epic_field ?? this.epicFieldCache;
    if (override) {
      const jql =
        override === 'parent'
          ? this.client.buildEpicParentJql(epicKey)
          : this.client.buildEpicLinkJql(epicKey);
      return this.client.searchIssues(jql);
    }

    // Auto-detect: try 'parent' first, fall back to 'Epic Link' on 400
    try {
      const result = await this.client.searchIssues(
        this.client.buildEpicParentJql(epicKey),
      );
      this.epicFieldCache = 'parent';
      return result;
    } catch (e) {
      if (e instanceof JiraApiError && e.statusCode === 400) {
        const result = await this.client.searchIssues(
          this.client.buildEpicLinkJql(epicKey),
        );
        this.epicFieldCache = 'Epic Link';
        return result;
      }
      throw e;
    }
  }

  /** Extract blocker issue keys from a Jira issue's issuelinks. */
  private parseBlockerKeys(issue: JiraIssue): string[] {
    return (issue.fields.issuelinks ?? [])
      .filter(
        (link) =>
          link.type.inward === 'is blocked by' && link.inwardIssue != null,
      )
      .map((link) => link.inwardIssue!.key);
  }

  /** Map a Jira issue type name to an orchestrator type string. */
  private mapIssueType(
    issuetype: string,
    typeMap: Record<string, string>,
  ): string {
    return typeMap[issuetype] ?? LAUNCHABLE_TYPE;
  }

  /** Map a Jira status name to an orchestrator display status. */
  private getOrchestratorStatus(jiraStatus: string): string {
    const mapping = this.projectConfig.status_mapping ?? DEFAULT_STATUS_MAPPING;
    for (const [orchStatus, jiraName] of Object.entries(mapping)) {
      if (jiraName.toLowerCase() === jiraStatus.toLowerCase()) {
        return orchStatus;
      }
    }
    return jiraStatus;
  }
}
