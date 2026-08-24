// Worker-thread entry point for FlakyTestRollupJob's per-project
// flagged_flaky_tests_rollup recompute.
//
// The recompute is incremental: only test ids touched (any outcome) past
// flagged_flaky_tests_rollup_watermark are re-run through
// computeTestFlipRateFlag, so a typical tick touches a small fraction of the
// project's tests rather than walking the full table (previously documented
// at 7.6s+ at 1.5M rows, growing daily — see the schema.ts comment on
// flagged_flaky_tests_rollup). The first-ever tick for a project (watermark
// 0) still walks its full history, and better-sqlite3 is fully synchronous
// with no worker-thread or libuv-pool offload of its own, so issuing that
// scan on the shared main-thread `db` connection would block every Express
// route, WebSocket handler, and other scheduled job on the process for the
// scan's full duration. This file runs on a separate worker thread and
// opens its OWN connection against the same on-disk database file, so the
// scan's CPU/I/O never occupies the main thread's event loop. It
// deliberately does not import db.ts or queries.ts: doing so would re-run
// db.ts's module side effects (opening the shared `db` singleton, schema
// assertions, migrations) on the worker thread, and queries.ts's prepared
// statements are bound to that singleton connection rather than this one.
// See walTruncateCheckpointWorker.ts for the identical pattern applied to
// the hourly WAL TRUNCATE checkpoint.
//
// computeTestFlipRateFlag/getCandidates below are intentionally duplicated
// from db/queries.ts's digest-backed versions (same reason: this file can't
// import queries.ts) — both now read the fixed-width outcome-sequence digest
// on test_perf_baselines (recordTestPerfDigestSample) rather than raw
// test_run_results rows, since a passing test no longer gets a row there.
import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';

interface FlakyTestRollupWorkerData {
  dbPath: string;
  projectId: string;
  windowN: number;
  thresholdK: number;
  computedAt: number;
}

interface TestFlipRateFlag {
  testId: string;
  sampleCount: number;
  transitionCount: number;
  flagged: boolean;
}

interface FlakyTestRollupWorkerResult {
  itemsProcessed: number;
}

// Mirrors FLAGGED_FLAKY_ROLLUP_GHOST_STALE_MS in db/queries.ts — see that
// constant's doc comment for why a renamed/deleted test's old test_id can
// never cross the watermark again on its own, and why elapsed time since the
// last real digest update is the only available signal to prune it.
const GHOST_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function pruneGhostFlaggedFlakyTests(
  database: Database.Database,
  projectId: string,
  computedAt: number,
): number {
  const result = database
    .prepare(
      `DELETE FROM flagged_flaky_tests_rollup
       WHERE project_id = @project_id
         AND test_id NOT IN (
           SELECT test_id FROM test_perf_baselines
           WHERE project_id = @project_id AND updated_at > @stale_before
         )`,
    )
    .run({
      project_id: projectId,
      stale_before: computedAt - GHOST_STALE_MS,
    });
  return result.changes as number;
}

interface DigestOutcomeSample {
  o: 'P' | 'F';
  t: number;
}

function parseDigestOutcomes(json: string): DigestOutcomeSample[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as DigestOutcomeSample[]) : [];
  } catch {
    return [];
  }
}

function computeTestFlipRateFlag(
  database: Database.Database,
  testId: string,
  windowN: number,
  thresholdK: number,
): TestFlipRateFlag {
  const row = database
    .prepare(
      `SELECT recent_outcomes FROM test_perf_baselines WHERE test_id = ?`,
    )
    .get(testId) as { recent_outcomes: string } | undefined;
  const all = row ? parseDigestOutcomes(row.recent_outcomes) : [];
  const windowed = all.slice(-windowN);

  let transitionCount = 0;
  for (let i = 1; i < windowed.length; i++) {
    if (windowed[i].o !== windowed[i - 1].o) transitionCount++;
  }

  return {
    testId,
    sampleCount: windowed.length,
    transitionCount,
    flagged: transitionCount >= thresholdK,
  };
}

interface Watermark {
  updatedAt: number;
  testId: string;
}

function getWatermark(
  database: Database.Database,
  projectId: string,
): Watermark {
  const row = database
    .prepare(
      `SELECT last_digest_updated_at, last_digest_test_id FROM flagged_flaky_tests_rollup_watermark WHERE project_id = ?`,
    )
    .get(projectId) as
    | { last_digest_updated_at: number; last_digest_test_id: string }
    | undefined;
  return {
    updatedAt: row?.last_digest_updated_at ?? 0,
    testId: row?.last_digest_test_id ?? '',
  };
}

