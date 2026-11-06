import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import { getTestHistory, TEST_RUN_RESULTS_RETENTION_MS } from '../queries.js';

const NOW = 1_700_000_000_000;

function sample(
  testId: string,
  at: number,
  outcome: string | null,
  duration: number | null,
) {
  db.prepare(
    `INSERT INTO test_sample (test_id, project_id, run_id, sequenced_at, outcome, duration_ms, content_hash)
     VALUES (?, 'p1', NULL, ?, ?, ?, NULL)`,
  ).run(testId, at, outcome, duration);
}

describe('getTestHistory', () => {
  beforeEach(() => {
    db.exec(
      `DELETE FROM test_sample; DELETE FROM test_sample_history; DELETE FROM test_run_results; DELETE FROM test_perf_baselines;`,
    );
  });

  it('returns test_sample rows in sequenced_at order and weekly buckets', () => {
    sample('t1', 30, 'F', null);
    sample('t1', 10, 'P', null);
    sample('t1', 20, null, 150);
    db.prepare(
      `INSERT INTO test_sample_history (test_id, project_id, week_start, pass_count, fail_count)
       VALUES ('t1', 'p1', 5, 3, 1)`,
    ).run();
    const h = getTestHistory('p1', 't1', NOW);
    expect(h.outcomeSamples.map((s) => s.outcome)).toEqual(['P', 'F']);
    expect(h.durationSamples.map((s) => s.durationMs)).toEqual([150]);
    expect(h.weeklyBuckets).toHaveLength(1);
    expect(h.weeklyBuckets[0].passCount).toBe(3);
  });

  it('scopes to the project', () => {
    sample('t1', 10, 'P', null);
    expect(getTestHistory('other', 't1', NOW).outcomeSamples).toEqual([]);
  });

  it('bounds failure messages to the retention window and returns the horizon', () => {
    const insert = db.prepare(
      `INSERT INTO test_run_results
         (test_request_run_id, project_id, test_id, name, outcome, duration_ms, failure_message, created_at)
       VALUES ('r', 'p1', 't1', 't1', 'failed', 1, ?, ?)`,
    );
    db.pragma('foreign_keys = OFF');
    insert.run('old', NOW - TEST_RUN_RESULTS_RETENTION_MS - 1000);
    insert.run('recent', NOW - 1000);
    const h = getTestHistory('p1', 't1', NOW);
    expect(h.failures.map((f) => f.failureMessage)).toEqual(['recent']);
    expect(h.failureRetentionMs).toBe(TEST_RUN_RESULTS_RETENTION_MS);
    expect(h.failureHorizonMs).toBe(NOW - TEST_RUN_RESULTS_RETENTION_MS);
  });
});
