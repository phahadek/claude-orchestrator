import { logger } from '../logger';
import type { Scheduler } from './Scheduler';
import {
  getStandardSessionWallClockSample,
  insertFlowHealthRegressionSnapshot,
  getLatestFlowHealthRegressionSnapshot,
  percentilesOf,
} from '../db/queries';
import type { FlowHealthRegressionSnapshotRow } from '../db/types';

const INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // trailing 7 days

/** Locked by decision.pickOne e83696d6-cec4-45d7-af55-e0357cc0db93: p50 wall-clock > 60min crosses to 'regressed'. */
const REGRESSION_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Fixed historical cutoff for excluding archived+killed+no-reason
 * "bookkeeping artifact" kills from the sample set (decision.pickOne
 * d91fc3fb-3615-4cd1-9959-7395a4b6014f): the deploy timestamp of "Persist
 * terminal_completion_reason at every session stop path" (commit c6b59fc5,
 * 2026-08-24T09:36:49-07:00), the sibling task that made
 * terminal_completion_reason durable at every stop path. Deliberately NOT
 * open-ended — per the completeness-critic finding on disposition record 87
 * (intent 1abdac3c-9dbb-403d-8496-0f9b33ec5b7a), any unattributed kill
 * *after* this cutoff is itself a fresh gap and must count toward the
 * regression signal, not be silently excluded.
 */
const ARTIFACT_EXCLUSION_CUTOFF_MS = 1787589409000;

type SnapshotFields = Omit<FlowHealthRegressionSnapshotRow, 'id' | 'ts'>;

function sameSnapshot(
  latest: FlowHealthRegressionSnapshotRow,
  next: SnapshotFields,
): boolean {
  return (
    latest.window_start === next.window_start &&
    latest.window_end === next.window_end &&
    latest.sample_count === next.sample_count &&
    latest.p50_wall_clock_ms === next.p50_wall_clock_ms &&
    latest.status === next.status &&
    latest.excluded_artifact_count === next.excluded_artifact_count
  );
}

/**
 * Samples the trailing 7-day median wall-clock for ended 'standard' code
 * sessions once a day and writes a flow_health_regression_snapshot row only
 * when it differs from the latest stored snapshot — mirrors
 * ConvergenceSnapshotJob's dedup-on-write shape.
 *
 * In-flight sessions (ended_at IS NULL) never enter the sample set — a
 * session with no wall-clock duration yet cannot contribute one.
 * Archived+killed+no-reason kills started before the fixed
 * ARTIFACT_EXCLUSION_CUTOFF_MS are excluded from the sample set and counted
 * separately in excluded_artifact_count, rather than folded into the
 * regression signal or silently dropped.
 */
export class FlowHealthRegressionSnapshotJob {
  register(scheduler: Scheduler): void {
    scheduler.register({
      name: 'flow_health_regression_snapshot',
      intervalMs: INTERVAL_MS,
      runOnBoot: true,
      concurrency: 'skip-if-running',
      run: async () => this.runOnce(),
      onError: (err: unknown) =>
        logger.warn(
          '[FlowHealthRegressionSnapshotJob] tick error:',
          (err as Error).message,
        ),
    });
  }

  runOnce(): { items_processed: number } {
    const windowEnd = Date.now();
    const windowStart = windowEnd - WINDOW_MS;

    const { durationsMs, excludedArtifactCount } =
      getStandardSessionWallClockSample(
        windowStart,
        windowEnd,
        ARTIFACT_EXCLUSION_CUTOFF_MS,
      );

    const p50 = percentilesOf(durationsMs).p50;
    const status: FlowHealthRegressionSnapshotRow['status'] =
      p50 !== null && p50 > REGRESSION_THRESHOLD_MS ? 'regressed' : 'ok';

    const snapshot: SnapshotFields = {
      window_start: windowStart,
      window_end: windowEnd,
      sample_count: durationsMs.length,
      p50_wall_clock_ms: p50,
      status,
      excluded_artifact_count: excludedArtifactCount,
    };

    const latest = getLatestFlowHealthRegressionSnapshot();
    if (latest && sameSnapshot(latest, snapshot)) {
      return { items_processed: 0 };
    }

    insertFlowHealthRegressionSnapshot({
      ...snapshot,
      ts: new Date().toISOString(),
    });
    return { items_processed: 1 };
  }
}
