import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries', () => ({
  upsertTaskCache: vi.fn(),
}));
vi.mock('../projects/ProjectService', () => ({
  ProjectService: {
    getMilestone: vi.fn(),
  },
}));

import { NotionTaskBackend } from './NotionTaskBackend';
import { ProjectService } from '../projects/ProjectService';
import { upsertTaskCache } from '../db/queries';
import type { ResolvedTask } from './types';

function makeResolvedTask(rawId: string, depIds: string[] = []): ResolvedTask {
  return {
    task: {
      id: rawId,
      title: `Task ${rawId}`,
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn: depIds,
      notionUrl: `https://notion.so/${rawId}`,
    },
    source: 'notion',
    blocked: false,
    blockers: [],
    nonCode: false,
    wave: 1,
  };
}

const MILESTONE_ID = 'milestone-abc';
const SOURCE_ID = 'source-db-id';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ProjectService.getMilestone).mockReturnValue({
    id: MILESTONE_ID,
    name: 'Test Milestone',
    sourceId: SOURCE_ID,
    source: 'notion',
    projectId: 'proj-1',
  } as never);
});

describe('NotionTaskBackend.fetchReadyTasks — dependsOn prefixing', () => {
  it('prefixes every dependsOn entry with notion: alongside the task id', async () => {
    const mockClient = {
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([
          makeResolvedTask('raw-id-a', ['raw-id-b']),
          makeResolvedTask('raw-id-b', []),
        ]),
    };
    const backend = new NotionTaskBackend(mockClient as never);

    const result = await backend.fetchReadyTasks(MILESTONE_ID);

    const taskA = result.find((r) => r.task.id === 'notion:raw-id-a')!;
    expect(taskA).toBeDefined();
    expect(taskA.task.dependsOn).toEqual(['notion:raw-id-b']);
  });

  it('returns tasks with no dependsOn entries unchanged (empty array)', async () => {
    const mockClient = {
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([makeResolvedTask('raw-id-x', [])]),
    };
    const backend = new NotionTaskBackend(mockClient as never);

    const result = await backend.fetchReadyTasks(MILESTONE_ID);

    expect(result[0].task.dependsOn).toEqual([]);
  });

  it('writes board cache with prefixed-everywhere shape (both id and dependsOn)', async () => {
    const mockClient = {
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([makeResolvedTask('raw-id-a', ['raw-id-b'])]),
    };
    const backend = new NotionTaskBackend(mockClient as never);

    await backend.fetchReadyTasks(MILESTONE_ID);

    const boardCacheCall = vi
      .mocked(upsertTaskCache)
      .mock.calls.find(([key]) => key === `board:${SOURCE_ID}`);
    expect(boardCacheCall).toBeDefined();
    const cached = JSON.parse(boardCacheCall![1] as string) as Array<{
      id: string;
      dependsOn: string[];
    }>;
    expect(cached[0].id).toBe('notion:raw-id-a');
    expect(cached[0].dependsOn).toEqual(['notion:raw-id-b']);
  });

  it('writes per-task cache with prefixed-everywhere shape', async () => {
    const mockClient = {
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([makeResolvedTask('raw-id-a', ['raw-id-b'])]),
    };
    const backend = new NotionTaskBackend(mockClient as never);

    await backend.fetchReadyTasks(MILESTONE_ID);

    const perTaskCall = vi
      .mocked(upsertTaskCache)
      .mock.calls.find(([key]) => key === 'notion:raw-id-a');
    expect(perTaskCall).toBeDefined();
    const cached = JSON.parse(perTaskCall![1] as string) as {
      id: string;
      dependsOn: string[];
    };
    expect(cached.id).toBe('notion:raw-id-a');
    expect(cached.dependsOn).toEqual(['notion:raw-id-b']);
  });
});

describe('NotionTaskBackend.fetchNonMilestoneReadyTasks — dependsOn prefixing', () => {
  it('prefixes every dependsOn entry with notion:', async () => {
    const mockClient = {
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([
          makeResolvedTask('raw-nm-a', ['raw-nm-b']),
          makeResolvedTask('raw-nm-b', []),
        ]),
    };
    const backend = new NotionTaskBackend(mockClient as never);

    const result = await backend.fetchNonMilestoneReadyTasks({
      notionDatabaseId: 'nm-db-id',
    } as never);

    const taskA = result.find((r) => r.task.id === 'notion:raw-nm-a')!;
    expect(taskA).toBeDefined();
    expect(taskA.task.dependsOn).toEqual(['notion:raw-nm-b']);
  });

  it('writes non-milestone cache with prefixed-everywhere shape', async () => {
    const mockClient = {
      fetchReadyTasks: vi
        .fn()
        .mockResolvedValue([makeResolvedTask('raw-nm-a', ['raw-nm-b'])]),
    };
    const backend = new NotionTaskBackend(mockClient as never);

    await backend.fetchNonMilestoneReadyTasks(
      { notionDatabaseId: 'nm-db-id' } as never,
      'proj-nm',
    );

    const nmCacheCall = vi
      .mocked(upsertTaskCache)
      .mock.calls.find(([key]) => key === 'non_milestone:proj-nm');
    expect(nmCacheCall).toBeDefined();
    const cached = JSON.parse(nmCacheCall![1] as string) as Array<{
      id: string;
      dependsOn: string[];
    }>;
    expect(cached[0].id).toBe('notion:raw-nm-a');
    expect(cached[0].dependsOn).toEqual(['notion:raw-nm-b']);
  });
});
