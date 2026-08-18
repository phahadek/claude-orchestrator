// Worker-thread entry point for FlakyTestRollupJob's per-project
// flagged_flaky_tests_rollup recompute.
//
// The recompute is incremental: only test ids with a test_run_results row
// past flagged_flaky_tests_rollup_watermark are re-run through
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

function computeTestFlipRateFlag(
  database: Database.Database,
  testId: string,
  windowN: number,
  thresholdK: number,
): TestFlipRateFlag {
  const rows = database
    .prepare(
      `
      SELECT outcome FROM (
        SELECT outcome, created_at, id
        FROM test_run_results
        WHERE test_id = @test_id
          AND concurrent_run_count = 0
          AND oom_killed = 0
          AND outcome IN ('passed', 'failed')
        ORDER BY created_at DESC, id DESC
        LIMIT @limit
      )
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all({ test_id: testId, limit: windowN }) as { outcome: string }[];

  let transitionCount = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].outcome !== rows[i - 1].outcome) transitionCount++;
  }

  return {
    testId,
    sampleCount: rows.length,
    transitionCount,
    flagged: transitionCount >= thresholdK,
  };
}

function getWatermark(database: Database.Database, projectId: string): number {
  const row = database
    .prepare(
      `SELECT last_test_run_result_id FROM flagged_flaky_tests_rollup_watermark WHERE project_id = ?`,
    )
    .get(projectId) as { last_test_run_result_id: number } | undefined;
  return row?.last_test_run_result_id ?? 0;
}

function setWatermark(
  database: Database.Database,
  projectId: string,
  lastTestRunResultId: number,
  updatedAt: number,
): void {
  database
    .prepare(
      `INSERT INTO flagged_flaky_tests_rollup_watermark
         (project_id, last_test_run_result_id, updated_at)
       VALUES (@project_id, @last_test_run_result_id, @updated_at)
       ON CONFLICT(project_id) DO UPDATE SET
         last_test_run_result_id = excluded.last_test_run_result_id,
         updated_at = excluded.updated_at`,
    )
    .run({
      project_id: projectId,
      last_test_run_result_id: lastTestRunResultId,
      updated_at: updatedAt,
    });
}

interface Candidates {
  testIds: string[];
  names: Map<string, string>;
  maxId: number;
}

function getCandidates(
  database: Database.Database,
  projectId: string,
  sinceId: number,
): Candidates {
  const stats = database
    .prepare(
      `SELECT COUNT(*) AS row_count, MAX(trr.id) AS max_id
       FROM test_run_results trr
       JOIN test_request_runs r ON r.id = trr.test_request_run_id
       WHERE r.project_id = @project_id AND trr.id > @since_id`,
    )
    .get({ project_id: projectId, since_id: sinceId }) as {
    row_count: number;
    max_id: number | null;
  };

  if (stats.row_count === 0) {
    return { testIds: [], names: new Map(), maxId: sinceId };
  }

  const rows = database
    .prepare(
      `SELECT trr.test_id AS test_id, trr.name AS name, MAX(trr.created_at) AS created_at
       FROM test_run_results trr
       JOIN test_request_runs r ON r.id = trr.test_request_run_id
       WHERE r.project_id = @project_id AND trr.id > @since_id
       GROUP BY trr.test_id`,
    )
    .all({ project_id: projectId, since_id: sinceId }) as {
    test_id: string;
    name: string;
  }[];

  const names = new Map<string, string>();
  for (const row of rows) names.set(row.test_id, row.name);

  return {
    testIds: rows.map((r) => r.test_id),
    names,
    maxId: stats.max_id ?? sinceId,
  };
}

function run(): FlakyTestRollupWorkerResult {
  const { dbPath, projectId, windowN, thresholdK, computedAt } =
    workerData as FlakyTestRollupWorkerData;
  const database = new Database(dbPath);
  try {
    const sinceId = getWatermark(database, projectId);
    const candidates = getCandidates(database, projectId, sinceId);

    if (candidates.testIds.length === 0) {
      return { itemsProcessed: 0 };
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
      setWatermark(database, projectId, candidates.maxId, computedAt);
    });
    replace();

    return { itemsProcessed: candidates.testIds.length };
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
