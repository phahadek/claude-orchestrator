// Worker-thread entry point for FlakyTestRollupJob's per-project
// flagged_flaky_tests_rollup recompute.
//
// listFlaggedFlakyTests walks the full test_run_results table per test
// (documented at 7.6s+ at 1.5M rows, growing daily — see the schema.ts
// comment on flagged_flaky_tests_rollup) and better-sqlite3 is fully
// synchronous with no worker-thread or libuv-pool offload of its own, so
// issuing that scan on the shared main-thread `db` connection — once per
// registered project, back to back, in one unyielding loop — blocks every
// Express route, WebSocket handler, and other scheduled job on the process
// for the scan's full duration, every 15 minutes and on every boot. This
// file runs on a separate worker thread and opens its OWN connection
// against the same on-disk database file, so the scan's CPU/I/O never
// occupies the main thread's event loop. It deliberately does not import
// db.ts or queries.ts: doing so would re-run db.ts's module side effects
// (opening the shared `db` singleton, schema assertions, migrations) on
// the worker thread, and queries.ts's prepared statements are bound to
// that singleton connection rather than this one. See
// walTruncateCheckpointWorker.ts for the identical pattern applied to the
// hourly WAL TRUNCATE checkpoint.
import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';

interface FlakyTestRollupWorkerData {
  dbPath: string;
  projectId: string;
  windowN: number;
  thresholdK: number;
  computedAt: number;
}

interface FlaggedFlakyTest {
  testId: string;
  name: string;
  sampleCount: number;
  transitionCount: number;
}

interface FlakyTestRollupWorkerResult {
  itemsProcessed: number;
}

function computeTestFlipRateFlag(
  database: Database.Database,
  testId: string,
  windowN: number,
  thresholdK: number,
): { sampleCount: number; transitionCount: number; flagged: boolean } {
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
    sampleCount: rows.length,
    transitionCount,
    flagged: transitionCount >= thresholdK,
  };
}

function listFlaggedFlakyTests(
  database: Database.Database,
  projectId: string,
  windowN: number,
  thresholdK: number,
): FlaggedFlakyTest[] {
  const rows = database
    .prepare(
      `
      SELECT trr.test_id AS test_id, trr.name AS name, MAX(trr.created_at) AS created_at
      FROM test_run_results trr
      JOIN test_request_runs r ON r.id = trr.test_request_run_id
      WHERE r.project_id = @project_id
      GROUP BY trr.test_id
    `,
    )
    .all({ project_id: projectId }) as { test_id: string; name: string }[];

  const flagged: FlaggedFlakyTest[] = [];
  for (const row of rows) {
    const flag = computeTestFlipRateFlag(database, row.test_id, windowN, thresholdK);
    if (flag.flagged) {
      flagged.push({
        testId: row.test_id,
        name: row.name,
        sampleCount: flag.sampleCount,
        transitionCount: flag.transitionCount,
      });
    }
  }
  return flagged;
}

function run(): FlakyTestRollupWorkerResult {
  const { dbPath, projectId, windowN, thresholdK, computedAt } =
    workerData as FlakyTestRollupWorkerData;
  const database = new Database(dbPath);
  try {
    const flagged = listFlaggedFlakyTests(database, projectId, windowN, thresholdK);

    const replace = database.transaction(() => {
      database
        .prepare(`DELETE FROM flagged_flaky_tests_rollup WHERE project_id = ?`)
        .run(projectId);
      const insert = database.prepare(`
        INSERT INTO flagged_flaky_tests_rollup
          (project_id, test_id, name, sample_count, transition_count, computed_at)
        VALUES
          (@project_id, @test_id, @name, @sample_count, @transition_count, @computed_at)
      `);
      for (const t of flagged) {
        insert.run({
          project_id: projectId,
          test_id: t.testId,
          name: t.name,
          sample_count: t.sampleCount,
          transition_count: t.transitionCount,
          computed_at: computedAt,
        });
      }
    });
    replace();

    return { itemsProcessed: flagged.length };
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
