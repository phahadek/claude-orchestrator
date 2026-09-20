/**
 * Covers ingestTestRunResultsOffMainThread's dispatch to
 * testRunIngestionWorker.ts — mirrors flakyTestRollupOffMainThread.test.ts's
 * coverage of the identical shared-main-thread-blocks-on-synchronous-I/O
 * problem, for the test.request lane's own extraction + baseline recompute.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';
import {
  ingestTestRunResultsOffMainThread,
  TEST_RUN_INGESTION_WORKER_BATCH_SIZE,
} from '../queries.js';
import type { NewTestRunResultRow } from '../types.js';

describe('ingestTestRunResultsOffMainThread', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function openFileBackedDb(): { db: Database.Database; file: string } {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'test-run-ingestion-off-thread-test-'),
    );
    tmpDirs.push(dir);
    const file = path.join(dir, 'test.db');
    const db = new Database(file);
    // See flakyTestRollupOffMainThread.test.ts's matching comment: without
    // WAL, this connection (left open for the test's lifetime) and the
    // worker's own connection to the same file compete for a single
    // rollback-journal write lock.
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    runMigrations(db);
    return { db, file };
  }

  let seq = 0;
  function insertRun(db: Database.Database, projectId: string): string {
    seq += 1;
    const runId = `run-${seq}`;
    db.prepare(
      `INSERT INTO test_request_runs
         (id, project_id, content_hash, state, output, started_at, finished_at)
       VALUES (@id, @project_id, @content_hash, 'passed', '', 0, 0)`,
    ).run({
      id: runId,
      project_id: projectId,
      content_hash: `hash-${seq}`,
    });
    return runId;
  }

  it('extracts via a worker thread that opens its own connection — rows are visible on the main-thread handle afterward, without the sync fallback ever running', async () => {
    const { db, file } = openFileBackedDb();
    const syncFallback = vi.fn();
    try {
      const runId = insertRun(db, 'proj-1');
      const tests: NewTestRunResultRow[] = [
        { test_id: 't1', name: 'test one', outcome: 'passed', duration_ms: 10 },
        { test_id: 't2', name: 'test two', outcome: 'failed', duration_ms: 20 },
      ];

      const result = await ingestTestRunResultsOffMainThread(
        file,
        {
          testRequestRunId: runId,
          projectId: 'proj-1',
          tests,
          concurrentRunCount: 0,
          oomKilled: false,
          incomplete: false,
          foreignConcurrentRunCount: 0,
          contentHash: 'hash-a',
          flipRateWindowN: 20,
          flipRateThresholdK: 2,
        },
        syncFallback,
      );

      expect(result.alreadyExtracted).toBe(false);
      expect(result.processed).toBe(2);
      expect(syncFallback).not.toHaveBeenCalled();

      const summary = db
        .prepare(
          `SELECT total_count, passed_count, failed_count FROM test_run_summaries WHERE test_request_run_id = ?`,
        )
        .get(runId) as {
        total_count: number;
        passed_count: number;
        failed_count: number;
      };
      expect(summary).toEqual({
        total_count: 2,
        passed_count: 1,
        failed_count: 1,
      });

      const failingRows = db
        .prepare(
          `SELECT test_id FROM test_run_results WHERE test_request_run_id = ?`,
        )
        .all(runId) as { test_id: string }[];
      expect(failingRows.map((r) => r.test_id)).toEqual(['t2']);

      const baselineRows = db
        .prepare(
          `SELECT test_id FROM test_perf_baselines WHERE project_id = ? ORDER BY test_id`,
        )
        .all('proj-1') as { test_id: string }[];
      expect(baselineRows.map((r) => r.test_id)).toEqual(['t1', 't2']);
    } finally {
      db.close();
    }
  }, 60000);

  it('is idempotent — re-dispatching against an already-extracted run is a no-op reporting alreadyExtracted', async () => {
    const { db, file } = openFileBackedDb();
    try {
      const runId = insertRun(db, 'proj-1');
      const tests: NewTestRunResultRow[] = [
        { test_id: 't1', name: 'test one', outcome: 'passed', duration_ms: 10 },
      ];
      const args = {
        testRequestRunId: runId,
        projectId: 'proj-1',
        tests,
        concurrentRunCount: 0,
        oomKilled: false,
        incomplete: false,
        foreignConcurrentRunCount: 0,
        contentHash: 'hash-a',
        flipRateWindowN: 20,
        flipRateThresholdK: 2,
      };

      const first = await ingestTestRunResultsOffMainThread(
        file,
        args,
        vi.fn(),
      );
      expect(first.alreadyExtracted).toBe(false);

      const second = await ingestTestRunResultsOffMainThread(
        file,
        args,
        vi.fn(),
      );
      expect(second.alreadyExtracted).toBe(true);

      const summaryCount = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM test_run_summaries WHERE test_request_run_id = ?`,
          )
          .get(runId) as { c: number }
      ).c;
      expect(summaryCount).toBe(1);
    } finally {
      db.close();
    }
  }, 60000);

  it('commits a large fixture in multiple bounded transactions instead of one — a 5,000-test fixture commits in at least 10 transactions at the 500-row batch bound', async () => {
    const { db, file } = openFileBackedDb();
    try {
      const runId = insertRun(db, 'proj-1');
      const totalTests = 5000;
      expect(TEST_RUN_INGESTION_WORKER_BATCH_SIZE).toBe(500);
      const tests: NewTestRunResultRow[] = Array.from(
        { length: totalTests },
        (_, i) => ({
          test_id: `t${i}`,
          name: `test ${i}`,
          outcome: 'passed',
          duration_ms: 10,
        }),
      );

      const result = await ingestTestRunResultsOffMainThread(
        file,
        {
          testRequestRunId: runId,
          projectId: 'proj-1',
          tests,
          concurrentRunCount: 0,
          oomKilled: false,
          incomplete: false,
          foreignConcurrentRunCount: 0,
          contentHash: 'hash-a',
          flipRateWindowN: 20,
          flipRateThresholdK: 2,
        },
        vi.fn(),
      );

      expect(result.processed).toBe(totalTests);
      // 1 summary-row transaction + 10 extraction batches of 500.
      expect(result.commitCount).toBeGreaterThanOrEqual(10);

      const baselineCount = (
        db
          .prepare(
            `SELECT COUNT(*) as c FROM test_perf_baselines WHERE project_id = ?`,
          )
          .get('proj-1') as { c: number }
      ).c;
      expect(baselineCount).toBe(totalTests);
    } finally {
      db.close();
    }
  }, 60000);

  it('falls back to the caller-supplied sync path for a `:memory:` database, never spawning a worker', async () => {
    const syncFallback = vi.fn();
    const result = await ingestTestRunResultsOffMainThread(
      ':memory:',
      {
        testRequestRunId: 'run-mem',
        projectId: 'proj-1',
        tests: [
          { test_id: 't1', name: 'n', outcome: 'passed', duration_ms: 1 },
        ],
        concurrentRunCount: 0,
        oomKilled: false,
        incomplete: false,
        foreignConcurrentRunCount: 0,
        contentHash: null,
        flipRateWindowN: 20,
        flipRateThresholdK: 2,
      },
      syncFallback,
    );
    expect(syncFallback).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
  });
});
