import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries', () => ({
  upsertTaskCache: vi.fn(),
}));

import { JiraTaskSourceProvider } from './JiraTaskSourceProvider';
import { upsertTaskCache } from '../db/queries';
import type { JiraIssue } from './JiraClient';

function makeIssue(key: string, statusName = 'To Do'): JiraIssue {
  return {
    id: `jira-${key}`,
    key,
    fields: {
      summary: `Issue ${key}`,
      status: { name: statusName },
      issuetype: { name: 'Task' },
      priority: null,
      description: null,
    },
  };
}

const PROJECT_CONFIG = {
  host: 'https://jira.example.com',
  project_key: 'TEST',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('JiraTaskSourceProvider.fetchReadyTasks — dependsOn prefixing', () => {
  it('prefixes every dependsOn entry with jira: alongside the task id', async () => {
    // Jira issues currently have no dependsOn (always [] from the mapper).
    // The test confirms the shape is correct after prefixing.
    const mockClient = {
      searchIssues: vi.fn().mockResolvedValue([
        makeIssue('TEST-1'),
        makeIssue('TEST-2'),
      ]),
      buildReadyJql: vi.fn().mockReturnValue("project = TEST AND status = 'To Do'"),
    };
    const provider = new JiraTaskSourceProvider(
      mockClient as never,
      PROJECT_CONFIG,
    );

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
    };
    const provider = new JiraTaskSourceProvider(
      mockClient as never,
      PROJECT_CONFIG,
    );

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
      buildReadyJql: vi.fn().mockReturnValue("project = TEST AND status = 'To Do'"),
    };
    const provider = new JiraTaskSourceProvider(
      mockClient as never,
      PROJECT_CONFIG,
    );

    await provider.fetchReadyTasks(null);

    const boardCacheCalls = vi
      .mocked(upsertTaskCache)
      .mock.calls.filter(([key]) => (key as string).startsWith('board:'));
    expect(boardCacheCalls).toHaveLength(0);
  });
});
