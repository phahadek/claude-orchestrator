import type { TaskBackend, NonMilestoneSourceConfig } from './TaskBackend';
import type { ResolvedTask } from './types';
import type { NotionTask } from '../notion/types';
import { formatTaskId } from './taskId';
import { DependencyResolver } from '../notion/DependencyResolver';
import { upsertTaskCache } from '../db/queries';
import type { GitHubClient } from '../github/GitHubClient';
import type { Issue } from '../github/types';

export interface GithubProjectConfig {
  owner: string;
  repo: string;
  defaultMilestone?: number;
}

const STATUS_LABELS: Record<string, string> = {
  '🔲 Backlog': 'status:backlog',
  '🗂️ Ready': 'status:ready',
  '🔄 In Progress': 'status:in-progress',
  '👀 In Review': 'status:in-review',
  '✅ Done': 'status:done',
};

const LABEL_TO_STATUS: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_LABELS).map(([display, label]) => [label, display]),
);

const LABEL_TO_TYPE: Record<string, string> = {
  'type:code': '💻 Code',
  'type:testing': '🧪 Testing',
  'type:planning': '📋 Planning',
};

const LABEL_TO_PRIORITY: Record<string, string> = {
  'priority:high': '🔴 High',
  'priority:medium': '🟡 Medium',
  'priority:low': '🟢 Low',
};

const LABEL_DEFINITIONS = [
  {
    name: 'status:backlog',
    color: 'ededed',
    description: 'Task is in backlog',
  },
  {
    name: 'status:ready',
    color: '0075ca',
    description: 'Task is ready to launch',
  },
  {
    name: 'status:in-progress',
    color: 'e4e669',
    description: 'Task is in progress',
  },
  {
    name: 'status:in-review',
    color: 'f9d0c4',
    description: 'Task is in review',
  },
  { name: 'status:done', color: '0e8a16', description: 'Task is done' },
  { name: 'type:code', color: 'c2e0c6', description: 'Code task' },
  { name: 'type:testing', color: 'fef2c0', description: 'Testing task' },
  { name: 'type:planning', color: 'd4c5f9', description: 'Planning task' },
  { name: 'priority:high', color: 'd93f0b', description: 'High priority' },
  { name: 'priority:medium', color: 'fbca04', description: 'Medium priority' },
  { name: 'priority:low', color: '0075ca', description: 'Low priority' },
];

