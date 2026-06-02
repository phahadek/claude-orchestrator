import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DB mock (upsertTaskCache) ─────────────────────────────────────────────────

vi.mock('../../src/db/db.js', async () => {
  const { setupTestDb } = await import('../helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { JiraClient } from '../../src/tasks/JiraClient.js';
import {
  JiraTaskSourceProvider,
  type JiraProjectConfig,
} from '../../src/tasks/JiraTaskSourceProvider.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeIssue(key: string, status = 'To Do', issuetype = 'Task') {
  return {
    id: '10001',
    key,
    fields: {
      summary: `Task: ${key}`,
      status: { name: status },
      issuetype: { name: issuetype },
      priority: { name: 'High' },
      description: null,
    },
  };
}

function makeTransition(id: string, toName: string) {
  return { id, name: `Move to ${toName}`, to: { name: toName } };
}

function makeClient() {
  return {
    searchIssues: vi.fn(),
    getIssue: vi.fn(),
    getTransitions: vi.fn(),
    transitionIssue: vi.fn(),
    addComment: vi.fn(),
    buildReadyJql: vi
      .fn()
      .mockReturnValue('project = "PROJ" AND status in ("To Do")'),
  } as unknown as JiraClient;
}

const PROJECT_CONFIG: JiraProjectConfig = {
  host: 'https://example.atlassian.net',
  project_key: 'PROJ',
};

// ── fetchReadyTasks ───────────────────────────────────────────────────────────

describe('JiraTaskSourceProvider.fetchReadyTasks', () => {
  let client: ReturnType<typeof makeClient>;
  let provider: JiraTaskSourceProvider;

  beforeEach(() => {
    client = makeClient();
    provider = new JiraTaskSourceProvider(client, PROJECT_CONFIG);
  });

  it('maps a Jira issue to a ResolvedTask with all required fields', async () => {
    client.searchIssues = vi
      .fn()
      .mockResolvedValue([makeIssue('PROJ-42', 'To Do')]);

    const tasks = await provider.fetchReadyTasks(null);

    expect(tasks).toHaveLength(1);
    const { task, source, blocked, blockers, wave } = tasks[0];
    expect(source).toBe('jira');
    expect(task.id).toBe('jira:PROJ-42');
    expect(task.title).toBe('Task: PROJ-42');
    expect(task.status).toBe('To Do');
    expect(task.type).toBe('💻 Code'); // Task -> Code
    expect(typeof blocked).toBe('boolean');
    expect(Array.isArray(blockers)).toBe(true);
    expect(typeof wave).toBe('number');
  });

  it('uses default_jql when configured', async () => {
    const customConfig: JiraProjectConfig = {
      ...PROJECT_CONFIG,
      default_jql: 'project = PROJ AND status = Ready',
    };
    const customProvider = new JiraTaskSourceProvider(client, customConfig);
    client.searchIssues = vi.fn().mockResolvedValue([]);

    await customProvider.fetchReadyTasks(null);

    expect(client.searchIssues).toHaveBeenCalledWith(
      'project = PROJ AND status = Ready',
    );
  });

  it('calls buildReadyJql with ready_statuses when no default_jql is set', async () => {
    const customConfig: JiraProjectConfig = {
      ...PROJECT_CONFIG,
      ready_statuses: ['Open', 'Backlog'],
    };
    const customProvider = new JiraTaskSourceProvider(client, customConfig);
    client.searchIssues = vi.fn().mockResolvedValue([]);

    await customProvider.fetchReadyTasks(null);

    expect(client.buildReadyJql).toHaveBeenCalledWith('PROJ', [
      'Open',
      'Backlog',
    ]);
  });

  it('prefixes all returned task IDs with jira:', async () => {
    client.searchIssues = vi
      .fn()
      .mockResolvedValue([makeIssue('PROJ-1'), makeIssue('PROJ-2')]);

    const tasks = await provider.fetchReadyTasks(null);
    expect(tasks.every((t) => t.task.id.startsWith('jira:'))).toBe(true);
  });

  it('maps Bug issuetype to Testing type', async () => {
    client.searchIssues = vi
      .fn()
      .mockResolvedValue([makeIssue('PROJ-5', 'To Do', 'Bug')]);

    const [task] = await provider.fetchReadyTasks(null);
    expect(task.task.type).toBe('🧪 Testing');
  });
});

// ── updateStatus ──────────────────────────────────────────────────────────────

describe('JiraTaskSourceProvider.updateStatus', () => {
  let client: ReturnType<typeof makeClient>;
  let provider: JiraTaskSourceProvider;

  beforeEach(() => {
    client = makeClient();
    provider = new JiraTaskSourceProvider(client, PROJECT_CONFIG);
  });

  it('calls the correct Jira transition for "✅ Done"', async () => {
    client.getTransitions = vi
      .fn()
      .mockResolvedValue([makeTransition('31', 'Done')]);
    client.transitionIssue = vi.fn().mockResolvedValue(undefined);

    await provider.updateStatus('jira:PROJ-10', '✅ Done');

    expect(client.getTransitions).toHaveBeenCalledWith('PROJ-10');
    expect(client.transitionIssue).toHaveBeenCalledWith('PROJ-10', '31');
  });

  it('calls the correct Jira transition for "🔄 In Progress"', async () => {
    client.getTransitions = vi
      .fn()
      .mockResolvedValue([makeTransition('21', 'In Progress')]);
    client.transitionIssue = vi.fn().mockResolvedValue(undefined);

    await provider.updateStatus('jira:PROJ-11', '🔄 In Progress');

    expect(client.transitionIssue).toHaveBeenCalledWith('PROJ-11', '21');
  });

  it('uses custom status_mapping when configured', async () => {
    const customProvider = new JiraTaskSourceProvider(client, {
      ...PROJECT_CONFIG,
      status_mapping: { '✅ Done': 'Closed' },
    });
    client.getTransitions = vi
      .fn()
      .mockResolvedValue([makeTransition('51', 'Closed')]);
    client.transitionIssue = vi.fn().mockResolvedValue(undefined);

    await customProvider.updateStatus('jira:PROJ-20', '✅ Done');

    expect(client.transitionIssue).toHaveBeenCalledWith('PROJ-20', '51');
  });

  it('throws when no transition matches the target status', async () => {
    client.getTransitions = vi
      .fn()
      .mockResolvedValue([makeTransition('11', 'In Progress')]);

    await expect(
      provider.updateStatus('jira:PROJ-9', '✅ Done'),
    ).rejects.toThrow(/no transition to "Done"/);
  });

  it('throws when status has no mapping', async () => {
    await expect(
      provider.updateStatus('jira:PROJ-9', '❓ Unknown'),
    ).rejects.toThrow(/no Jira status mapping/);
  });
});

// ── attachPR ──────────────────────────────────────────────────────────────────

describe('JiraTaskSourceProvider.attachPR', () => {
  it('adds a comment with the PR URL, stripping the jira: prefix', async () => {
    const client = makeClient();
    client.addComment = vi.fn().mockResolvedValue(undefined);
    const provider = new JiraTaskSourceProvider(client, PROJECT_CONFIG);

    await provider.attachPR(
      'jira:PROJ-7',
      'https://github.com/org/repo/pull/42',
    );

    expect(client.addComment).toHaveBeenCalledWith(
      'PROJ-7',
      'PR: https://github.com/org/repo/pull/42',
    );
  });
});

// ── fetchNonMilestoneReadyTasks ───────────────────────────────────────────────

describe('JiraTaskSourceProvider.fetchNonMilestoneReadyTasks', () => {
  it('returns []', async () => {
    const client = makeClient();
    const provider = new JiraTaskSourceProvider(client, PROJECT_CONFIG);
    const result = await provider.fetchNonMilestoneReadyTasks();
    expect(result).toEqual([]);
  });
});
