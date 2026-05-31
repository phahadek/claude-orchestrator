import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries', () => ({
  upsertTaskCache: vi.fn(),
}));

import { GithubTaskSourceProvider } from './GithubTaskSourceProvider';
import { upsertTaskCache } from '../db/queries';
import type { Issue, IssueComment } from '../github/types';

function makeIssue(
  id: number,
  overrides: Partial<Issue> = {},
): Issue {
  return {
    id,
    nodeId: `node-${id}`,
    title: `Issue ${id}`,
    body: null,
    state: 'open',
    labels: ['status:ready', 'type:code'],
    milestone: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: `https://github.com/owner/repo/issues/${id}`,
    ...overrides,
  };
}

function makeComment(id: number, body: string): IssueComment {
  return {
    id,
    body,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: `https://github.com/owner/repo/issues/1#issuecomment-${id}`,
  };
}

const PROJECT_CONFIG = { owner: 'owner', repo: 'repo' };

function makeClient(overrides: Partial<{
  listIssues: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
  updateIssue: ReturnType<typeof vi.fn>;
  addIssueComment: ReturnType<typeof vi.fn>;
  listIssueComments: ReturnType<typeof vi.fn>;
  ensureLabelExists: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn(),
    updateIssue: vi.fn().mockResolvedValue(makeIssue(1)),
    addIssueComment: vi.fn().mockResolvedValue({}),
    listIssueComments: vi.fn().mockResolvedValue([]),
    ensureLabelExists: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── fetchReadyTasks ─────────────────────────────────────────────────────────

describe('GithubTaskSourceProvider.fetchReadyTasks', () => {
  it('returns only issues with status:ready label', async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([
        makeIssue(1, { labels: ['status:ready', 'type:code'] }),
        makeIssue(2, { labels: ['status:ready', 'type:testing'] }),
      ]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    const result = await provider.fetchReadyTasks(null);

    expect(client.listIssues).toHaveBeenCalledWith('owner/repo', {
      labels: ['status:ready'],
      milestone: undefined,
      state: 'open',
    });
    expect(result).toHaveLength(2);
    expect(result[0].task.id).toBe('github:1');
    expect(result[1].task.id).toBe('github:2');
  });

  it('passes numeric milestone when milestoneId is provided', async () => {
    const client = makeClient();
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    await provider.fetchReadyTasks('7');

    expect(client.listIssues).toHaveBeenCalledWith('owner/repo', {
      labels: ['status:ready'],
      milestone: 7,
      state: 'open',
    });
  });

  it('passes undefined milestone when milestoneId is null', async () => {
    const client = makeClient();
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    await provider.fetchReadyTasks(null);

    expect(client.listIssues).toHaveBeenCalledWith('owner/repo', {
      labels: ['status:ready'],
      milestone: undefined,
      state: 'open',
    });
  });

  it('prefixes all task IDs with github:', async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue(42)]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    const result = await provider.fetchReadyTasks(null);

    expect(result[0].task.id).toBe('github:42');
    for (const dep of result[0].task.dependsOn) {
      expect(dep.startsWith('github:')).toBe(true);
    }
  });

  it('writes board cache with github:-prefixed IDs when milestoneId is set', async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue(1)]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    await provider.fetchReadyTasks('3');

    const boardCall = vi
      .mocked(upsertTaskCache)
      .mock.calls.find(([key]) => key === 'board:3');
    expect(boardCall).toBeDefined();
    const cached = JSON.parse(boardCall![1] as string) as Array<{ id: string }>;
    expect(cached[0].id).toBe('github:1');
  });

  it('does not write board cache when milestoneId is null', async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue(1)]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    await provider.fetchReadyTasks(null);

    const boardCalls = vi
      .mocked(upsertTaskCache)
      .mock.calls.filter(([key]) => (key as string).startsWith('board:'));
    expect(boardCalls).toHaveLength(0);
  });
});

// ── fetchNonMilestoneReadyTasks ─────────────────────────────────────────────

describe('GithubTaskSourceProvider.fetchNonMilestoneReadyTasks', () => {
  it('queries issues with milestone=none', async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue(5, { milestone: null })]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    const result = await provider.fetchNonMilestoneReadyTasks(null);

    expect(client.listIssues).toHaveBeenCalledWith('owner/repo', {
      labels: ['status:ready'],
      milestone: 'none',
      state: 'open',
    });
    expect(result[0].task.id).toBe('github:5');
  });
});

// ── body parsing ────────────────────────────────────────────────────────────

describe('GithubTaskSourceProvider — body parsing', () => {
  it('handles null body without crashing', async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue(1, { body: null })]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    const result = await provider.fetchReadyTasks(null);
    expect(result[0].task.dependsOn).toEqual([]);
  });

  it('handles empty body without crashing', async () => {
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue(1, { body: '' })]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    const result = await provider.fetchReadyTasks(null);
    expect(result[0].task.dependsOn).toEqual([]);
  });

  it('parses Depends-On line with multiple issue refs', async () => {
    const body = '## Summary\nDoes stuff\n\nDepends on: #1 #2 #3\n\n## Context\nFoo';
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue(10, { body })]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    const result = await provider.fetchReadyTasks(null);
    expect(result[0].task.dependsOn).toEqual(['github:1', 'github:2', 'github:3']);
  });

  it('ignores lines with issue refs that are not the Depends-On line', async () => {
    const body = 'This relates to #4 and #5 but not a dependency\nDepends on: #7';
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue(10, { body })]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    const result = await provider.fetchReadyTasks(null);
    expect(result[0].task.dependsOn).toEqual(['github:7']);
  });

  it('handles body with no Depends-On line', async () => {
    const body = '## Summary\nThis is a task with #1 mentioned in prose.';
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue(10, { body })]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    const result = await provider.fetchReadyTasks(null);
    expect(result[0].task.dependsOn).toEqual([]);
  });

  it('handles missing / extra / duplicate body sections without crashing', async () => {
    const body = [
      '## Summary',
      'Does something.',
      '## Implementation notes',
      'Some notes.',
      '## Summary',
      'Duplicate section.',
      '## Unknown Section',
      'Unknown content.',
    ].join('\n');
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue(1, { body })]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    await expect(provider.fetchReadyTasks(null)).resolves.toBeDefined();
  });
});

