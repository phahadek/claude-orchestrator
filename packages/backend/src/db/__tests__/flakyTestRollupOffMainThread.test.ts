/**
 * Covers FlakyTestRollupJob's per-project rollup recompute running off the
 * shared main-thread `db` connection — mirrors
 * walTruncateCheckpointOffMainThread.test.ts's coverage of the identical
 * shared-main-thread-blocks-on-synchronous-I/O problem for the hourly WAL
 * TRUNCATE checkpoint.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { Worker } from 'worker_threads';
import { runMigrations } from '../schema.js';
import { replaceFlaggedFlakyTestsRollupOffMainThread } from '../queries.js';

describe('replaceFlaggedFlakyTestsRollupOffMainThread', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function openFileBackedDb(): { db: Database.Database; file: string } {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'flaky-rollup-off-thread-test-'),
    );
    tmpDirs.push(dir);
    const file = path.join(dir, 'test.db');
    const db = new Database(file);
    runMigrations(db);
    return { db, file };
  }

  let seq = 0;
  function insertTestResult(
    db: Database.Database,
    opts: {
      projectId: string;
      testId: string;
      name: string;
      outcome: 'passed' | 'failed';
      createdAt: number;
    },
  ): void {
    seq += 1;
    const runId = `run-${seq}`;
    db.prepare(
      `INSERT INTO test_request_runs
         (id, project_id, content_hash, state, output, started_at, finished_at)
       VALUES (@id, @project_id, @content_hash, 'passed', '', 0, 0)`,
    ).run({
      id: runId,
      project_id: opts.projectId,
      content_hash: `hash-${seq}`,
    });
    db.prepare(
      `INSERT INTO test_run_results
         (test_request_run_id, project_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
       VALUES (@run_id, @project_id, @test_id, @name, @outcome, 100, 0, 0, @created_at)`,
    ).run({
      run_id: runId,
      project_id: opts.projectId,
      test_id: opts.testId,
      name: opts.name,
      outcome: opts.outcome,
      created_at: opts.createdAt,
    });

    // The worker's computeTestFlipRateFlag reads the test_perf_baselines
    // digest, not raw test_run_results rows — this test opens its own file-
    // backed connection (not the app's shared `db` singleton), so it can't
    // call queries.ts's recordTestPerfDigestSample; replicate its upsert
    // directly against this test's own connection instead.
    const existing = db
      .prepare(
        `SELECT recent_outcomes FROM test_perf_baselines WHERE test_id = ?`,
      )
      .get(opts.testId) as { recent_outcomes: string } | undefined;
    const outcomes = existing ? JSON.parse(existing.recent_outcomes) : [];
    outcomes.push({
      o: opts.outcome === 'passed' ? 'P' : 'F',
      t: opts.createdAt,
    });
    db.prepare(
      `INSERT INTO test_perf_baselines
         (test_id, project_id, name, median_duration_ms, mad_duration_ms, sample_count, last_duration_ms, is_regressed, recent_outcomes, recent_durations, updated_at)
       VALUES (@test_id, @project_id, @name, 0, 0, 0, 100, 0, @recent_outcomes, '[]', @updated_at)
       ON CONFLICT(test_id) DO UPDATE SET
         project_id = excluded.project_id,
         name = excluded.name,
         recent_outcomes = excluded.recent_outcomes,
         updated_at = excluded.updated_at`,
    ).run({
      test_id: opts.testId,
      project_id: opts.projectId,
      name: opts.name,
      recent_outcomes: JSON.stringify(outcomes),
      updated_at: opts.createdAt,
    });
  }

  it('recomputes the rollup via a worker thread that opens its own connection', async () => {
    const { db, file } = openFileBackedDb();
    try {
      const outcomes: Array<'passed' | 'failed'> = [
        'passed',
        'failed',
        'passed',
        'failed',
      ];
      outcomes.forEach((outcome, i) =>
        insertTestResult(db, {
          projectId: 'proj-1',
          testId: 'test-flaky',
          name: 'suite > flaky test',
          outcome,
          createdAt: i,
        }),
      );

      const result = await replaceFlaggedFlakyTestsRollupOffMainThread(
        file,
        'proj-1',
        20,
        2,
        1000,
      );

      expect(result.itemsProcessed).toBe(1);

      // The worker's connection is separate from `db` — the main-thread
      // handle must still see the rows it wrote afterward.
      const rows = db
        .prepare(
          'SELECT test_id, sample_count, transition_count FROM flagged_flaky_tests_rollup WHERE project_id = ?',
        )
        .all('proj-1') as {
        test_id: string;
        sample_count: number;
        transition_count: number;
      }[];
      expect(rows).toEqual([
        { test_id: 'test-flaky', sample_count: 4, transition_count: 3 },
      ]);
    } finally {
      db.close();
    }
  }, 30000);

  it('runs in-process for an in-memory database, since no second connection can open against it', async () => {
    const result = await replaceFlaggedFlakyTestsRollupOffMainThread(
      ':memory:',
      'proj-1',
      20,
      2,
      1000,
    );
    expect(result.itemsProcessed).toBe(0);
  });
});

describe('worker-thread rollup dispatch does not block the main event loop', () => {
  it('lets a concurrent timer resolve on schedule while a simulated slow rollup runs on a worker thread', async () => {
    // Mirrors the shape of replaceFlaggedFlakyTestsRollupOffMainThread's
    // dispatch (a Worker that does blocking synchronous work and posts a
    // result back) without depending on a real, timing-flaky multi-second
    // test_run_results scan to simulate slowness.
    const slowWorkerScript = `
      const { parentPort, workerData } = require('worker_threads');
      const sab = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sab, 0, 0, workerData.delayMs);
      parentPort.postMessage('done');
    `;
    const delayMs = 300;
    const start = Date.now();
    const worker = new Worker(slowWorkerScript, {
      eval: true,
      workerData: { delayMs },
    });
    const rollupDone = new Promise<void>((resolve) => {
      worker.once('message', () => resolve());
    });

    let timerElapsedMs: number | null = null;
    const timerDelayMs = 20;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        timerElapsedMs = Date.now() - start;
        resolve();
      }, timerDelayMs);
    });

    expect(timerElapsedMs).not.toBeNull();
    // If the "rollup recompute" ran inline on the main thread, this timer
    // would have queued behind its 300ms of blocking work. Running it on a
    // worker thread instead means the timer fires close to its own delay.
    expect(timerElapsedMs as number).toBeLessThan(delayMs / 2);

    await rollupDone;
    await worker.terminate();
  }, 15000);
});
