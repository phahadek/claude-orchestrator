import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetTaskBackend = vi.fn();
const mockGetTaskCache = vi.fn();

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: (...args: unknown[]) => mockGetTaskBackend(...args),
}));

vi.mock('../db/queries', () => ({
  getTaskCache: (...args: unknown[]) => mockGetTaskCache(...args),
}));

import {
  assertTaskIdResolves,
  TaskReferenceValidationError,
} from '../tasks/taskReferenceValidation';

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