// ── missing label tolerance ─────────────────────────────────────────────────

describe('GithubTaskSourceProvider — missing label tolerance', () => {
  it('defaults to 🔲 Backlog when no status:* label is present', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue(1, { labels: ['type:code'] })]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    const result = await provider.fetchReadyTasks(null);

    expect(result[0].task.status).toBe('🔲 Backlog');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no status:* label'),
    );
    warnSpy.mockRestore();
  });

  it('still returns the task when labels are missing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = makeClient({
      listIssues: vi.fn().mockResolvedValue([makeIssue(1, { labels: [] })]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    const result = await provider.fetchReadyTasks(null);
    expect(result).toHaveLength(1);
  });
});

// ── updateStatus ────────────────────────────────────────────────────────────

describe('GithubTaskSourceProvider.updateStatus', () => {
  it('removes old status:* label and adds the new one', async () => {
    const issue = makeIssue(1, { labels: ['status:ready', 'type:code', 'priority:high'] });
    const client = makeClient({
      getIssue: vi.fn().mockResolvedValue(issue),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    await provider.updateStatus('github:1', '🔄 In Progress');

    expect(client.updateIssue).toHaveBeenCalledWith('owner/repo', 1, {
      labels: ['type:code', 'priority:high', 'status:in-progress'],
    });
  });

  it('closes the issue when status is ✅ Done', async () => {
    const issue = makeIssue(1, { labels: ['status:in-review'] });
    const client = makeClient({
      getIssue: vi.fn().mockResolvedValue(issue),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    await provider.updateStatus('github:1', '✅ Done');

    expect(client.updateIssue).toHaveBeenCalledWith('owner/repo', 1, {
      labels: ['status:done'],
      state: 'closed',
    });
  });

  it('does not set state=closed for non-done statuses', async () => {
    const issue = makeIssue(1, { labels: ['status:ready'] });
    const client = makeClient({
      getIssue: vi.fn().mockResolvedValue(issue),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    await provider.updateStatus('github:1', '🔄 In Progress');

    const call = client.updateIssue.mock.calls[0][2] as Record<string, unknown>;
    expect(call.state).toBeUndefined();
  });

  it('throws for an unknown status string', async () => {
    const issue = makeIssue(1);
    const client = makeClient({
      getIssue: vi.fn().mockResolvedValue(issue),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    await expect(
      provider.updateStatus('github:1', 'unknown status'),
    ).rejects.toThrow('[GithubTaskSourceProvider] unknown status:');
  });
});

// ── attachPR ────────────────────────────────────────────────────────────────

describe('GithubTaskSourceProvider.attachPR', () => {
  it('adds a PR-URL comment and swaps label to status:in-review', async () => {
    const issue = makeIssue(1, { labels: ['status:ready', 'type:code'] });
    const client = makeClient({
      getIssue: vi.fn().mockResolvedValue(issue),
      listIssueComments: vi.fn().mockResolvedValue([]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    await provider.attachPR('github:1', 'https://github.com/owner/repo/pull/42');

    expect(client.addIssueComment).toHaveBeenCalledWith(
      'owner/repo',
      1,
      'PR: https://github.com/owner/repo/pull/42',
    );
    expect(client.updateIssue).toHaveBeenCalledWith('owner/repo', 1, {
      labels: ['type:code', 'status:in-review'],
    });
  });

  it('skips adding comment when PR URL already present in a comment', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/42';
    const issue = makeIssue(1, { labels: ['status:in-review', 'type:code'] });
    const client = makeClient({
      getIssue: vi.fn().mockResolvedValue(issue),
      listIssueComments: vi.fn().mockResolvedValue([makeComment(100, `PR: ${prUrl}`)]),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    await provider.attachPR('github:1', prUrl);

    expect(client.addIssueComment).not.toHaveBeenCalled();
  });
});

// ── fetchTaskPage ───────────────────────────────────────────────────────────

describe('GithubTaskSourceProvider.fetchTaskPage', () => {
  it('returns the raw issue body', async () => {
    const body = '## Summary\nDoes something important.\n\n## Context\nBackground.';
    const client = makeClient({
      getIssue: vi.fn().mockResolvedValue(makeIssue(5, { body })),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    const result = await provider.fetchTaskPage('github:5');

    expect(client.getIssue).toHaveBeenCalledWith('owner/repo', 5);
    expect(result).toBe(body);
  });

  it('returns empty string when issue body is null', async () => {
    const client = makeClient({
      getIssue: vi.fn().mockResolvedValue(makeIssue(5, { body: null })),
    });
    const provider = new GithubTaskSourceProvider(client as never, PROJECT_CONFIG);

    const result = await provider.fetchTaskPage('github:5');
    expect(result).toBe('');
  });
});
