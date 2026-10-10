import {
  listStaleRunnerExecutedTestRequestRuns,
  failStaleRunnerExecutedTestRequestRun,
} from '../db/queries';
import { announceRunnerUnreachableRun } from './testRequestLane';
import { logger } from '../logger';
import type { Scheduler } from './Scheduler';

/** Longest legitimate runner-executed run; the grace period must exceed it. */
export const RUNNER_RUN_TIMEOUT_MS = 60 * 60_000;
/** Slack on top of the run timeout before silence is presumed unreachability. */
export const RUNNER_UNREACHABLE_MARGIN_MS = 5 * 60_000;
export const RUNNER_UNREACHABLE_GRACE_MS =
  RUNNER_RUN_TIMEOUT_MS + RUNNER_UNREACHABLE_MARGIN_MS;
export const RUNNER_UNREACHABILITY_SWEEP_INTERVAL_MS = 60_000;

/**
 * Settles runner-executed rows stuck 'queued'/'running' past the grace period
 * as failed/'runner_unreachable' — covers both a runner that never pulled an
 * admitted run and one that went silent mid-run. Each write is an atomic
 * state-guarded UPDATE, so a result package that settles a row first always
 * wins over the sweep's presumptive failure.
 */
export function sweepRunnerUnreachability(
  now: number = Date.now(),
  graceMs: number = RUNNER_UNREACHABLE_GRACE_MS,
): number {
  const cutoff = now - graceMs;
  let settled = 0;
  for (const run of listStaleRunnerExecutedTestRequestRuns(cutoff)) {
    const output = `[runnerUnreachabilityReconciler] runner ${
      run.state === 'queued' ? 'never pulled the run' : 'went silent mid-run'
    } — no result package within the grace period`;
    if (!failStaleRunnerExecutedTestRequestRun(run.id, output, cutoff)) {
      continue;
    }
    logger.warn(
      `[runnerUnreachabilityReconciler] run ${run.id} (project ${run.project_id}) settled failed (runner_unreachable)`,
    );
    announceRunnerUnreachableRun(run, output);
    settled++;
  }
  return settled;
}

export function register(scheduler: Scheduler): void {
  scheduler.register({
    name: 'runner_unreachability_sweep',
    intervalMs: RUNNER_UNREACHABILITY_SWEEP_INTERVAL_MS,
    runOnBoot: false,
    concurrency: 'skip-if-running',
    run: async () => ({ items_processed: sweepRunnerUnreachability() }),
  });
}