// Matches: "Depends on: #1 #2 #3" (anchored at start of line in multiline mode)
const DEPENDS_ON_RE = /^Depends on:\s+(#\d+(?:\s+#\d+)*)$/m;

const resolver = new DependencyResolver();

function extractDependsOn(body: string | null): string[] {
  if (!body) return [];
  const match = body.match(DEPENDS_ON_RE);
  if (!match) return [];
  return [...match[1].matchAll(/#(\d+)/g)].map((m) => m[1]);
}

function resolveStatus(labels: string[], issueNum: number): string {
  for (const label of labels) {
    if (LABEL_TO_STATUS[label]) return LABEL_TO_STATUS[label];
  }
  console.warn(
    `[GithubTaskSourceProvider] issue #${issueNum} has no status:* label; defaulting to 🔲 Backlog`,
  );
  return '🔲 Backlog';
}

function resolveType(labels: string[]): string {
  for (const label of labels) {
    if (LABEL_TO_TYPE[label]) return LABEL_TO_TYPE[label];
  }
  return '💻 Code';
}

function resolvePriority(labels: string[]): string | undefined {
  for (const label of labels) {
    if (LABEL_TO_PRIORITY[label]) return LABEL_TO_PRIORITY[label];
  }
  return undefined;
}

function issueToTask(issue: Issue): NotionTask {
  return {
    id: String(issue.id),
    title: issue.title,
    status: resolveStatus(issue.labels, issue.id),
    type: resolveType(issue.labels),
    dependsOn: extractDependsOn(issue.body),
    notionUrl: issue.url,
    priority: resolvePriority(issue.labels),
  };
}

export class GithubTaskSourceProvider implements TaskBackend {
  readonly type = 'github' as const;

  constructor(
    private readonly client: GitHubClient,
    private readonly config: GithubProjectConfig,
  ) {}

  private get repo(): string {
    return `${this.config.owner}/${this.config.repo}`;
  }

  async fetchReadyTasks(
    milestoneId: string | null,
    _skipCache?: boolean,
  ): Promise<ResolvedTask[]> {
    const milestone: number | undefined =
      milestoneId !== null ? Number(milestoneId) : undefined;

    const issues = await this.client.listIssues(this.repo, {
      labels: ['status:ready'],
      milestone,
      state: 'open',
    });

    return this.buildResolvedTasks(issues, milestoneId);
  }

  async fetchNonMilestoneReadyTasks(
    _sourceConfig: NonMilestoneSourceConfig | null,
    _projectId?: string,
  ): Promise<ResolvedTask[]> {
    const issues = await this.client.listIssues(this.repo, {
      labels: ['status:ready'],
      milestone: 'none',
      state: 'open',
    });
    return this.buildResolvedTasks(issues, null);
  }

  async attachPR(taskId: string, prUrl: string): Promise<void> {
    const issueNumber = this.parseIssueNumber(taskId);

    const comments = await this.client.listIssueComments(
      this.repo,
      issueNumber,
    );
    if (comments.some((c) => c.body.includes(prUrl))) return;

    await this.client.addIssueComment(this.repo, issueNumber, `PR: ${prUrl}`);

    const issue = await this.client.getIssue(this.repo, issueNumber);
    const labels = [...issue.labels.filter((l) => l !== 'status:ready')];
    if (!labels.includes('status:in-review')) labels.push('status:in-review');
    await this.client.updateIssue(this.repo, issueNumber, { labels });
  }

  async updateStatus(taskId: string, status: string): Promise<void> {
    const issueNumber = this.parseIssueNumber(taskId);
    const targetLabel = STATUS_LABELS[status];
    if (!targetLabel) {
      throw new Error(`[GithubTaskSourceProvider] unknown status: "${status}"`);
    }

    const issue = await this.client.getIssue(this.repo, issueNumber);
    const hadStatusLabel = issue.labels.some((l) => l.startsWith('status:'));
    if (!hadStatusLabel) {
      console.warn(
        `[GithubTaskSourceProvider] issue #${issueNumber} had no status:* label before updateStatus`,
      );
    }

    const labels = [
      ...issue.labels.filter((l) => !l.startsWith('status:')),
      targetLabel,
    ];

    const patch: Parameters<typeof this.client.updateIssue>[2] = { labels };
    if (status === '✅ Done') patch.state = 'closed';

    await this.client.updateIssue(this.repo, issueNumber, patch);
  }

  async fetchTaskPage(taskId: string): Promise<string> {
    const issueNumber = this.parseIssueNumber(taskId);
    const issue = await this.client.getIssue(this.repo, issueNumber);
    return issue.body ?? '';
  }

  async updateNotes(_taskId: string, _notes: string): Promise<void> {
    // GitHub Issues backend does not support a separate Notes property
  }

  async appendImplementationNote(
    _taskId: string,
    _note: string,
  ): Promise<void> {
    // GitHub Issues backend does not support block-level appending
  }

  /** Ensure all label vocabulary exists in the repo, creating missing labels. */
  async ensureLabels(): Promise<void> {
    for (const def of LABEL_DEFINITIONS) {
      await this.client.ensureLabelExists(
        this.repo,
        def.name,
        def.color,
        def.description,
      );
    }
  }

  private parseIssueNumber(taskId: string): number {
    const colonIdx = taskId.indexOf(':');
    const raw = colonIdx >= 0 ? taskId.substring(colonIdx + 1) : taskId;
    const n = parseInt(raw, 10);
    if (isNaN(n)) {
      throw new Error(
        `[GithubTaskSourceProvider] invalid task ID: "${taskId}"`,
      );
    }
    return n;
  }

  private buildResolvedTasks(
    issues: Issue[],
    milestoneId: string | null,
  ): ResolvedTask[] {
    const tasks = issues.map(issueToTask);

    for (const task of tasks) {
      const prefixedId = formatTaskId('github', task.id);
      upsertTaskCache(prefixedId, JSON.stringify({ ...task, id: prefixedId }));
    }

    const resolved = resolver.resolve(tasks, 'github');
    const prefixed = resolved.map((r) => ({
      ...r,
      task: {
        ...r.task,
        id: formatTaskId('github', r.task.id),
        dependsOn: r.task.dependsOn.map((dep) => formatTaskId('github', dep)),
      },
    }));

    if (milestoneId !== null) {
      upsertTaskCache(
        `board:${milestoneId}`,
        JSON.stringify(prefixed.map((r) => r.task)),
      );
    }

    return prefixed;
  }
}
