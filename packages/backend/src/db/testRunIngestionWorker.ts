// Worker-thread entry point for a single test.request lane run's result
// extraction + baseline computation (ingestTestRunResultsOffMainThread in
// db/queries.ts).
//
// A solo run (no concurrent peer) still walks every touched test through
// computeTestPerfBaseline synchronously today; for a large suite (~10.5k
// tests) that recompute alone was measured blocking the main thread for
// tens of seconds. This file runs on a separate worker thread and opens its
// OWN connection against the same on-disk database file, mirroring
// flakyTestRollupWorker.ts's precedent (see that file's doc comment for why
// db.ts/queries.ts can't be imported here: doing so would re-run db.ts's
// module side effects on this thread, and queries.ts's prepared statements
// are bound to the main-thread singleton connection).
//
// Extraction commits a write transaction once ~TX_TIME_BUDGET_MS of work has
// accumulated (or `batchSize` tests, default 500, whichever comes first), with
// all per-test reads done outside the transaction — a multi-second write
// transaction would hold the WAL write lock and block every main-thread write
// in its busy-timeout retry loop, re-creating the freeze this worker exists
// to remove.
//
// Callers MUST single-flight dispatch of this worker per project — see
// testRequestLane.ts's per-project ingestion queue. Two connections against
// the same file racing recordTestPerfDigestSample's read-modify-write of a
// test's digest would last-writer-wins and silently drop samples.
import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';
import {
  insertTestSample,
  pruneTestSamples,
  readRecentTestDurations,
  readRecentTestOutcomes,
  type TestSampleOutcome,
} from './testSampleStore';

interface WorkerTestRow {
  test_id: string;
  name: string;
  outcome: string;
  duration_ms: number;
  failureMessage?: string;
  failureTraceExcerpt?: string;
  markers?: string[];
}

interface TestRunIngestionWorkerData {
  dbPath: string;
  testRequestRunId: string;
  projectId: string;
  tests: WorkerTestRow[];
  concurrentRunCount: number | null;
  oomKilled: boolean;
  incomplete: boolean;
  foreignConcurrentRunCount: number | null;
  timedOut: boolean;
  contentHash: string | null;
  batchSize: number;
  flipRateWindowN: number;
  flipRateThresholdK: number;
}

interface TestRunIngestionWorkerResult {
  alreadyExtracted: boolean;
  processed: number;
  /** Number of write transactions committed against this run's tables — 0 when alreadyExtracted. */
  commitCount: number;
}

// Mirrors BASELINE_WINDOW_SAMPLES/MIN_CONSECUTIVE_REGRESSED_SAMPLES/
// REGRESSION_K in orchestration/testRequestLane.ts's computeTestPerfBaseline.
const BASELINE_WINDOW_SAMPLES = 20;
const MIN_CONSECUTIVE_REGRESSED_SAMPLES = 3;
const REGRESSION_K = 3;

// Elapsed-time bound on any single extraction write transaction.
const TX_TIME_BUDGET_MS = 50;

// Duration window read back from test_sample (its duration retention).
const BASELINE_DURATION_READ_LIMIT = 32;

interface TestOutcomeCounts {
  passed: number;
  failed: number;
  skipped: number;
  error: number;
  other: number;
}

let stmtInsertTestRunResult: Database.Statement | null = null;
let stmtUpsertTestPerfDigest: Database.Statement | null = null;
let stmtUpsertTestPerfBaseline: Database.Statement | null = null;

