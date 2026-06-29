import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── DB mock (upsertTaskCache) ─────────────────────────────────────────────────

vi.mock('../../src/db/db.js', async () => {
  const { setupTestDb } = await import('../helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../src/projects/ProjectService.js', () => ({
  ProjectService: {
    getMilestone: vi.fn().mockReturnValue({ id: 'ms1', sourceId: 'EPIC-1' }),
  },
}));

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
      .mockReturnValue(
        'project = "PROJ" AND status in ("To Do") ORDER BY priority DESC',
      ),
    buildEpicParentJql: vi
      .fn()
      .mockReturnValue('parent = "EPIC-1" ORDER BY priority DESC'),
    buildEpicLinkJql: vi
      .fn()
      .mockReturnValue('"Epic Link" = "EPIC-1" ORDER BY priority DESC'),
    buildSubtaskJql: vi.fn().mockReturnValue('parent in ("PROJ-1")'),
    buildKeyInJql: vi.fn().mockReturnValue('key in ("PROJ-99")'),
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

// ── assignee injection ────────────────────────────────────────────────────────

describe('JiraTaskSourceProvider assignee injection', () => {
  it('injects assignee = currentUser() into buildReadyJql when no assignee configured', async () => {
    const client = makeClient();
    client.searchIssues = vi.fn().mockResolvedValue([]);

    const provider = new JiraTaskSourceProvider(client, PROJECT_CONFIG);
    await provider.fetchReadyTasks(null);

    expect(client.searchIssues).toHaveBeenCalledWith(
      'project = "PROJ" AND status in ("To Do") AND assignee = currentUser() ORDER BY priority DESC',
    );
  });

  it('injects configured assignee into buildReadyJql', async () => {
    const client = makeClient();
    client.searchIssues = vi.fn().mockResolvedValue([]);

    const provider = new JiraTaskSourceProvider(client, {
      ...PROJECT_CONFIG,
      assignee: 'user-account-id',
    });
    await provider.fetchReadyTasks(null);

    expect(client.searchIssues).toHaveBeenCalledWith(
      'project = "PROJ" AND status in ("To Do") AND assignee = "user-account-id" ORDER BY priority DESC',
    );
  });

  it('passes default_jql through unchanged — operator owns assignee clause', async () => {
    const client = makeClient();
    client.searchIssues = vi.fn().mockResolvedValue([]);

    const provider = new JiraTaskSourceProvider(client, {
      ...PROJECT_CONFIG,
      assignee: 'ignored',
      default_jql: 'project = PROJ AND assignee = "myuser" AND status = Ready',
    });
    await provider.fetchReadyTasks(null);

    expect(client.searchIssues).toHaveBeenCalledWith(
      'project = PROJ AND assignee = "myuser" AND status = Ready',
    );
  });

  it('injects assignee into Epic-parent JQL (milestone path)', async () => {
    const client = makeClient();
    client.searchIssues = vi.fn().mockResolvedValue([]);

    const provider = new JiraTaskSourceProvider(client, {
      ...PROJECT_CONFIG,
      assignee: 'testuser',
      epic_field: 'parent',
    });
    await provider.fetchReadyTasks('ms1');

    expect(client.searchIssues).toHaveBeenCalledWith(
      'parent = "EPIC-1" AND assignee = "testuser" ORDER BY priority DESC',
    );
  });

  it('injects assignee into Epic-Link JQL (milestone path)', async () => {
    const client = makeClient();
    client.searchIssues = vi.fn().mockResolvedValue([]);

    const provider = new JiraTaskSourceProvider(client, {
      ...PROJECT_CONFIG,
      assignee: 'testuser',
      epic_field: 'Epic Link',
    });
    await provider.fetchReadyTasks('ms1');

    expect(client.searchIssues).toHaveBeenCalledWith(
      '"Epic Link" = "EPIC-1" AND assignee = "testuser" ORDER BY priority DESC',
    );
  });

  it('does NOT inject assignee into buildKeyInJql (blocker expansion)', async () => {
    const issueWithBlocker = {
      id: '10001',
      key: 'PROJ-1',
      fields: {
        summary: 'Task: PROJ-1',
        status: { name: 'To Do' },
        issuetype: { name: 'Task' },
        priority: { name: 'High' },
        description: null,
        issuelinks: [
          {
            type: { inward: 'is blocked by' },
            inwardIssue: { key: 'PROJ-99' },
          },
        ],
      },
    };

    const client = makeClient();
    client.searchIssues = vi
      .fn()
      .mockResolvedValueOnce([issueWithBlocker])
      .mockResolvedValue([makeIssue('PROJ-99', 'In Progress')]);

    const provider = new JiraTaskSourceProvider(client, {
      ...PROJECT_CONFIG,
      assignee: 'testuser',
    });
    await provider.fetchReadyTasks(null);

    // The key-in fetch for round1 must not include the assignee clause
    const keyInCall = (
      client.searchIssues as ReturnType<typeof vi.fn>
    ).mock.calls.find(([jql]: [string]) => jql.includes('key in'));
    expect(keyInCall).toBeDefined();
    expect(keyInCall![0]).not.toContain('assignee');
  });

  it('blocker of a ready task resolves even when assigned to a different user', async () => {
    const issueWithBlocker = {
      id: '10001',
      key: 'PROJ-1',
      fields: {
        summary: 'Task: PROJ-1',
        status: { name: 'To Do' },
        issuetype: { name: 'Task' },
        priority: { name: 'High' },
        description: null,
        issuelinks: [
          {
            type: { inward: 'is blocked by' },
            inwardIssue: { key: 'PROJ-99' },
          },
        ],
      },
    };

    const client = makeClient();
    client.buildKeyInJql = vi.fn().mockReturnValue('key in ("PROJ-99")');
    client.searchIssues = vi
      .fn()
      .mockResolvedValueOnce([issueWithBlocker]) // ready fetch (with assignee)
      .mockResolvedValueOnce([makeIssue('PROJ-99', 'In Progress')]); // blocker fetch (no assignee)

    const provider = new JiraTaskSourceProvider(client, {
      ...PROJECT_CONFIG,
      assignee: 'testuser',
    });
    const tasks = await provider.fetchReadyTasks(null);

    // PROJ-1 should appear in results
    const readyTask = tasks.find((t) => t.task.id === 'jira:PROJ-1');
    expect(readyTask).toBeDefined();
    // Its blocker PROJ-99 should be listed as a dependency
    expect(readyTask!.task.dependsOn).toContain('jira:PROJ-99');
  });
});
