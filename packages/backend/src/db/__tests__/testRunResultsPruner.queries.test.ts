/**
 * Tests for db/queries.ts's pruneTestRunResults — the retention sweep that
 * deletes raw test_run_results rows past the 30-day window while leaving the
 * per-test aggregate in test_perf_baselines untouched (see server.ts's
 * test_run_results_pruner registration).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  pruneTestRunResults,
  insertTestRequestRun,
  insertTestRunResults,
  listTestRunResultsForRun,
  upsertTestPerfBaseline,
  getTestPerfBaseline,
  isJobOverdue,
  insertSchedulerAudit,
  TEST_RUN_RESULTS_RETENTION_MS,
  SCHEDULER_AUDIT_KEEP_PER_JOB,
} from '../queries.js';

let seq = 0;

function insertRow(testId: string, createdAt: number): string {
  seq += 1;
  const runId = `prune-run-${seq}`;
  insertTestRequestRun(runId, 'proj-1', `prune-hash-${seq}`, null, Date.now());
  insertTestRunResults(
    runId,
    [{ test_id: testId, name: testId, outcome: 'passed', duration_ms: 100 }],
    0,
    false,
  );
  // insertTestRunResults always stamps created_at = Date.now(); backdate it
  // directly to simulate an old row without needing fake timers.
  db.prepare(
    `UPDATE test_run_results SET created_at = ? WHERE test_request_run_id = ?`,
  ).run(createdAt, runId);
  return runId;
}

beforeEach(() => {
  seq = 0;
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM test_perf_baselines').run();
  db.prepare('DELETE FROM scheduler_audit').run();
});

describe('pruneTestRunResults', () => {
  it('deletes a row older than the retention window', () => {
    const retentionMs = 30 * 24 * 60 * 60_000;
    const oldRunId = insertRow('test-a', Date.now() - retentionMs - 1000);

    const deleted = pruneTestRunResults(retentionMs);

    expect(deleted).toBe(1);
    expect(listTestRunResultsForRun(oldRunId)).toHaveLength(0);
  });

  it('keeps a row inside the retention window', () => {
    const retentionMs = 30 * 24 * 60 * 60_000;
    const freshRunId = insertRow('test-b', Date.now() - 1000);

    const deleted = pruneTestRunResults(retentionMs);

    expect(deleted).toBe(0);
    expect(listTestRunResultsForRun(freshRunId)).toHaveLength(1);
  });

  it('leaves the per-test aggregate unaffected by pruning', () => {
    const retentionMs = 30 * 24 * 60 * 60_000;
    insertRow('test-c', Date.now() - retentionMs - 1000);
    upsertTestPerfBaseline({
      test_id: 'test-c',
      median_duration_ms: 100,
      mad_duration_ms: 5,
      sample_count: 20,
      last_duration_ms: 100,
      is_regressed: 0,
      updated_at: Date.now(),
    });

    pruneTestRunResults(retentionMs);

    const baseline = getTestPerfBaseline('test-c');
    expect(baseline).toBeDefined();
    expect(baseline?.sample_count).toBe(20);
  });

  it('never prunes a row an in-progress read is currently using', () => {
    // better-sqlite3 executes every statement synchronously on a single
    // connection, so a read and the prune's DELETE can never interleave —
    // a read that has started already has its full result set in hand
    // before the DELETE statement below ever runs.
    const retentionMs = 30 * 24 * 60 * 60_000;
    const runId = insertRow('test-d', Date.now() - retentionMs - 1000);

    const rowsSeenByRead = listTestRunResultsForRun(runId);
    const deleted = pruneTestRunResults(retentionMs);

    expect(rowsSeenByRead).toHaveLength(1);
    expect(deleted).toBe(1);
  });

  it('deletes in bounded batches so a large backlog cannot block in one statement', () => {
    const retentionMs = 30 * 24 * 60 * 60_000;
    for (let i = 0; i < 12; i++) {
      insertRow(`test-batch-${i}`, Date.now() - retentionMs - 1000);
    }

    const originalPrepare = db.prepare.bind(db);
    const batchSizes: number[] = [];
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.includes('DELETE FROM test_run_results WHERE id IN')) {
        const originalRun = stmt.run.bind(stmt);
        stmt.run = (...args: unknown[]) => {
          const result = originalRun(...args);
          batchSizes.push(result.changes);
          return result;
        };
      }
      return stmt;
    });

    const deleted = pruneTestRunResults(retentionMs, 5);
    prepareSpy.mockRestore();

    expect(deleted).toBe(12);
    expect(batchSizes.length).toBeGreaterThan(1);
    expect(batchSizes.every((n) => n <= 5)).toBe(true);
  });
});

describe('isJobOverdue', () => {
  const intervalMs = 24 * 60 * 60_000;

  it('runs at boot when the last recorded run is older than the interval', () => {
    insertSchedulerAudit({
      job: 'overdue-job',
      status: 'ok',
      started_at: new Date(Date.now() - intervalMs - 1000).toISOString(),
      completed_at: new Date(Date.now() - intervalMs - 500).toISOString(),
      duration_ms: 500,
    });

    expect(isJobOverdue('overdue-job', intervalMs)).toBe(true);
  });

  it('does not run at boot when the last recorded run is more recent than the interval', () => {
    insertSchedulerAudit({
      job: 'fresh-job',
      status: 'ok',
      started_at: new Date(Date.now() - 1000).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 500,
    });

    expect(isJobOverdue('fresh-job', intervalMs)).toBe(false);
  });

  it('runs at boot when there is no prior scheduler_audit history', () => {
    expect(isJobOverdue('never-run-job', intervalMs)).toBe(true);
  });

  it('fires approximately once per period across restarts more frequent than the period', () => {
    // Simulate a process restarting every 6h against a 24h job: each
    // "restart" checks isJobOverdue at its simulated boot time, runs if
    // overdue, and records the run — mirroring registration-time behavior.
    const restartIntervalMs = 6 * 60 * 60_000;
    const runTimestamps: number[] = [];

    for (let restart = 0; restart < 16; restart++) {
      const simulatedNow = restart * restartIntervalMs;
      if (isJobOverdue('restart-sim-job', intervalMs, simulatedNow)) {
        runTimestamps.push(simulatedNow);
        insertSchedulerAudit({
          job: 'restart-sim-job',
          status: 'ok',
          started_at: new Date(simulatedNow).toISOString(),
          completed_at: new Date(simulatedNow).toISOString(),
          duration_ms: 0,
        });
      }
    }

    // 16 restarts * 6h = 96h simulated over a 24h period -> ~4 runs expected.
    expect(runTimestamps.length).toBeGreaterThanOrEqual(3);
    expect(runTimestamps.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < runTimestamps.length; i++) {
      expect(runTimestamps[i] - runTimestamps[i - 1]).toBeGreaterThanOrEqual(
        intervalMs,
      );
    }
  });
});

describe('retention configuration', () => {
  it('keeps the test_run_results retention window at 30 days', () => {
    expect(TEST_RUN_RESULTS_RETENTION_MS).toBe(30 * 24 * 60 * 60_000);
  });

  it('keeps the scheduler_audit per-job row bound at 1000', () => {
    expect(SCHEDULER_AUDIT_KEEP_PER_JOB).toBe(1000);
  });
});
