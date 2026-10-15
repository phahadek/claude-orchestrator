/**
 * Tests for FlakyTestRollupJob (packages/backend/src/orchestration/FlakyTestRollupJob.ts).
 *
 * AC: refreshes flagged_flaky_tests_rollup for every project on each tick,
 * reading flip_rate_window_n/flip_rate_threshold_k off settings; a
 * per-project failure is caught and doesn't abort the remaining projects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queriesMock = vi.hoisted(() => ({
  replaceFlaggedFlakyTestsRollup: vi.fn(() => ({ itemsProcessed: 0 })),
}));
const settingsMock = vi.hoisted(() => ({
  typedGetSetting: vi.fn((key: string) =>
    key === 'flip_rate_window_n' ? 20 : 2,
  ),
}));

const loggerMock = vi.hoisted(() => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../logger.js', () => loggerMock);
vi.mock('../../db/queries.js', () => queriesMock);
vi.mock('../../config/settings.js', () => settingsMock);

import { FlakyTestRollupJob } from '../FlakyTestRollupJob.js';
import { replaceFlaggedFlakyTestsRollup } from '../../db/queries.js';

beforeEach(() => {
  vi.clearAllMocks();
  queriesMock.replaceFlaggedFlakyTestsRollup.mockReturnValue({
    itemsProcessed: 0,
  });
  settingsMock.typedGetSetting.mockImplementation((key: string) =>
    key === 'flip_rate_window_n' ? 20 : 2,
  );
});

describe('FlakyTestRollupJob', () => {
  it('refreshes the rollup for every project, with the configured window/threshold', async () => {
    const job = new FlakyTestRollupJob({
      listProjects: () => [{ id: 'proj-1' } as any, { id: 'proj-2' } as any],
    });

    await job.runOnce();

    expect(replaceFlaggedFlakyTestsRollup).toHaveBeenCalledTimes(2);
    expect(replaceFlaggedFlakyTestsRollup).toHaveBeenNthCalledWith(
      1,
      'proj-1',
      20,
      2,
      expect.any(Number),
    );
    expect(replaceFlaggedFlakyTestsRollup).toHaveBeenNthCalledWith(
      2,
      'proj-2',
      20,
      2,
      expect.any(Number),
    );
  });

  it('dispatches all projects concurrently instead of awaiting each worker spawn in turn', async () => {
    // Regression test for the O(project count) serialized worker-thread
    // spawn: each replaceFlaggedFlakyTestsRollup call here defers via a
    // pending promise, so if runOnce awaited them one at a time (the old
    // for-await loop), only the first project's call would ever fire before
    // this test's own await on job.runOnce() hangs forever. Dispatching
    // concurrently issues every project's call up front, letting all of
    // them resolve together off a single flush.
    const pending: Array<() => void> = [];
    queriesMock.replaceFlaggedFlakyTestsRollup.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve({ itemsProcessed: 0 }));
        }),
    );

    const projectIds = ['proj-1', 'proj-2', 'proj-3', 'proj-4'];
    const job = new FlakyTestRollupJob({
      listProjects: () => projectIds.map((id) => ({ id }) as any),
    });

    const resultPromise = job.runOnce();

    // Let the synchronous dispatch phase run without resolving anything yet.
    await Promise.resolve();
    await Promise.resolve();

    expect(replaceFlaggedFlakyTestsRollup).toHaveBeenCalledTimes(
      projectIds.length,
    );

    pending.forEach((resolve) => resolve());
    await resultPromise;
  });

  it('warns with per-project phase timings when a zero-item tick exceeds 1000ms', async () => {
    vi.useFakeTimers();
    try {
      queriesMock.replaceFlaggedFlakyTestsRollup.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  itemsProcessed: 0,
                  timings: {
                    spawnToOnlineMs: 1500,
                    dbOpenMs: 2,
                    candidatesMs: 3,
                    ghostCheckMs: 4,
                    workerTotalMs: 10,
                  },
                }),
              1200,
            );
          }),
      );
      const job = new FlakyTestRollupJob({
        listProjects: () => [{ id: 'proj-slow' } as any],
      });
      const promise = job.runOnce();
      await vi.advanceTimersByTimeAsync(1300);
      const result = await promise;

      expect(result.items_processed).toBe(0);
      expect(loggerMock.logger.warn).toHaveBeenCalledTimes(1);
      const line = loggerMock.logger.warn.mock.calls[0][0] as string;
      expect(line).toContain('proj-slow');
      expect(line).toContain('"spawnToOnlineMs":1500');
      expect(line).toContain('"workerTotalMs":10');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not warn on a fast zero-item tick', async () => {
    const job = new FlakyTestRollupJob({
      listProjects: () => [{ id: 'proj-1' } as any],
    });
    await job.runOnce();
    expect(loggerMock.logger.warn).not.toHaveBeenCalled();
  });

  it('continues refreshing remaining projects when one project fails', async () => {
    queriesMock.replaceFlaggedFlakyTestsRollup
      .mockImplementationOnce(() => {
        throw new Error('boom');
      })
      .mockImplementationOnce(() => ({ itemsProcessed: 3 }));

    const job = new FlakyTestRollupJob({
      listProjects: () => [{ id: 'proj-bad' } as any, { id: 'proj-ok' } as any],
    });

    const result = await job.runOnce();

    expect(replaceFlaggedFlakyTestsRollup).toHaveBeenCalledTimes(2);
    expect(result.items_processed).toBe(3);
  });
});
