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
    // Mirrors db.ts's real startup pragmas. Without WAL, this connection
    // (left open for the lifetime of the test) and the worker's own
    // connection to the same file compete for a single rollback-journal
    // write lock, which under host contention throws SQLITE_BUSY
    // intermittently instead of the deterministic result the assertions
    // below expect — see flakyTestRollupWorker.ts's matching comment.
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
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
    // Real worker_thread + ts-node/register/transpile-only startup cost;
    // under full-suite concurrency (many files spawning their own worker
    // threads simultaneously) this has been observed exceeding 30s even
    // though the test does trivial work once the worker is up. See the
    // matching comment on db.performance.test.ts's watermark test.
  }, 60000);

  it('closes the worker thread connection deterministically, independent of elapsed time', async () => {
    const { db, file } = openFileBackedDb();
    try {
      insertTestResult(db, {
        projectId: 'proj-1',
        testId: 'test-flaky',
        name: 'suite > flaky test',
        outcome: 'passed',
        createdAt: 0,
      });

      await replaceFlaggedFlakyTestsRollupOffMainThread(
        file,
        'proj-1',
        20,
        2,
        1000,
      );

      // flakyTestRollupWorker.ts's run() closes its connection in a
      // `finally` before posting its result message, so by the time this
      // promise resolves the worker's write lock is already released — not
      // "eventually", on a timer. busy_timeout = 0 makes this assertion
      // itself timing-independent: BEGIN IMMEDIATE either acquires the
      // write lock right away or throws SQLITE_BUSY immediately, with no
      // window for a slow host to make it flaky either direction.
      const probe = new Database(file);
      try {
        probe.pragma('busy_timeout = 0');
        expect(() => {
          probe.exec('BEGIN IMMEDIATE');
          probe.exec('COMMIT');
        }).not.toThrow();
      } finally {
        probe.close();
      }
    } finally {
      db.close();
    }
  }, 60000);

  it('computes correct, race-free results when several projects are dispatched to worker threads concurrently', async () => {
    const projects = ['proj-a', 'proj-b', 'proj-c', 'proj-d'].map((id) => ({
      projectId: id,
      ...openFileBackedDb(),
    }));
    try {
      for (const project of projects) {
        (['passed', 'failed', 'passed', 'failed'] as const).forEach(
          (outcome, i) =>
            insertTestResult(project.db, {
              projectId: project.projectId,
              testId: 'test-flaky',
              name: 'suite > flaky test',
              outcome,
              createdAt: i,
            }),
        );
      }

      // Simulates the "many test files spawning their own worker threads
      // simultaneously" load this test is documented above to run under —
      // dispatching several worker threads at once, rather than one at a
      // time, is what actually reproduces host contention instead of just
      // asserting a single dispatch works in isolation.
      const results = await Promise.all(
        projects.map((project) =>
          replaceFlaggedFlakyTestsRollupOffMainThread(
            project.file,
            project.projectId,
            20,
            2,
            1000,
          ),
        ),
      );

      results.forEach((result) => expect(result.itemsProcessed).toBe(1));
      for (const project of projects) {
        const rows = project.db
          .prepare(
            'SELECT test_id, sample_count, transition_count FROM flagged_flaky_tests_rollup WHERE project_id = ?',
          )
          .all(project.projectId) as {
          test_id: string;
          sample_count: number;
          transition_count: number;
        }[];
        expect(rows).toEqual([
          { test_id: 'test-flaky', sample_count: 4, transition_count: 3 },
        ]);
      }
    } finally {
      for (const project of projects) project.db.close();
    }
  }, 60000);

  it('prunes a flagged rollup row via the worker path once its test_perf_baselines row goes stale, without crossing the watermark again', async () => {
    const { db, file } = openFileBackedDb();
    try {
      ['passed', 'failed', 'passed', 'failed'].forEach((outcome, i) =>
        insertTestResult(db, {
          projectId: 'proj-1',
          testId: 'test-renamed-old',
          name: 'suite > old name (before rename)',
          outcome: outcome as 'passed' | 'failed',
          createdAt: i,
        }),
      );

      await replaceFlaggedFlakyTestsRollupOffMainThread(
        file,
        'proj-1',
        20,
        2,
        1000,
      );
      expect(
        (
          db
            .prepare(
              'SELECT test_id FROM flagged_flaky_tests_rollup WHERE project_id = ?',
            )
            .all('proj-1') as { test_id: string }[]
        ).map((r) => r.test_id),
      ).toEqual(['test-renamed-old']);

      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      await replaceFlaggedFlakyTestsRollupOffMainThread(
        file,
        'proj-1',
        20,
        2,
        1000 + SEVEN_DAYS_MS + 1,
      );

      expect(
        db
          .prepare(
            'SELECT test_id FROM flagged_flaky_tests_rollup WHERE project_id = ?',
          )
          .all('proj-1'),
      ).toEqual([]);
    } finally {
      db.close();
    }
  }, 60000);

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
    let workerElapsedMs: number | null = null;
    const rollupDone = new Promise<void>((resolve) => {
      worker.once('message', () => {
        workerElapsedMs = Date.now() - start;
        resolve();
      });
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

    await rollupDone;
    // If the "rollup recompute" ran inline on the main thread, this timer
    // would have queued behind its 300ms of blocking work and fired no
    // earlier than the worker's own message. Running it on a worker thread
    // instead means the timer fires strictly before the worker's blocking
    // delay is up. This is a pure ordering check — immune to absolute
    // timing jitter, unlike a fixed millisecond bound on timerElapsedMs.
    expect(workerElapsedMs).not.toBeNull();
    expect(timerElapsedMs as number).toBeLessThan(workerElapsedMs as number);

    await worker.terminate();
  }, 15000);
});
