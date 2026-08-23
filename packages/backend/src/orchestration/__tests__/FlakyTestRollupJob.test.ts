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