/** Mirrors insertTestRunResults in db/queries.ts, minus its own inner transaction — the caller batches this. */
function insertTestRunResult(
  database: Database.Database,
  testRequestRunId: string,
  projectId: string,
  item: WorkerTestRow,
  concurrentRunCount: number | null,
  oomKilled: boolean,
): void {
  stmtInsertTestRunResult ??= database.prepare(`
    INSERT INTO test_run_results
      (test_request_run_id, project_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, failure_message, failure_trace_excerpt, markers, created_at)
    VALUES
      (@test_request_run_id, @project_id, @test_id, @name, @outcome, @duration_ms, @concurrent_run_count, @oom_killed, @failure_message, @failure_trace_excerpt, @markers, @created_at)
  `);
  stmtInsertTestRunResult.run({
    test_request_run_id: testRequestRunId,
    project_id: projectId,
    test_id: item.test_id,
    name: item.name,
    outcome: item.outcome,
    duration_ms: item.duration_ms,
    concurrent_run_count: concurrentRunCount,
    oom_killed: oomKilled ? 1 : 0,
    failure_message: item.failureMessage ?? null,
    failure_trace_excerpt: item.failureTraceExcerpt ?? null,
    markers:
      item.markers && item.markers.length > 0
        ? JSON.stringify(item.markers)
        : null,
    created_at: Date.now(),
  });
}

/** Mirrors insertTestRunSummary in db/queries.ts. */
function insertTestRunSummary(
  database: Database.Database,
  testRequestRunId: string,
  projectId: string,
  counts: TestOutcomeCounts,
  totalCount: number,
  totalDurationMs: number,
  concurrentRunCount: number | null,
  oomKilled: boolean,
  incomplete: boolean,
): void {
  database
    .prepare(
      `INSERT INTO test_run_summaries
         (test_request_run_id, project_id, passed_count, failed_count, skipped_count, error_count, other_count, total_count, total_duration_ms, concurrent_run_count, oom_killed, incomplete, created_at)
       VALUES
         (@test_request_run_id, @project_id, @passed_count, @failed_count, @skipped_count, @error_count, @other_count, @total_count, @total_duration_ms, @concurrent_run_count, @oom_killed, @incomplete, @created_at)`,
    )
    .run({
      test_request_run_id: testRequestRunId,
      project_id: projectId,
      passed_count: counts.passed,
      failed_count: counts.failed,
      skipped_count: counts.skipped,
      error_count: counts.error,
      other_count: counts.other,
      total_count: totalCount,
      total_duration_ms: totalDurationMs,
      concurrent_run_count: concurrentRunCount,
      oom_killed: oomKilled ? 1 : 0,
      incomplete: incomplete ? 1 : 0,
      created_at: Date.now(),
    });
}

interface DigestAdmission {
  durationAdmitted: boolean;
  outcomeAdmitted: boolean;
}

/** Pure admission decision from recordTestPerfDigestSample in db/queries.ts. */
function digestAdmission(
  outcome: string,
  concurrentRunCount: number | null,
  oomKilled: boolean,
  foreignConcurrentRunCount: number | null,
  timedOut: boolean,
): DigestAdmission | null {
  if (oomKilled || timedOut) return null;
  const durationAdmitted =
    concurrentRunCount === 0 && (foreignConcurrentRunCount ?? 0) === 0;
  const outcomeAdmitted = outcome === 'passed' || outcome === 'failed';
  if (!durationAdmitted && !outcomeAdmitted) return null;
  return { durationAdmitted, outcomeAdmitted };
}

