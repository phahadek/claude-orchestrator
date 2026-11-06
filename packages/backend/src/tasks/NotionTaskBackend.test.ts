import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries', () => ({
  getGrantedCapabilities: vi.fn(() => []),
  upsertTaskCache: vi.fn(),
  getRecentTaskStatusWrite: vi.fn(() => null),
  getTaskCache: vi.fn(() => undefined),
}));
vi.mock('../projects/ProjectService', () => ({
  ProjectService: {
    getMilestone: vi.fn(),
  },
}));

import { NotionTaskBackend } from './NotionTaskBackend';
import { ProjectService } from '../projects/ProjectService';
import { upsertTaskCache, getTaskCache } from '../db/queries';
import { formatTaskId } from './taskId';
import type { ResolvedTask } from './types';
import type { NotionTask } from '../notion/types';

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
      .mock.calls.find(([key]) => key === `board:${MILESTONE_ID}`);
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

describe('NotionTaskBackend.fetchTaskSummary — cache-first with live fallback', () => {
  it("resolves from task_cache with zero client calls, given a bare id, against a row written in the refresher's notion:-prefixed format", async () => {
    const rawId = 'raw-id-cached';
    // Mirrors exactly how fetchReadyTasks/the refresher persist a task: the
    // prefixed key comes from formatTaskId, not a hand-built 'notion:' string.
    const prefixedId = formatTaskId('notion', rawId);
    const cachedTask: NotionTask = {
      id: prefixedId,
      title: 'Cached Task Title',
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn: [],
      notionUrl: `https://notion.so/${rawId}`,
      archived: false,
    };
    vi.mocked(getTaskCache).mockImplementation((taskId: string) =>
      taskId === prefixedId
        ? ({
            task_id: prefixedId,
            fetched_at: Date.now(),
            raw_json: JSON.stringify(cachedTask),
          } as never)
        : undefined,
    );
    const mockClient = { fetchTaskSummary: vi.fn() };
    const backend = new NotionTaskBackend(mockClient as never);

    const result = await backend.fetchTaskSummary(rawId);

    expect(mockClient.fetchTaskSummary).not.toHaveBeenCalled();
    expect(result).toEqual({
      title: 'Cached Task Title',
      type: '💻 Code',
      status: '🗂️ Ready',
      archived: false,
    });
  });

  it('falls through to the client on a cache miss', async () => {
    vi.mocked(getTaskCache).mockReturnValue(undefined);
    const mockClient = {
      fetchTaskSummary: vi.fn().mockResolvedValue({
        title: 'Live Task',
        status: '🗂️ Ready',
        type: '💻 Code',
        archived: false,
      }),
    };
    const backend = new NotionTaskBackend(mockClient as never);

    const result = await backend.fetchTaskSummary('raw-id-live');

    expect(mockClient.fetchTaskSummary).toHaveBeenCalledWith(
      'notion:raw-id-live',
    );
    expect(result).toEqual({
      title: 'Live Task',
      type: '💻 Code',
      status: '🗂️ Ready',
      archived: false,
    });
  });

  it('returns null on a cache miss whose live fetch 404s, unchanged from today', async () => {
    vi.mocked(getTaskCache).mockReturnValue(undefined);
    const mockClient = { fetchTaskSummary: vi.fn().mockResolvedValue(null) };
    const backend = new NotionTaskBackend(mockClient as never);

    const result = await backend.fetchTaskSummary('raw-id-missing');

    expect(result).toBeNull();
  });

  it('falls through to the live fetch when the cache row has malformed raw_json', async () => {
    vi.mocked(getTaskCache).mockReturnValue({
      task_id: 'notion:raw-id-bad',
      fetched_at: Date.now(),
      raw_json: '{not valid json',
    } as never);
    const mockClient = {
      fetchTaskSummary: vi.fn().mockResolvedValue({
        title: 'Recovered Task',
        status: '🗂️ Ready',
        type: '💻 Code',
        archived: false,
      }),
    };
    const backend = new NotionTaskBackend(mockClient as never);

    const result = await backend.fetchTaskSummary('raw-id-bad');

    expect(mockClient.fetchTaskSummary).toHaveBeenCalled();
    expect(result).toEqual({
      title: 'Recovered Task',
      type: '💻 Code',
      status: '🗂️ Ready',
      archived: false,
    });
  });
});
