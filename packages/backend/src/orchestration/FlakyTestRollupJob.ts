import { logger } from '../logger';
import type { Scheduler } from './Scheduler';
import { getAllProjects } from '../config';
import type { ProjectConfig } from '../config';
import { typedGetSetting } from '../config/settings';
import { replaceFlaggedFlakyTestsRollup } from '../db/queries';

const INTERVAL_MS = 15 * 60_000;

/**
 * Recomputes flagged_flaky_tests_rollup for every project on a 15-minute
 * cadence, so GET /api/milestones/:project/lane-health can read a
 * project_id-indexed rollup instead of walking full test_run_results
 * history on the request path — see the schema.ts comment on
 * flagged_flaky_tests_rollup for why that scan was expensive (7.6s+ at
 * 1.5M rows, growing daily with the table).
 */
export class FlakyTestRollupJob {
  constructor(
    private readonly options: {
      listProjects?: () => ProjectConfig[];
    } = {},
  ) {}

  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'flaky_test_rollup',
      intervalMs: INTERVAL_MS,
      runOnBoot: true,
      concurrency: 'skip-if-running',
      run: async () => this.runOnce(),
      onError: (err: unknown) =>
        logger.warn('[FlakyTestRollupJob] tick error:', (err as Error).message),
    });
  }

  async runOnce(): Promise<{ items_processed: number }> {
    const listProjects = this.options.listProjects ?? getAllProjects;
    const projects = listProjects();
    const windowN = typedGetSetting('flip_rate_window_n');
    const thresholdK = typedGetSetting('flip_rate_threshold_k');
    const computedAt = Date.now();

    let itemsProcessed = 0;
    for (const project of projects) {
      try {
        const { itemsProcessed: flaggedCount } = replaceFlaggedFlakyTestsRollup(
          project.id,
          windowN,
          thresholdK,
          computedAt,
        );
        itemsProcessed += flaggedCount;
      } catch (err) {
        logger.warn(
          `[FlakyTestRollupJob] failed to refresh project=${project.id}: ${String(err)}`,
        );
      }
    }

    return { items_processed: itemsProcessed };
  }
}