/** Write half of recordTestPerfDigestSample in db/queries.ts. */
function writeTestPerfDigestSample(
  database: Database.Database,
  testId: string,
  projectId: string,
  name: string,
  outcome: string,
  durationMs: number,
  sequencedAt: number,
  markers: string[] | undefined,
  contentHash: string | null,
  runId: string,
  admission: DigestAdmission,
): void {
  const { durationAdmitted, outcomeAdmitted } = admission;
  stmtUpsertTestPerfDigest ??= database.prepare(`
    INSERT INTO test_perf_baselines
      (test_id, project_id, name, median_duration_ms, mad_duration_ms, sample_count, last_duration_ms, is_regressed, markers, updated_at)
    VALUES
      (@test_id, @project_id, @name, 0, 0, 0, @last_duration_ms, 0, @markers, @updated_at)
    ON CONFLICT(test_id) DO UPDATE SET
      project_id = excluded.project_id,
      name = excluded.name,
      markers = COALESCE(excluded.markers, test_perf_baselines.markers),
      updated_at = excluded.updated_at
  `);
  stmtUpsertTestPerfDigest.run({
    test_id: testId,
    project_id: projectId,
    name,
    last_duration_ms: durationAdmitted ? durationMs : 0,
    markers: markers && markers.length > 0 ? JSON.stringify(markers) : null,
    updated_at: sequencedAt,
  });

  insertTestSample(database, {
    testId,
    projectId,
    runId,
    sequencedAt,
    outcome: outcomeAdmitted ? (outcome === 'passed' ? 'P' : 'F') : null,
    durationMs: durationAdmitted ? durationMs : null,
    contentHash: contentHash || null,
  });
  pruneTestSamples(database, testId);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function medianAbsoluteDeviation(values: number[], center: number): number {
  const deviations = values
    .map((v) => Math.abs(v - center))
    .sort((a, b) => a - b);
  return median(deviations);
}

/** Mirrors upsertTestPerfBaseline in db/queries.ts. */
function upsertTestPerfBaseline(
  database: Database.Database,
  row: {
    test_id: string;
    median_duration_ms: number;
    mad_duration_ms: number;
    sample_count: number;
    last_duration_ms: number;
    is_regressed: boolean;
  },
): void {
  stmtUpsertTestPerfBaseline ??= database.prepare(`
    INSERT INTO test_perf_baselines
      (test_id, median_duration_ms, mad_duration_ms, sample_count, last_duration_ms, is_regressed, updated_at)
    VALUES
      (@test_id, @median_duration_ms, @mad_duration_ms, @sample_count, @last_duration_ms, @is_regressed, @updated_at)
    ON CONFLICT(test_id) DO UPDATE SET
      median_duration_ms = excluded.median_duration_ms,
      mad_duration_ms = excluded.mad_duration_ms,
      sample_count = excluded.sample_count,
      last_duration_ms = excluded.last_duration_ms,
      is_regressed = excluded.is_regressed
  `);
  stmtUpsertTestPerfBaseline.run({
    test_id: row.test_id,
    median_duration_ms: row.median_duration_ms,
    mad_duration_ms: row.mad_duration_ms,
    sample_count: row.sample_count,
    last_duration_ms: row.last_duration_ms,
    is_regressed: row.is_regressed ? 1 : 0,
    updated_at: Date.now(),
  });
}

interface BaselineRow {
  test_id: string;
  median_duration_ms: number;
  mad_duration_ms: number;
  sample_count: number;
  last_duration_ms: number;
  is_regressed: boolean;
}

/** Pure half of computeTestPerfBaseline in orchestration/testRequestLane.ts. */
function computeBaselineRow(
  testId: string,
  durations: number[],
): BaselineRow | null {
  const samples = durations.slice(
    0,
    BASELINE_WINDOW_SAMPLES + MIN_CONSECUTIVE_REGRESSED_SAMPLES,
  );
  if (samples.length === 0) return null;

  const lastDuration = samples[0];

  if (samples.length <= MIN_CONSECUTIVE_REGRESSED_SAMPLES) {
    const sorted = [...samples].sort((a, b) => a - b);
    const med = median(sorted);
    return {
      test_id: testId,
      median_duration_ms: med,
      mad_duration_ms: medianAbsoluteDeviation(samples, med),
      sample_count: samples.length,
      last_duration_ms: lastDuration,
      is_regressed: false,
    };
  }

  const recent = samples.slice(0, MIN_CONSECUTIVE_REGRESSED_SAMPLES);
  const baselineSamples = samples.slice(MIN_CONSECUTIVE_REGRESSED_SAMPLES);
  const sortedBaseline = [...baselineSamples].sort((a, b) => a - b);
  const baselineMedian = median(sortedBaseline);
  const baselineMad = medianAbsoluteDeviation(baselineSamples, baselineMedian);
  const threshold = baselineMedian + REGRESSION_K * baselineMad;
  return {
    test_id: testId,
    median_duration_ms: baselineMedian,
    mad_duration_ms: baselineMad,
    sample_count: baselineSamples.length,
    last_duration_ms: lastDuration,
    is_regressed: recent.every((d) => d > threshold),
  };
}

/** Mirrors computeTestFlipRateFlagFromOutcomes in db/queries.ts — log-only here, nothing persisted. */
function logFlipRateFlagIfFlagged(
  testId: string,
  outcomes: TestSampleOutcome[],
  windowN: number,
  thresholdK: number,
): void {
  const windowed = outcomes.slice(-windowN);
  let transitionCount = 0;
  for (let i = 1; i < windowed.length; i++) {
    if (windowed[i].o !== windowed[i - 1].o) transitionCount++;
  }
  if (transitionCount >= thresholdK) {
    console.log(
      `[testRunIngestionWorker] test ${testId} flagged flaky: ${transitionCount} transitions in last ${windowed.length} valid samples`,
    );
  }
}

interface PreparedTest {
  item: WorkerTestRow;
  sequencedAt: number;
  admission: DigestAdmission | null;
  baseline: BaselineRow | null;
}

interface TestHistory {
  durations: number[];
  outcomes: TestSampleOutcome[];
}

export interface ExtractOptions {
  now: () => number;
  budgetMs: number;
}

/**
 * Extraction in write transactions bounded by elapsed time (opts.budgetMs)
 * and, secondarily, by data.batchSize rows. Per-test reads and baseline math
 * happen outside any write transaction, so the WAL write lock is held only
 * for the INSERT/UPSERT statements. Safe because callers single-flight this
 * worker per project (see file header): no other writer changes a test's
 * samples between our read and our write.
 */
export function extractTests(
  database: Database.Database,
  data: Pick<
    TestRunIngestionWorkerData,
    | 'testRequestRunId'
    | 'projectId'
    | 'tests'
    | 'concurrentRunCount'
    | 'oomKilled'
    | 'foreignConcurrentRunCount'
    | 'contentHash'
    | 'timedOut'
    | 'batchSize'
    | 'flipRateWindowN'
    | 'flipRateThresholdK'
  >,
  opts: ExtractOptions,
): { commitDurationsMs: number[] } {
  const batchSize = data.batchSize > 0 ? data.batchSize : 500;
  const baseSequence = Date.now() * 1000;
  const histories = new Map<string, TestHistory>();
  const commitDurationsMs: number[] = [];

  const prepare = (item: WorkerTestRow, index: number): PreparedTest => {
    const sequencedAt = baseSequence + index;
    const admission = digestAdmission(
      item.outcome,
      data.concurrentRunCount,
      data.oomKilled,
      data.foreignConcurrentRunCount,
      data.timedOut,
    );
    if (!admission) {
      return { item, sequencedAt, admission, baseline: null };
    }
    let history = histories.get(item.test_id);
    if (!history) {
      history = {
        durations: readRecentTestDurations(
          database,
          item.test_id,
          BASELINE_DURATION_READ_LIMIT,
        ),
        outcomes: readRecentTestOutcomes(
          database,
          item.test_id,
          data.flipRateWindowN,
        ),
      };
      histories.set(item.test_id, history);
    }
    if (admission.durationAdmitted) {
      history.durations = [item.duration_ms, ...history.durations].slice(
        0,
        BASELINE_DURATION_READ_LIMIT,
      );
    }
    if (admission.outcomeAdmitted) {
      const sample: TestSampleOutcome = {
        o: item.outcome === 'passed' ? 'P' : 'F',
        t: sequencedAt,
      };
      if (data.contentHash) sample.h = data.contentHash;
      history.outcomes = [...history.outcomes, sample].slice(
        -data.flipRateWindowN,
      );
    }
    logFlipRateFlagIfFlagged(
      item.test_id,
      history.outcomes,
      data.flipRateWindowN,
      data.flipRateThresholdK,
    );
    return {
      item,
      sequencedAt,
      admission,
      baseline: admission.durationAdmitted
        ? computeBaselineRow(item.test_id, history.durations)
        : null,
    };
  };

  const writeOne = (p: PreparedTest): void => {
    const { item } = p;
    if (item.outcome !== 'passed') {
      insertTestRunResult(
        database,
        data.testRequestRunId,
        data.projectId,
        item,
        data.concurrentRunCount,
        data.oomKilled,
      );
    }
    if (!p.admission) return;
    writeTestPerfDigestSample(
      database,
      item.test_id,
      data.projectId,
      item.name,
      item.outcome,
      item.duration_ms,
      p.sequencedAt,
      item.markers,
      data.contentHash,
      data.testRequestRunId,
      p.admission,
    );
    if (p.baseline) upsertTestPerfBaseline(database, p.baseline);
  };

  const prepareGroupSize = Math.min(batchSize, 100);
  let next = 0;
  while (next < data.tests.length) {
    const end = Math.min(next + prepareGroupSize, data.tests.length);
    const group: PreparedTest[] = [];
    for (let i = next; i < end; i++) group.push(prepare(data.tests[i], i));
    next = end;

    let pos = 0;
    while (pos < group.length) {
      const tx = database.transaction(() => {
        const start = opts.now();
        let rows = 0;
        while (pos < group.length && rows < batchSize) {
          writeOne(group[pos++]);
          rows++;
          if (opts.now() - start >= opts.budgetMs) break;
        }
        return opts.now() - start;
      });
      commitDurationsMs.push(tx());
    }
  }
  return { commitDurationsMs };
}

function run(): TestRunIngestionWorkerResult {
  const data = workerData as TestRunIngestionWorkerData;
  const database = new Database(data.dbPath);
  // See flakyTestRollupWorker.ts's identical pragma comment for why these
  // matter for short-lived file-backed test databases specifically.
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  try {
    const alreadyExtracted = database
      .prepare(`SELECT 1 FROM test_run_summaries WHERE test_request_run_id = ?`)
      .get(data.testRequestRunId);
    if (alreadyExtracted) {
      return { alreadyExtracted: true, processed: 0, commitCount: 0 };
    }

    const counts: TestOutcomeCounts = {
      passed: 0,
      failed: 0,
      skipped: 0,
      error: 0,
      other: 0,
    };
    let totalDurationMs = 0;
    for (const t of data.tests) {
      totalDurationMs += t.duration_ms;
      if (t.outcome === 'passed') counts.passed++;
      else if (t.outcome === 'failed') counts.failed++;
      else if (t.outcome === 'skipped') counts.skipped++;
      else if (t.outcome === 'error') counts.error++;
      else counts.other++;
    }

    const insertSummaryTx = database.transaction(() => {
      insertTestRunSummary(
        database,
        data.testRequestRunId,
        data.projectId,
        counts,
        data.tests.length,
        totalDurationMs,
        data.concurrentRunCount,
        data.oomKilled,
        data.incomplete,
      );
    });
    insertSummaryTx();

    const extracted = extractTests(database, data, {
      now: Date.now,
      budgetMs: TX_TIME_BUDGET_MS,
    });
    // 1 for the summary transaction above plus one per extraction transaction.
    const commitCount = 1 + extracted.commitDurationsMs.length;

    return {
      alreadyExtracted: false,
      processed: data.tests.length,
      commitCount,
    };
  } finally {
    database.close();
  }
}

if (parentPort) {
  try {
    parentPort.postMessage({ ok: true, result: run() });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
