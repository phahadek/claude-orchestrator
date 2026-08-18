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
 * flagged_flaky_tests_rollup for why a from-scratch scan is expensive
 * (previously 7.6s+ at 1.5M rows, growing daily with the table).
 * replaceFlaggedFlakyTestsRollup recomputes incrementally off a durable
 * per-project watermark, so a typical tick only touches the handful of test
 * ids with new results since the last one. Each project's recompute runs on
 * a worker thread of its own — see flakyTestRollupWorker.ts — so this loop's
 * `await` never blocks the shared main-thread event loop for the scan's
 * duration, only for its own negligible per-project bookkeeping.
 *
 * `items_processed` is the total number of test ids recomputed across all
 * projects this tick — real work performed, not the number flagged. A tick
 * that examines new rows but flags none is still reported as non-zero work.
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
        const { itemsProcessed: testsRecomputed } =
          await replaceFlaggedFlakyTestsRollup(
            project.id,
            windowN,
            thresholdK,
            computedAt,
          );
        itemsProcessed += testsRecomputed;
      } catch (err) {
        logger.warn(
          `[FlakyTestRollupJob] failed to refresh project=${project.id}: ${String(err)}`,
        );
      }
    }

    return { items_processed: itemsProcessed };
  }
}
