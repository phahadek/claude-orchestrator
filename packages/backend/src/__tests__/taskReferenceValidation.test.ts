import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetTaskBackend = vi.fn();
const mockGetTaskCache = vi.fn();
const mockListMilestonesByProject = vi.fn();

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: (...args: unknown[]) => mockGetTaskBackend(...args),
}));

vi.mock('../db/queries', () => ({
  getTaskCache: (...args: unknown[]) => mockGetTaskCache(...args),
  listMilestonesByProject: (...args: unknown[]) =>
    mockListMilestonesByProject(...args),
}));

import {
  assertTaskIdResolves,
  assertNoDependencyCycle,
  DependencyCycleError,
  TaskReferenceValidationError,
} from '../tasks/taskReferenceValidation';
import type { NotionTask } from '../notion/types';

describe('assertTaskIdResolves', () => {
  beforeEach(() => {
    mockGetTaskBackend.mockReset();
    mockGetTaskCache.mockReset();
  });

  it('resolves for a live (non-archived) task', async () => {
    mockGetTaskBackend.mockReturnValue({
      fetchTaskSummary: vi.fn().mockResolvedValue({
        title: 'A task',
        type: '💻 Code',
        status: '🗂️ Ready',
        archived: false,
      }),
    });

    await expect(
      assertTaskIdResolves('notion:live', 'proj-1'),
    ).resolves.toBeUndefined();
  });

  it('rejects a task id whose page 404s', async () => {
    mockGetTaskBackend.mockReturnValue({
      fetchTaskSummary: vi.fn().mockResolvedValue(null),
    });

    await expect(
      assertTaskIdResolves('notion:missing', 'proj-1'),
    ).rejects.toThrow(TaskReferenceValidationError);
  });

  it('rejects a task id whose page is archived — not only one that 404s', async () => {
    mockGetTaskBackend.mockReturnValue({
      fetchTaskSummary: vi.fn().mockResolvedValue({
        title: 'An archived task',
        type: '💻 Code',
        status: '✅ Done',
        archived: true,
      }),
    });

    await expect(
      assertTaskIdResolves('notion:archived', 'proj-1'),
    ).rejects.toThrow(/does not resolve to an existing task/);
  });

  it('does not consult the task cache at all — a stale cache row for an archived/absent page cannot short-circuit to success', async () => {
    // A stale cache row that would have looked "live" under the old
    // getTaskCache(taskId) short-circuit, for a task that is actually
    // archived per a live backend call.
    mockGetTaskCache.mockReturnValue({
      task_id: 'notion:stale',
      fetched_at: 0,
      raw_json: JSON.stringify({ id: 'notion:stale', status: '🗂️ Ready' }),
    });
    mockGetTaskBackend.mockReturnValue({
      fetchTaskSummary: vi.fn().mockResolvedValue({
        title: 'Stale-cached task',
        type: '💻 Code',
        status: '✅ Done',
        archived: true,
      }),
    });

    await expect(
      assertTaskIdResolves('notion:stale', 'proj-1'),
    ).rejects.toThrow(TaskReferenceValidationError);
    expect(mockGetTaskCache).not.toHaveBeenCalled();
  });

  it('falls back to the fetchTaskPage existence check when the backend has no fetchTaskSummary (legacy/test doubles)', async () => {
    mockGetTaskBackend.mockReturnValue({
      fetchTaskPage: vi.fn().mockResolvedValue('## Summary\nSome content\n'),
    });

    await expect(
      assertTaskIdResolves('notion:legacy', 'proj-1'),
    ).resolves.toBeUndefined();
  });
});

