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
// Extraction commits in batches of at most `batchSize` tests per
// transaction (default 500) rather than one single-shot transaction for the
// whole run — a multi-second single write transaction would hold the WAL
// write lock and block every main-thread write in its busy-timeout retry
// loop, re-creating the freeze this worker exists to remove.
//
// Callers MUST single-flight dispatch of this worker per project — see
// testRequestLane.ts's per-project ingestion queue. Two connections against
// the same file racing recordTestPerfDigestSample's read-modify-write of a
// test's digest would last-writer-wins and silently drop samples.
import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';

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

// Mirrors TEST_DURATION_DIGEST_CAPACITY/TEST_OUTCOME_DIGEST_CAPACITY in
// db/queries.ts.
const TEST_DURATION_DIGEST_CAPACITY = 32;
const TEST_OUTCOME_DIGEST_CAPACITY = 200;

interface DigestOutcomeSample {
  o: 'P' | 'F';
  t: number;
  h?: string;
}

function parseDigestOutcomes(json: string): DigestOutcomeSample[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as DigestOutcomeSample[]) : [];
  } catch {
    return [];
  }
}

function parseDigestDurations(json: string): number[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as number[]) : [];
  } catch {
    return [];
  }
}

interface TestOutcomeCounts {
  passed: number;
  failed: number;
  skipped: number;
  error: number;
  other: number;
}

let stmtInsertTestRunResult: Database.Statement | null = null;
let stmtGetTestPerfDigest: Database.Statement | null = null;
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

interface DigestSampleResult {
  durations: number[];
  outcomes: DigestOutcomeSample[];
}