function setWatermark(
  database: Database.Database,
  projectId: string,
  watermark: Watermark,
  updatedAt: number,
): void {
  database
    .prepare(
      `INSERT INTO flagged_flaky_tests_rollup_watermark
         (project_id, last_digest_updated_at, last_digest_test_id, updated_at)
       VALUES (@project_id, @last_digest_updated_at, @last_digest_test_id, @updated_at)
       ON CONFLICT(project_id) DO UPDATE SET
         last_digest_updated_at = excluded.last_digest_updated_at,
         last_digest_test_id = excluded.last_digest_test_id,
         updated_at = excluded.updated_at`,
    )
    .run({
      project_id: projectId,
      last_digest_updated_at: watermark.updatedAt,
      last_digest_test_id: watermark.testId,
      updated_at: updatedAt,
    });
}

interface Candidates {
  testIds: string[];
  names: Map<string, string>;
  watermark: Watermark;
}

function getCandidates(
  database: Database.Database,
  projectId: string,
  since: Watermark,
): Candidates {
  const rows = database
    .prepare(
      `SELECT test_id AS test_id, name AS name, updated_at AS updated_at
       FROM test_perf_baselines
       WHERE project_id = @project_id
         AND (updated_at > @since_updated_at
              OR (updated_at = @since_updated_at AND test_id > @since_test_id))
       ORDER BY updated_at ASC, test_id ASC`,
    )
    .all({
      project_id: projectId,
      since_updated_at: since.updatedAt,
      since_test_id: since.testId,
    }) as { test_id: string; name: string; updated_at: number }[];

  if (rows.length === 0) {
    return { testIds: [], names: new Map(), watermark: since };
  }

  const names = new Map<string, string>();
  for (const row of rows) names.set(row.test_id, row.name);
  const last = rows[rows.length - 1];

  return {
    testIds: rows.map((r) => r.test_id),
    names,
    watermark: { updatedAt: last.updated_at, testId: last.test_id },
  };
}

function run(): FlakyTestRollupWorkerResult {
  const { dbPath, projectId, windowN, thresholdK, computedAt } =
    workerData as FlakyTestRollupWorkerData;
  const database = new Database(dbPath);
  // The main-thread `db` singleton (db.ts) always sets journal_mode = WAL
  // before any worker can be dispatched against the same file, so this is a
  // no-op against the real app database — WAL is a persistent, file-level
  // setting, not a per-connection one. It matters for tests that open their
  // own short-lived file-backed database without setting it: without WAL, a
  // second connection to the same file competes for the single rollback-
  // journal write lock the first (still-open) connection may be holding,
  // which under host contention surfaces as an intermittent SQLITE_BUSY
  // failure rather than a deterministic result — this was the actual source
  // of flakyTestRollupOffMainThread.test.ts's flip/flop, not an undersized
  // timeout. busy_timeout makes better-sqlite3 retry for up to 5s instead of
  // throwing immediately on a transient lock, covering the remaining
  // WAL-mode writer-vs-writer case.
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  try {
    const since = getWatermark(database, projectId);
    const candidates = getCandidates(database, projectId, since);
    const ghostsPruned = pruneGhostFlaggedFlakyTests(
      database,
      projectId,
      computedAt,
    );

    if (candidates.testIds.length === 0) {
      return { itemsProcessed: ghostsPruned };
    }

    const flags = candidates.testIds.map((testId) =>
      computeTestFlipRateFlag(database, testId, windowN, thresholdK),
    );

    const replace = database.transaction(() => {
      const deleteStmt = database.prepare(
        `DELETE FROM flagged_flaky_tests_rollup WHERE project_id = ? AND test_id = ?`,
      );
      const insert = database.prepare(`
        INSERT INTO flagged_flaky_tests_rollup
          (project_id, test_id, name, sample_count, transition_count, computed_at)
        VALUES
          (@project_id, @test_id, @name, @sample_count, @transition_count, @computed_at)
      `);
      for (const flag of flags) {
        deleteStmt.run(projectId, flag.testId);
        if (flag.flagged) {
          insert.run({
            project_id: projectId,
            test_id: flag.testId,
            name: candidates.names.get(flag.testId) ?? flag.testId,
            sample_count: flag.sampleCount,
            transition_count: flag.transitionCount,
            computed_at: computedAt,
          });
        }
      }
      setWatermark(database, projectId, candidates.watermark, computedAt);
    });
    replace();

    return { itemsProcessed: candidates.testIds.length + ghostsPruned };
  } finally {
    database.close();
  }
}

if (!parentPort) {
  throw new Error(
    '[flakyTestRollupWorker] must be run as a worker_threads Worker',
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