describe('assertNoDependencyCycle', () => {
  const PROJECT = 'proj-cycle';

  function makeTask(id: string, dependsOn: string[] = []): NotionTask {
    return {
      id,
      title: `Task ${id}`,
      status: '🗂️ Ready',
      type: '💻 Code',
      dependsOn,
      notionUrl: `https://notion.so/${id}`,
    };
  }

  /** boardId -> NotionTask[]; a board absent from this map reports 'unknown'. */
  function stubBoards(boards: Record<string, NotionTask[]>) {
    mockListMilestonesByProject.mockReturnValue(
      Object.keys(boards).map((id) => ({ id })),
    );
    mockGetTaskCache.mockImplementation((key: string) => {
      const milestoneId = key.startsWith('board:') ? key.slice(6) : null;
      if (milestoneId && milestoneId in boards) {
        return { raw_json: JSON.stringify(boards[milestoneId]) };
      }
      return null;
    });
  }

  beforeEach(() => {
    mockListMilestonesByProject.mockReset();
    mockGetTaskCache.mockReset();
  });

  it('rejects a self-dependency', () => {
    stubBoards({ m1: [] });

    expect(() =>
      assertNoDependencyCycle(PROJECT, 'notion:a', ['notion:a']),
    ).toThrow(DependencyCycleError);
  });

  it('rejects a two-node cycle, naming both task ids', () => {
    // A already depends on B; the write makes B depend on A.
    stubBoards({ m1: [makeTask('a', ['b'])] });

    let thrown: DependencyCycleError | undefined;
    try {
      assertNoDependencyCycle(PROJECT, 'notion:b', ['notion:a']);
    } catch (err) {
      thrown = err as DependencyCycleError;
    }
    expect(thrown).toBeInstanceOf(DependencyCycleError);
    expect(thrown!.message).toContain('notion:a');
    expect(thrown!.message).toContain('notion:b');
  });

  it('rejects a three-node cycle, naming all three ids in path order', () => {
    // Mirrors the observed M15 case: 81d5 -> 8161 -> 81ce -> back to 81d5.
    stubBoards({
      m1: [makeTask('8161', ['81ce']), makeTask('81ce', ['81d5'])],
    });

    let thrown: DependencyCycleError | undefined;
    try {
      assertNoDependencyCycle(PROJECT, 'notion:81d5', ['notion:8161']);
    } catch (err) {
      thrown = err as DependencyCycleError;
    }
    expect(thrown).toBeInstanceOf(DependencyCycleError);
    expect(thrown!.cycle).toEqual(['notion:81d5', 'notion:8161', 'notion:81ce']);
  });

  it('rejects a task.create-shaped write (no subject id) that attaches to an already-cyclic subgraph', () => {
    // A pre-existing cycle among unrelated tasks — attaching a new task to it
    // would make the new task just as permanently undispatchable.
    stubBoards({ m1: [makeTask('x', ['y']), makeTask('y', ['x'])] });

    expect(() =>
      assertNoDependencyCycle(PROJECT, null, ['notion:x']),
    ).toThrow(DependencyCycleError);
  });

  it('accepts a legitimate deep (4-level) acyclic chain spanning two milestone boards', () => {
    stubBoards({
      m1: [makeTask('l2', ['l3']), makeTask('l4', [])],
      m2: [makeTask('l3', ['l4'])],
    });

    expect(() =>
      assertNoDependencyCycle(PROJECT, 'notion:l1', ['notion:l2']),
    ).not.toThrow();
  });

  it('fails open (allows the write) when a board needed to complete the walk has no task_cache row', () => {
    // 'a' depends on 'mid', which would live on the uncached board m2 — were
    // m2 cached and 'mid' found depending back on 'b', this would be a real
    // cycle. With m2 uncached, the walk from 'a' can't be completed, so it
    // must not be treated as proof of "no cycle."
    mockListMilestonesByProject.mockReturnValue([{ id: 'm1' }, { id: 'm2' }]);
    mockGetTaskCache.mockImplementation((key: string) => {
      if (key === 'board:m1') {
        return { raw_json: JSON.stringify([makeTask('a', ['mid'])]) };
      }
      return null; // board:m2 has no cache row
    });

    expect(() =>
      assertNoDependencyCycle(PROJECT, 'notion:b', ['notion:a']),
    ).not.toThrow();
  });

  it('issues zero Notion network calls — resolution is served from task_cache only', () => {
    stubBoards({ m1: [makeTask('a', ['b'])] });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      expect(() =>
        assertNoDependencyCycle(PROJECT, 'notion:z', ['notion:a']),
      ).not.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
