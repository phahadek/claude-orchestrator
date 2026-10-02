/**
 * The single reader of a run's per-test outcomes.
 *
 * test_request_runs.structured_result is transient —
 * clearExtractedStructuredResultsBatch / clearSupersededStructuredResults
 * (db/queries.ts) null it once the run's test_run_summaries and
 * test_run_results rows exist — so any reader that consults the column
 * directly silently loses data on a replayed or later-read run. Every reader
 * goes through this module instead; a guard test
 * (__tests__/runTestOutcomes.test.ts) rejects direct `.structured_result`
 * reads elsewhere in packages/backend/src.
 *
 * Sources, in order: the raw structured_result while it is still present
 * ('structured'), else the durable extraction output — test_run_summaries
 * counts plus test_run_results failing rows ('extracted'), else nothing
 * ('none').
 */
import {
  getFailingTestIdsForRun,
  getTestRequestRunById,
  getTestRunSummary,
} from '../db/queries';
import type { FailingTestForRun } from '../db/queries';
import type { StructuredTestResult, TestRequestRunRow } from '../db/types';
import { logger } from '../logger';

const runIngestionPromises = new Map<string, Promise<void>>();

/**
 * Called by testRequestLane.ts with a just-completed run's fire-and-forget
 * ingestion dispatch, so getRunTestOutcomes can await it before reading
 * test_run_results. Self-cleans once the dispatch settles.
 */
export function trackRunIngestion(runId: string, promise: Promise<void>): void {
  runIngestionPromises.set(runId, promise);
  const cleanup = () => {
    if (runIngestionPromises.get(runId) === promise) {
      runIngestionPromises.delete(runId);
    }
  };
  promise.then(cleanup, cleanup);
}

/** The run's own in-flight ingestion dispatch, or undefined once settled / if never tracked. */
export function getRunIngestionPromise(
  runId: string,
): Promise<void> | undefined {
  return runIngestionPromises.get(runId);
}

type RunTestOutcomesSource = 'structured' | 'extracted' | 'none';

export interface RunTestOutcomes {
  source: RunTestOutcomesSource;
  failingTests: FailingTestForRun[];
  totals: {
    passed: number;
    failed: number;
    skipped: number;
    errors: number;
    /** passed + failed + skipped + errors. */
    total: number;
  };
  incomplete: boolean;
  /** Suite names — only known while the raw structured_result is present. */
  suiteNames: string[] | null;
  /** The run carried a structured_result that could not be parsed (and no extracted fallback existed). */
  parseFailed: boolean;
  /** The parsed raw result, for renderers that need per-test detail — only when source is 'structured'. */
  structured: StructuredTestResult | null;
}

const NONE: RunTestOutcomes = {
  source: 'none',
  failingTests: [],
  totals: { passed: 0, failed: 0, skipped: 0, errors: 0, total: 0 },
  incomplete: false,
  suiteNames: null,
  parseFailed: false,
  structured: null,
};

/** Outcomes for an in-memory result that has no persisted run row (e.g. verifyRunner's direct, non-lane gate). */
export function outcomesFromStructuredResult(
  parsed: StructuredTestResult,
): RunTestOutcomes {
  const failingTests: FailingTestForRun[] = [];
  const seen = new Set<string>();
  for (const suite of parsed.suites ?? []) {
    for (const test of suite.tests ?? []) {
      if (test.outcome !== 'failed' && test.outcome !== 'error') continue;
      if (seen.has(test.id)) continue;
      seen.add(test.id);
      failingTests.push({
        test_id: test.id,
        name: test.name,
        failure_message: test.failureMessage ?? null,
        failure_trace_excerpt: test.failureTraceExcerpt ?? null,
      });
    }
  }
  const t = parsed.totals;
  const passed = t?.passed ?? 0;
  const failed = t?.failed ?? 0;
  const skipped = t?.skipped ?? 0;
  const errors = t?.errors ?? 0;
  return {
    source: 'structured',
    failingTests,
    totals: {
      passed,
      failed,
      skipped,
      errors,
      total: passed + failed + skipped + errors,
    },
    incomplete: !!parsed.incomplete,
    suiteNames: (parsed.suites ?? []).map((s) => s.name),
    parseFailed: false,
    structured: parsed,
  };
}

/**
 * Synchronous read of `run`'s per-test outcomes. Does NOT wait for an
 * in-flight ingestion — use getRunTestOutcomes when the run just completed.
 */
export function readRunTestOutcomes(run: TestRequestRunRow): RunTestOutcomes {
  let parseFailed = false;
  if (run.structured_result) {
    try {
      return outcomesFromStructuredResult(JSON.parse(run.structured_result));
    } catch (err) {
      parseFailed = true;
      logger.warn(
        `[runTestOutcomes] failed to parse structured_result for run ${run.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const summary = getTestRunSummary(run.id);
  if (summary) {
    return {
      source: 'extracted',
      failingTests: getFailingTestIdsForRun(run.id),
      totals: {
        passed: summary.passed_count,
        failed: summary.failed_count,
        skipped: summary.skipped_count,
        errors: summary.error_count,
        total: summary.total_count,
      },
      incomplete: !!summary.incomplete,
      suiteNames: null,
      parseFailed: false,
      structured: null,
    };
  }

  return { ...NONE, parseFailed };
}

async function awaitPendingIngestion(runId: string): Promise<void> {
  const pending = getRunIngestionPromise(runId);
  if (!pending) return;
  try {
    await pending;
  } catch (err) {
    logger.warn(
      `[runTestOutcomes] ingestion failed for run ${runId} — reading a possibly-incomplete outcome set: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Awaits `run`'s own pending ingestion (the fire-and-forget worker dispatch
 * in testRequestLane.ts writes test_run_results after the run settles), then
 * reads its per-test outcomes from the row the caller already holds — no
 * extra db/queries round trip to re-fetch the run itself.
 */
export async function getRunTestOutcomesForRun(
  run: TestRequestRunRow,
): Promise<RunTestOutcomes> {
  await awaitPendingIngestion(run.id);
  return readRunTestOutcomes(run);
}

/**
 * Same as getRunTestOutcomesForRun, but for a caller that only has the run's
 * id (e.g. a persisted reference with no row fetched yet).
 */
export async function getRunTestOutcomes(
  runId: string,
): Promise<RunTestOutcomes> {
  await awaitPendingIngestion(runId);
  const run = getTestRequestRunById(runId);
  if (!run) return NONE;
  return readRunTestOutcomes(run);
}