/** Mirrors recordTestPerfDigestSample in db/queries.ts. */
function recordTestPerfDigestSample(
  database: Database.Database,
  testId: string,
  projectId: string,
  name: string,
  outcome: string,
  durationMs: number,
  concurrentRunCount: number | null,
  oomKilled: boolean,
  sequencedAt: number,
  markers: string[] | undefined,
  foreignConcurrentRunCount: number | null,
  contentHash: string | null,
): DigestSampleResult | null {
  if (
    concurrentRunCount !== 0 ||
    oomKilled ||
    (foreignConcurrentRunCount ?? 0) !== 0
  )
    return null;

  stmtGetTestPerfDigest ??= database.prepare(
    `SELECT recent_outcomes, recent_durations FROM test_perf_baselines WHERE test_id = @test_id`,
  );
  const existing = stmtGetTestPerfDigest.get({ test_id: testId }) as
    | { recent_outcomes: string; recent_durations: string }
    | undefined;

  const outcomes = existing
    ? parseDigestOutcomes(existing.recent_outcomes)
    : [];
  if (outcome === 'passed' || outcome === 'failed') {
    const sample: DigestOutcomeSample = {
      o: outcome === 'passed' ? 'P' : 'F',
      t: sequencedAt,
    };
    if (contentHash) sample.h = contentHash;
    outcomes.push(sample);
    if (outcomes.length > TEST_OUTCOME_DIGEST_CAPACITY) {
      outcomes.splice(0, outcomes.length - TEST_OUTCOME_DIGEST_CAPACITY);
    }
  }

  const durations = existing
    ? parseDigestDurations(existing.recent_durations)
    : [];
  durations.push(durationMs);
  if (durations.length > TEST_DURATION_DIGEST_CAPACITY) {
    durations.splice(0, durations.length - TEST_DURATION_DIGEST_CAPACITY);
  }

  stmtUpsertTestPerfDigest ??= database.prepare(`
    INSERT INTO test_perf_baselines
      (test_id, project_id, name, median_duration_ms, mad_duration_ms, sample_count, last_duration_ms, is_regressed, recent_outcomes, recent_durations, markers, updated_at)
    VALUES
      (@test_id, @project_id, @name, 0, 0, 0, @last_duration_ms, 0, @recent_outcomes, @recent_durations, @markers, @updated_at)
    ON CONFLICT(test_id) DO UPDATE SET
      project_id = excluded.project_id,
      name = excluded.name,
      recent_outcomes = excluded.recent_outcomes,
      recent_durations = excluded.recent_durations,
      markers = COALESCE(excluded.markers, test_perf_baselines.markers),
      updated_at = excluded.updated_at
  `);
  stmtUpsertTestPerfDigest.run({
    test_id: testId,
    project_id: projectId,
    name,
    last_duration_ms: durationMs,
    recent_outcomes: JSON.stringify(outcomes),
    recent_durations: JSON.stringify(durations),
    markers: markers && markers.length > 0 ? JSON.stringify(markers) : null,
    updated_at: sequencedAt,
  });

  return { durations, outcomes };
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

/** Mirrors computeTestPerfBaseline in orchestration/testRequestLane.ts. */
function computeTestPerfBaseline(
  database: Database.Database,
  testId: string,
  durations: number[],
): void {
  const samples = durations.slice(
    0,
    BASELINE_WINDOW_SAMPLES + MIN_CONSECUTIVE_REGRESSED_SAMPLES,
  );
  if (samples.length === 0) return;

  const lastDuration = samples[0];

  if (samples.length <= MIN_CONSECUTIVE_REGRESSED_SAMPLES) {
    const sorted = [...samples].sort((a, b) => a - b);
    const med = median(sorted);
    upsertTestPerfBaseline(database, {
      test_id: testId,
      median_duration_ms: med,
      mad_duration_ms: medianAbsoluteDeviation(samples, med),
      sample_count: samples.length,
      last_duration_ms: lastDuration,
      is_regressed: false,
    });
    return;
  }

  const recent = samples.slice(0, MIN_CONSECUTIVE_REGRESSED_SAMPLES);
  const baselineSamples = samples.slice(MIN_CONSECUTIVE_REGRESSED_SAMPLES);
  const sortedBaseline = [...baselineSamples].sort((a, b) => a - b);
  const baselineMedian = median(sortedBaseline);
  const baselineMad = medianAbsoluteDeviation(baselineSamples, baselineMedian);
  const threshold = baselineMedian + REGRESSION_K * baselineMad;
  const isRegressed = recent.every((d) => d > threshold);

  upsertTestPerfBaseline(database, {
    test_id: testId,
    median_duration_ms: baselineMedian,
    mad_duration_ms: baselineMad,
    sample_count: baselineSamples.length,
    last_duration_ms: lastDuration,
    is_regressed: isRegressed,
  });
}

/** Mirrors computeTestFlipRateFlagFromOutcomes in db/queries.ts — log-only here, nothing persisted. */
function logFlipRateFlagIfFlagged(
  testId: string,
  outcomes: DigestOutcomeSample[],
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

function run(): TestRunIngestionWorkerResult {
  const data = workerData as TestRunIngestionWorkerData;
  const database = new Database(data.dbPath);
  // See flakyTestRollupWorker.ts's identical pragma comment for why these
  // matter for short-lived file-backed test databases specifically.
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  try {
    const alreadyExtracted = database
      .prepare(
        `SELECT 1 FROM test_run_summaries WHERE test_request_run_id = ?`,
      )
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

    const batchSize = data.batchSize > 0 ? data.batchSize : 500;
    const baseSequence = Date.now() * 1000;
    let globalIndex = 0;
    // Reported back in the result as commitCount (1 for the summary
    // transaction above, plus one per extraction batch below) — the batch
    // bound this counts against is what keeps any single transaction's WAL
    // write-lock hold short enough to not starve the main thread's own
    // writes under its busy-timeout retry loop.
    let commitCount = 1;
    for (let start = 0; start < data.tests.length; start += batchSize) {
      const chunk = data.tests.slice(start, start + batchSize);
      const runBatchTx = database.transaction(() => {
        for (const item of chunk) {
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
          const sequencedAt = baseSequence + globalIndex;
          globalIndex++;
          const sample = recordTestPerfDigestSample(
            database,
            item.test_id,
            data.projectId,
            item.name,
            item.outcome,
            item.duration_ms,
            data.concurrentRunCount,
            data.oomKilled,
            sequencedAt,
            item.markers,
            data.foreignConcurrentRunCount,
            data.contentHash,
          );
          if (sample) {
            computeTestPerfBaseline(
              database,
              item.test_id,
              [...sample.durations].reverse(),
            );
            logFlipRateFlagIfFlagged(
              item.test_id,
              sample.outcomes,
              data.flipRateWindowN,
              data.flipRateThresholdK,
            );
          }
        }
      });
      runBatchTx();
      commitCount++;
    }

    return {
      alreadyExtracted: false,
      processed: data.tests.length,
      commitCount,
    };
  } finally {
    database.close();
  }
}

if (!parentPort) {
  throw new Error(
    '[testRunIngestionWorker] must be run as a worker_threads Worker',
  );
}

try {
  parentPort.postMessage({ ok: true, result: run() });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
}
