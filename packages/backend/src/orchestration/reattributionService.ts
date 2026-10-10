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

import { logger } from '../logger';
import { getProjectById } from '../config';
import {
  getFailingTestIdsForRun,
  getPRBySessionId,
  getSession,
  getTestRequestRunById,
  listAwaitingDispositionRuns,
  flipRunToPassedAndEnqueueWake,
} from '../db/queries';
import type { TestRequestRunRow } from '../db/types';
import { getChangedFiles } from '../session/autofix-runner';
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
  if (!project || !session || !worktree) return 'skipped';

  let changedFiles: string[];
  try {
    const pr = getPRBySessionId(run.session_id);
    changedFiles = await getChangedFiles(
      worktree,
      pr?.base_branch ?? project.baseBranch,
    );
  } catch (err) {
    // Unknown diff fails closed: nothing is excused.
    logger.warn(
      `[reattribution] changed files unavailable for run ${runId}: ${err instanceof Error ? err.message : err}`,
    );
    return 'skipped';
  }

  const gated = await filterBaseAttributableFailuresForF2Gate(
    project,
    run,
    changedFiles,
    session.task_id ?? null,
  );
  // The per-test excused markers are written by the filter itself
  // (applyF2GateMaskingGuards -> writeExcusedMarkers, on every return path).
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
): Promise<{ items_processed: number }> {
  const subjects = listAwaitingDispositionRuns();
  let woken = 0;
  for (const s of subjects) {
    try {
      if ((await evaluateSubject(s.id, sink)) === 'woken') woken++;
    } catch (err) {
      logger.warn(
        `[reattribution] sweep evaluation failed for run ${s.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return { items_processed: woken };
}

export function startReattributionService(
  scheduler: Scheduler,
  sink: ReattributionWakeSink,
): void {
  testRequestLaneEvents.on(
    'ingested',
    (event: TestRequestLaneIngestedEvent) => {
      if (event.state !== 'failed') return;
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
    run: async () => sweepConfirmedWaiting(sink),
    onError: (err: unknown) =>
      logger.warn('[reattribution] sweep error:', (err as Error).message),
  });
}
