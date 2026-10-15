/**
 * Pre-PR re-attribution service. A failed test.request run carrying the
 * awaiting-disposition marker is re-evaluated against the (hardened) F2-gate
 * base-attributable filter whenever new evidence could change the verdict:
 *  - push: an 'ingested' event from testRequestLane narrows to waiting runs
 *    sharing the ingested run's failing test_ids;
 *  - sweep: a Scheduler job (boot + interval) scans only the confirmed-waiting
 *    marker set — never all sessions or runs.
 * Both paths run the same evaluateSubject. A full excuse flips the run
 * failed -> passed with a compare-and-set that also inserts the wake's inbox
 * row in the same transaction, so a run is woken at most once and a crash
 * after commit is recovered by the existing undelivered-inbox retry/boot
 * reconcile.
 */

import fs from 'fs';
import { logger } from '../logger';
import { getProjectById } from '../config';
import {
  getFailingTestIdsForRun,
  getSession,
  getTestRequestRunById,
  listAwaitingDispositionRuns,
  flipRunToPassedAndEnqueueWake,
  clearAwaitingDisposition,
  TERMINAL_SESSION_STATUSES,
} from '../db/queries';
import type { TestRequestRunRow } from '../db/types';
import { filterBaseAttributableFailuresForF2Gate } from './baseAttributableFilter';
import {
  testRequestLaneEvents,
  type TestRequestLaneIngestedEvent,
} from './testRequestLane';
import type { Scheduler } from './Scheduler';

/** Dedicated inbox source — deliberately not 'test_request'. */
export const REATTRIBUTION_FEEDBACK_SOURCE = 'reattribution';

const REATTRIBUTION_SWEEP_INTERVAL_MS = 5 * 60_000;

export interface ReattributionWakeSink {
  deliverReattributionWake(sessionId: string): Promise<void>;
}

export type EvaluateOutcome = 'woken' | 'not_excused' | 'lost_race' | 'skipped';

function buildWakeDedupeKey(runId: string): string {
  return `reattribution:${runId}`;
}

export async function evaluateSubject(
  runId: string,
  sink: ReattributionWakeSink | null,
): Promise<EvaluateOutcome> {
  const run: TestRequestRunRow | undefined = getTestRequestRunById(runId);
  if (!run || run.state !== 'failed' || !run.session_id) return 'skipped';
  if (run.awaiting_disposition_at == null) return 'skipped';

  const project = getProjectById(run.project_id);
  const session = getSession(run.session_id);
  const worktree = session?.worktree_path ?? run.worktree_path;
  if (
    !project ||
    !session ||
    !worktree ||
    TERMINAL_SESSION_STATUSES.has(session.status) ||
    !fs.existsSync(worktree)
  ) {
    // Dead run: drop it from the awaiting set before any git spawn.
    clearAwaitingDisposition(runId);
    return 'skipped';
  }

  const gated = await filterBaseAttributableFailuresForF2Gate(
    project,
    run,
    session.task_id ?? null,
  );
  // The per-test excused markers are written by the unified filter itself.
  if (gated.result.outcome !== 'filtered_pass') return 'not_excused';

  const payload = JSON.stringify({
    runId,
    passed: true,
    output:
      '[test.request] Re-attribution: every remaining failure in your earlier run is now attributable to other trees. The run is now passed; you may proceed (e.g. open your PR).',
    excludedTestIds: gated.result.excludedTests.map((t) => t.test_id),
    flakyExcludedTestIds: gated.result.flakyExcludedTests.map((t) => t.test_id),
  });
  const won = flipRunToPassedAndEnqueueWake(
    runId,
    run.session_id,
    REATTRIBUTION_FEEDBACK_SOURCE,
    payload,
    buildWakeDedupeKey(runId),
  );
  if (!won) return 'lost_race';
  if (sink) {
    try {
      await sink.deliverReattributionWake(run.session_id);
    } catch (err) {
      // The row is durable; the inbox retry sweep / boot reconcile redelivers.
      logger.warn(
        `[reattribution] wake delivery failed for run ${runId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return 'woken';
}

async function reattributeForIngestedRun(
  ingestedRunId: string,
  sink: ReattributionWakeSink | null,
): Promise<number> {
  const failing = getFailingTestIdsForRun(ingestedRunId).map((t) => t.test_id);
  const subjects = listAwaitingDispositionRuns({ failingTestIds: failing });
  let woken = 0;
  for (const s of subjects) {
    if (s.id === ingestedRunId) continue;
    if ((await evaluateSubject(s.id, sink)) === 'woken') woken++;
  }
  return woken;
}

export async function sweepConfirmedWaiting(
  sink: ReattributionWakeSink | null,
): Promise<{ items_processed: number; evaluated: number }> {
  const batchSize = 500;
  let woken = 0;
  let evaluated = 0;
  for (;;) {
    const subjects = listAwaitingDispositionRuns({ limit: batchSize });
    evaluated += subjects.length;
    let drained = 0;
    for (const s of subjects) {
      try {
        if ((await evaluateSubject(s.id, sink)) === 'woken') woken++;
      } catch (err) {
        logger.warn(
          `[reattribution] sweep evaluation failed for run ${s.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (getTestRequestRunById(s.id)?.awaiting_disposition_at == null)
        drained++;
    }
    // Re-query only while a full batch made progress, so live runs behind a
    // large dead backlog are still reached.
    if (subjects.length < batchSize || drained === 0) break;
  }
  logger.info(`[reattribution] sweep evaluated=${evaluated} woken=${woken}`);
  return { items_processed: woken, evaluated };
}

export function startReattributionService(
  scheduler: Scheduler,
  sink: ReattributionWakeSink,
  pausedPRs?: { reattributePausedPRs(): Promise<number> },
): void {
  const runPausedPRs = (): Promise<number> =>
    pausedPRs
      ? pausedPRs.reattributePausedPRs().catch((err) => {
          logger.warn(
            `[reattribution] paused-PR evaluation failed: ${err instanceof Error ? err.message : err}`,
          );
          return 0;
        })
      : Promise.resolve(0);
  testRequestLaneEvents.on(
    'ingested',
    (event: TestRequestLaneIngestedEvent) => {
      if (event.state !== 'failed') return;
      void runPausedPRs();
      reattributeForIngestedRun(event.runId, sink).catch((err) =>
        logger.warn(
          `[reattribution] ingest-triggered evaluation failed for run ${event.runId}: ${err instanceof Error ? err.message : err}`,
        ),
      );
    },
  );
  scheduler.register({
    name: 'reattribution_sweep',
    intervalMs: REATTRIBUTION_SWEEP_INTERVAL_MS,
    runOnBoot: true,
    concurrency: 'skip-if-running',
    run: async () => {
      const waiting = await sweepConfirmedWaiting(sink);
      const paused = await runPausedPRs();
      return { items_processed: waiting.items_processed + paused };
    },
    onError: (err: unknown) =>
      logger.warn('[reattribution] sweep error:', (err as Error).message),
  });
}
