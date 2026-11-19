import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';
import { extractTests } from '../testRunIngestionWorker.js';

describe('extractTests time-bounded transactions', () => {
  it('commits a large synthetic run in many transactions, none exceeding the time budget', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO test_request_runs
         (id, project_id, content_hash, state, started_at, finished_at)
       VALUES ('run-1', 'p1', 'h1', 'passed', 0, 0)`,
    ).run();

    const tests = Array.from({ length: 2000 }, (_, i) => ({
      test_id: `t${i}`,
      name: `test ${i}`,
      outcome: i % 10 === 0 ? 'failed' : 'passed',
      duration_ms: 5 + (i % 7),
    }));

    // Every clock read advances 1 ms, so a transaction's measured span is the
    // number of clock reads it made — deterministic regardless of machine speed.
    let clock = 0;
    const budgetMs = 50;
    const { commitDurationsMs } = extractTests(
      db,
      {
        testRequestRunId: 'run-1',
        projectId: 'p1',
        tests,
        concurrentRunCount: 0,
        oomKilled: false,
        foreignConcurrentRunCount: 0,
        contentHash: 'h1',
        timedOut: false,
        batchSize: 100_000,
        flipRateWindowN: 20,
        flipRateThresholdK: 3,
      },
      { now: () => ++clock, budgetMs },
    );

    expect(commitDurationsMs.length).toBeGreaterThan(1);
    for (const d of commitDurationsMs) {
      expect(d).toBeLessThanOrEqual(budgetMs);
    }

    const samples = db
      .prepare(`SELECT COUNT(*) AS n FROM test_sample WHERE run_id = 'run-1'`)
      .get() as { n: number };
    expect(samples.n).toBe(2000);
    const failed = db
      .prepare(
        `SELECT COUNT(*) AS n FROM test_run_results WHERE test_request_run_id = 'run-1'`,
      )
      .get() as { n: number };
    expect(failed.n).toBe(200);
    db.close();
  });
});
