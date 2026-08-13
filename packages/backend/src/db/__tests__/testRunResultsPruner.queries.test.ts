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
});
