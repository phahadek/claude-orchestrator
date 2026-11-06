import { logger } from '../logger';
import type { Scheduler } from './Scheduler';
import {
  getJobBootSchedule,
  pruneTestRunResultsOlderThan,
} from '../db/queries';

const JOB_NAME = 'test_run_results_pruner';
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Every reader of raw non-passing rows is windowed far shorter (24h default);
// 14 days is a safe margin.
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 5000;

export class TestRunResultsPruner {
  constructor(
    private readonly options: {
      nowFn?: () => number;
      batchSize?: number;
    } = {},
  ) {}

  register(scheduler: Scheduler): void {
    const schedule = getJobBootSchedule(JOB_NAME, PRUNE_INTERVAL_MS);
    scheduler.register({
      name: JOB_NAME,
      intervalMs: PRUNE_INTERVAL_MS,
      runOnBoot: schedule.runOnBoot,
      initialDelayMs: schedule.initialDelayMs,
      concurrency: 'skip-if-running',
      run: async () => {
        await this.pruneOnce();
      },
    });
  }

  async pruneOnce(): Promise<void> {
    try {
      const now = this.options.nowFn ? this.options.nowFn() : Date.now();
      const deleted = pruneTestRunResultsOlderThan(
        now - RETENTION_MS,
        this.options.batchSize ?? BATCH_SIZE,
      );
      if (deleted > 0) {
        logger.info(
          `[TestRunResultsPruner] pruned ${deleted} test_run_results row(s)`,
        );
      }
    } catch (err) {
      logger.error('[TestRunResultsPruner] pruneOnce error:', err);
    }
  }
}
