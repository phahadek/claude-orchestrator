import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries', () => ({
  upsertTaskCache: vi.fn(),
}));

import { JiraTaskSourceProvider } from './JiraTaskSourceProvider';
import { JiraApiError } from './JiraClient';
import { upsertTaskCache } from '../db/queries';
import type { JiraIssue } from './JiraClient';

function makeIssue(
  key: string,
  overrides: Partial<JiraIssue['fields']> = {},
): JiraIssue {
  return {
    id: `jira-${key}`,
    key,
    fields: {
      summary: `Issue ${key}`,
      status: { name: 'To Do' },
      issuetype: { name: 'Task' },
      priority: null,
      description: null,
      ...overrides,
    },
  };
}

function blockedByLink(blockerKey: string) {
  return {
    type: { inward: 'is blocked by', outward: 'blocks' },
    inwardIssue: { key: blockerKey },
  };
}

const PROJECT_CONFIG = {
  host: 'https://jira.example.com',
  project_key: 'TEST',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Existing tests — dependsOn prefixing
// ---------------------------------------------------------------------------

describe('JiraTaskSourceProvider.fetchReadyTasks — dependsOn prefixing', () => {
  it('prefixes every dependsOn entry with jira: alongside the task id', async () => {
    const mockClient = {
      searchIssues: vi.fn().mockResolvedValue([makeIssue('TEST-1'), makeIssue('TEST-2')]),
      buildReadyJql: vi.fn().mockReturnValue("project = TEST AND status = 'To Do'"),
      buildEpicParentJql: vi.fn().mockReturnValue('parent = "milestone-1"'),
      buildSubtaskJql: vi.fn().mockReturnValue('parent in ("TEST-1","TEST-2")'),
      buildKeyInJql: vi.fn().mockReturnValue(''),
    };
    const provider = new JiraTaskSourceProvider(mockClient as never, PROJECT_CONFIG);

    const result = await provider.fetchReadyTasks('milestone-1');

    for (const r of result) {
      expect(r.task.id.startsWith('jira:')).toBe(true);
      expect(Array.isArray(r.task.dependsOn)).toBe(true);
      for (const dep of r.task.dependsOn) {
        expect(dep.startsWith('jira:')).toBe(true);
      }
    }
  });

  it('writes board cache with jira:-prefixed task IDs', async () => {
    const mockClient = {
      searchIssues: vi.fn().mockResolvedValue([makeIssue('TEST-1')]),
      buildReadyJql: vi.fn().mockReturnValue("project = TEST AND status = 'To Do'"),
      buildEpicParentJql: vi.fn().mockReturnValue('parent = "milestone-1"'),
      buildSubtaskJql: vi.fn().mockReturnValue(''),
      buildKeyInJql: vi.fn().mockReturnValue(''),
    };
    const provider = new JiraTaskSourceProvider(mockClient as never, PROJECT_CONFIG);

    await provider.fetchReadyTasks('milestone-1');

    const boardCacheCall = vi
      .mocked(upsertTaskCache)
      .mock.calls.find(([key]) => key === 'board:milestone-1');
    expect(boardCacheCall).toBeDefined();
    const cached = JSON.parse(boardCacheCall![1] as string) as Array<{
      id: string;
      dependsOn: string[];
    }>;
    expect(cached[0].id).toBe('jira:TEST-1');
    expect(Array.isArray(cached[0].dependsOn)).toBe(true);
  });

  it('does not write board cache when milestoneId is null', async () => {
    const mockClient = {
      searchIssues: vi.fn().mockResolvedValue([makeIssue('TEST-1')]),
      buildReadyJql: vi
        .fn()
        .mockReturnValue("project = TEST AND status = 'To Do'"),
      buildKeyInJql: vi.fn().mockReturnValue(''),
    };
    const provider = new JiraTaskSourceProvider(mockClient as never, PROJECT_CONFIG);

    await provider.fetchReadyTasks(null);

    const boardCacheCalls = vi
      .mocked(upsertTaskCache)
      .mock.calls.filter(([key]) => (key as string).startsWith('board:'));
    expect(boardCacheCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gap 1 — Depends-On via is-blocked-by links + sub-task inheritance
// ---------------------------------------------------------------------------

describe('Gap 1 — issuelinks → dependsOn', () => {
  it('parses is-blocked-by links into dependsOn for Story/Task', async () => {
    const readyStory = makeIssue('TEST-1', {
      issuetype: { name: 'Story' },
      issuelinks: [blockedByLink('TEST-99')],
    });
    const blocker = makeIssue('TEST-99', { status: { name: 'In Progress' } });

    const mockClient = {
      searchIssues: vi.fn().mockImplementation((jql: string) => {
        if (jql.includes('key in')) return Promise.resolve([blocker]);
        return Promise.resolve([readyStory]);
      }),
      buildReadyJql: vi.fn().mockReturnValue('jql'),
      buildKeyInJql: vi.fn().mockReturnValue('key in ("TEST-99")'),
    };
    const provider = new JiraTaskSourceProvider(mockClient as never, PROJECT_CONFIG);
    const result = await provider.fetchReadyTasks(null);

    const story = result.find((r) => r.task.id === 'jira:TEST-1')!;
    expect(story).toBeDefined();
    expect(story.task.dependsOn).toContain('jira:TEST-99');
    expect(story.blocked).toBe(true);
  });

  it('does not block when blocker is in a Done status', async () => {
    const readyTask = makeIssue('TEST-2', {
      issuelinks: [blockedByLink('TEST-99')],
    });
    const doneBlocker = makeIssue('TEST-99', { status: { name: 'Done' } });

    const mockClient = {
      searchIssues: vi.fn().mockImplementation((jql: string) => {
        if (jql.includes('key in')) return Promise.resolve([doneBlocker]);
        return Promise.resolve([readyTask]);
      }),
      buildReadyJql: vi.fn().mockReturnValue('jql'),
      buildKeyInJql: vi.fn().mockReturnValue('key in ("TEST-99")'),
    };
    const provider = new JiraTaskSourceProvider(mockClient as never, PROJECT_CONFIG);
    const result = await provider.fetchReadyTasks(null);

    const task = result.find((r) => r.task.id === 'jira:TEST-2')!;
    expect(task).toBeDefined();
    expect(task.blocked).toBe(false);
  });

  it('sub-task inherits parent story blockers ∪ its own', async () => {
    const parentStory = makeIssue('TEST-10', {
      issuetype: { name: 'Story' },
      issuelinks: [blockedByLink('TEST-99')],
    });
    const subTask = makeIssue('TEST-11', {
      issuetype: { name: 'Sub-task' },
      parent: { key: 'TEST-10' },
      issuelinks: [blockedByLink('TEST-88')],
    });
    const blocker99 = makeIssue('TEST-99', { status: { name: 'In Progress' } });
    const blocker88 = makeIssue('TEST-88', { status: { name: 'In Progress' } });

    const mockClient = {
      searchIssues: vi.fn().mockImplementation((jql: string) => {
        if (jql.includes('key in')) {
          // Return both blockers and parent (since parent is not in initial)
          return Promise.resolve([parentStory, blocker99, blocker88]);
        }
        return Promise.resolve([subTask]);
      }),
      buildReadyJql: vi.fn().mockReturnValue('jql'),
      buildKeyInJql: vi.fn().mockReturnValue('key in (...)'),
    };
    const provider = new JiraTaskSourceProvider(mockClient as never, PROJECT_CONFIG);
    const result = await provider.fetchReadyTasks(null);

    const st = result.find((r) => r.task.id === 'jira:TEST-11')!;
    expect(st).toBeDefined();
    expect(st.task.dependsOn).toContain('jira:TEST-99'); // inherited from parent
    expect(st.task.dependsOn).toContain('jira:TEST-88'); // own
    expect(st.blocked).toBe(true);
  });

  it('non-Done blocker does block; Done blocker does not block', async () => {
    const taskA = makeIssue('TEST-A', {
      issuelinks: [blockedByLink('BLK-1')],
    });
    const taskB = makeIssue('TEST-B', {
      issuelinks: [blockedByLink('BLK-2')],
    });
    const nonDoneBlocker = makeIssue('BLK-1', { status: { name: 'In Progress' } });
    const doneBlocker = makeIssue('BLK-2', { status: { name: 'Done' } });

    const mockClient = {
      searchIssues: vi.fn().mockImplementation((jql: string) => {
        if (jql.includes('key in'))
          return Promise.resolve([nonDoneBlocker, doneBlocker]);
        return Promise.resolve([taskA, taskB]);
      }),
      buildReadyJql: vi.fn().mockReturnValue('jql'),
      buildKeyInJql: vi.fn().mockReturnValue('key in (...)'),
    };
    const provider = new JiraTaskSourceProvider(mockClient as never, PROJECT_CONFIG);
    const result = await provider.fetchReadyTasks(null);

    const a = result.find((r) => r.task.id === 'jira:TEST-A')!;
    const b = result.find((r) => r.task.id === 'jira:TEST-B')!;
    expect(a.blocked).toBe(true);
    expect(b.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — Epic tree scan (milestone = Epic key)
// ---------------------------------------------------------------------------

describe('Gap 2 — Epic tree scan', () => {
  it('returns 2-level tree: direct children + their sub-tasks', async () => {
    const epicChild = makeIssue('TEST-20', { issuetype: { name: 'Story' } });
    const subTask = makeIssue('TEST-21', {
      issuetype: { name: 'Sub-task' },
      parent: { key: 'TEST-20' },
    });

    const mockClient = {
      searchIssues: vi.fn().mockImplementation((jql: string) => {
        if (jql.includes('parent in')) return Promise.resolve([subTask]);
        if (jql.includes('key in')) return Promise.resolve([]);
        // level-1 epic children
        return Promise.resolve([epicChild]);
      }),
      buildEpicParentJql: vi.fn().mockReturnValue('parent = "EPIC-1"'),
      buildSubtaskJql: vi.fn().mockReturnValue('parent in ("TEST-20")'),
      buildKeyInJql: vi.fn().mockReturnValue('key in ()'),
    };
    const provider = new JiraTaskSourceProvider(
      mockClient as never,
      { ...PROJECT_CONFIG, epic_field: 'parent' },
    );
    const result = await provider.fetchReadyTasks('EPIC-1');

    const ids = result.map((r) => r.task.id);
    // Story maps to Planning (non-launchable), sub-task maps to Code (launchable)
    expect(ids).not.toContain('jira:TEST-20'); // Story → 📋 Planning, filtered out
    expect(ids).toContain('jira:TEST-21');
  });

  it('excludes Epic-type issues from results', async () => {
    const epicChild = makeIssue('TEST-30', { issuetype: { name: 'Epic' } });
    const task = makeIssue('TEST-31', { issuetype: { name: 'Task' } });

    const mockClient = {
      searchIssues: vi.fn().mockImplementation((jql: string) => {
        if (jql.includes('parent in')) return Promise.resolve([]);
        if (jql.includes('key in')) return Promise.resolve([]);
        return Promise.resolve([epicChild, task]);
      }),
      buildEpicParentJql: vi.fn().mockReturnValue('parent = "EPIC-1"'),
      buildSubtaskJql: vi.fn().mockReturnValue('parent in ("TEST-31")'),
      buildKeyInJql: vi.fn().mockReturnValue('key in ()'),
    };
    const provider = new JiraTaskSourceProvider(
      mockClient as never,
      { ...PROJECT_CONFIG, epic_field: 'parent' },
    );
    const result = await provider.fetchReadyTasks('EPIC-1');

    const ids = result.map((r) => r.task.id);
    expect(ids).not.toContain('jira:TEST-30'); // Epic excluded
    expect(ids).toContain('jira:TEST-31');
  });

  it('only ready_status + launchable-type issues are dispatchable', async () => {
    const readyTask = makeIssue('TEST-40', {
      issuetype: { name: 'Task' },
      status: { name: 'To Do' },
    });
    const inProgressTask = makeIssue('TEST-41', {
      issuetype: { name: 'Task' },
      status: { name: 'In Progress' },
    });
    const readyStory = makeIssue('TEST-42', {
      issuetype: { name: 'Story' },
      status: { name: 'To Do' },
    });

    const mockClient = {
      searchIssues: vi.fn().mockImplementation((jql: string) => {
        if (jql.includes('parent in')) return Promise.resolve([]);
        if (jql.includes('key in')) return Promise.resolve([]);
        return Promise.resolve([readyTask, inProgressTask, readyStory]);
      }),
      buildEpicParentJql: vi.fn().mockReturnValue('parent = "EPIC-1"'),
      buildSubtaskJql: vi.fn().mockReturnValue(''),
      buildKeyInJql: vi.fn().mockReturnValue(''),
    };
    const provider = new JiraTaskSourceProvider(
      mockClient as never,
      { ...PROJECT_CONFIG, epic_field: 'parent' },
    );
    const result = await provider.fetchReadyTasks('EPIC-1');

    const ids = result.map((r) => r.task.id);
    expect(ids).toContain('jira:TEST-40'); // ready + launchable
    expect(ids).not.toContain('jira:TEST-41'); // not ready status
    expect(ids).not.toContain('jira:TEST-42'); // Story → Planning, non-launchable
  });

  it('falls back to "Epic Link" on parent field 400 and caches the result', async () => {
    const child = makeIssue('TEST-50', { issuetype: { name: 'Task' } });
    let callCount = 0;

    const mockClient = {
      searchIssues: vi.fn().mockImplementation((jql: string) => {
        callCount++;
        if (jql.includes('parent =') && !jql.includes('parent in')) {
          throw new JiraApiError(400, 'Field parent does not exist');
        }
        if (jql.includes('parent in')) return Promise.resolve([]);
        if (jql.includes('key in')) return Promise.resolve([]);
        return Promise.resolve([child]);
      }),
      buildEpicParentJql: vi.fn().mockReturnValue('parent = "EPIC-1"'),
      buildEpicLinkJql: vi.fn().mockReturnValue('"Epic Link" = "EPIC-1"'),
      buildSubtaskJql: vi.fn().mockReturnValue('parent in ("TEST-50")'),
      buildKeyInJql: vi.fn().mockReturnValue('key in ()'),
    };
    const provider = new JiraTaskSourceProvider(mockClient as never, PROJECT_CONFIG);

    // First call: should detect fallback to 'Epic Link'
    await provider.fetchReadyTasks('EPIC-1');
    const firstCallCount = callCount;

    // Second call: should use cached 'Epic Link' (no retry on parent)
    callCount = 0;
    await provider.fetchReadyTasks('EPIC-1');

    // On second call, should not throw (no parent= attempt)
    expect(callCount).toBeGreaterThan(0);
    // epic_link JQL should have been used (not parent= on second call)
    const parentCalls = vi
      .mocked(mockClient.searchIssues)
      .mock.calls.filter(([jql]) => (jql as string).includes('parent =') && !(jql as string).includes('parent in'));
    // All parent= calls only happened in first round (before cache was set)
    expect(firstCallCount).toBeGreaterThan(0);
    // Verify Epic Link was used
    expect(vi.mocked(mockClient.buildEpicLinkJql)).toHaveBeenCalled();
    // After caching, second call should not use buildEpicParentJql at all
    vi.mocked(mockClient.buildEpicParentJql).mockClear();
    vi.mocked(mockClient.buildEpicLinkJql).mockClear();
    await provider.fetchReadyTasks('EPIC-1');
    expect(vi.mocked(mockClient.buildEpicParentJql)).not.toHaveBeenCalled();
    expect(vi.mocked(mockClient.buildEpicLinkJql)).toHaveBeenCalled();
  });

  it('epic_field override skips detection entirely', async () => {
    const child = makeIssue('TEST-60', { issuetype: { name: 'Task' } });

    const mockClient = {
      searchIssues: vi.fn().mockImplementation((jql: string) => {
        if (jql.includes('parent in')) return Promise.resolve([]);
        if (jql.includes('key in')) return Promise.resolve([]);
        return Promise.resolve([child]);
      }),
      buildEpicLinkJql: vi.fn().mockReturnValue('"Epic Link" = "EPIC-1"'),
      buildEpicParentJql: vi.fn().mockReturnValue('parent = "EPIC-1"'),
      buildSubtaskJql: vi.fn().mockReturnValue(''),
      buildKeyInJql: vi.fn().mockReturnValue(''),
    };
    const provider = new JiraTaskSourceProvider(
      mockClient as never,
      { ...PROJECT_CONFIG, epic_field: 'Epic Link' },
    );
    await provider.fetchReadyTasks('EPIC-1');

    expect(vi.mocked(mockClient.buildEpicLinkJql)).toHaveBeenCalledWith('EPIC-1');
    expect(vi.mocked(mockClient.buildEpicParentJql)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Gap 3 — Type mapping
// ---------------------------------------------------------------------------

describe('Gap 3 — type mapping', () => {
  function makeProvider(type_mapping?: Record<string, string>) {
    const issues: JiraIssue[] = [];
    const mockClient = {
      searchIssues: vi.fn().mockResolvedValue(issues),
      buildReadyJql: vi.fn().mockReturnValue('jql'),
      buildKeyInJql: vi.fn().mockReturnValue(''),
    };
    const provider = new JiraTaskSourceProvider(
      mockClient as never,
      { ...PROJECT_CONFIG, type_mapping },
    );
    return { provider, issues, mockClient };
  }

  async function resolveTypes(
    issueList: JiraIssue[],
    type_mapping?: Record<string, string>,
  ) {
    const { provider, issues, mockClient } = makeProvider(type_mapping);
    issues.push(...issueList);
    mockClient.searchIssues.mockResolvedValue(issueList);
    const result = await provider.fetchReadyTasks(null);
    return result.map((r) => ({ key: r.task.id.replace('jira:', ''), type: r.task.type, nonCode: r.nonCode }));
  }

  it('Story maps to 📋 Planning (non-launchable) by default', async () => {
    const items = await resolveTypes([makeIssue('S-1', { issuetype: { name: 'Story' } })]);
    expect(items[0].type).toBe('📋 Planning');
    expect(items[0].nonCode).toBe(true);
  });

  it('Task maps to 💻 Code (launchable) by default', async () => {
    const items = await resolveTypes([makeIssue('T-1', { issuetype: { name: 'Task' } })]);
    expect(items[0].type).toBe('💻 Code');
    expect(items[0].nonCode).toBe(false);
  });

  it('Sub-task maps to 💻 Code (launchable) by default', async () => {
    const items = await resolveTypes([makeIssue('ST-1', { issuetype: { name: 'Sub-task' } })]);
    expect(items[0].type).toBe('💻 Code');
    expect(items[0].nonCode).toBe(false);
  });

  it('Bug maps to 💻 Code (launchable) by default', async () => {
    const items = await resolveTypes([makeIssue('B-1', { issuetype: { name: 'Bug' } })]);
    expect(items[0].type).toBe('💻 Code');
    expect(items[0].nonCode).toBe(false);
  });

  it('Unknown type defaults to 💻 Code', async () => {
    const items = await resolveTypes([makeIssue('U-1', { issuetype: { name: 'Chore' } })]);
    expect(items[0].type).toBe('💻 Code');
    expect(items[0].nonCode).toBe(false);
  });

  it('type_mapping config overrides defaults', async () => {
    const items = await resolveTypes(
      [makeIssue('T-2', { issuetype: { name: 'Task' } })],
      { Task: '📋 Planning' },
    );
    expect(items[0].type).toBe('📋 Planning');
    expect(items[0].nonCode).toBe(true);
  });
});
