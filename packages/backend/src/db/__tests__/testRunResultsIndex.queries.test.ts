/**
 * Tests for the test_run_results(test_id, created_at) index.
 *
 * ingestTestRunResults runs two per-test_id reads for EVERY test in a
 * completed run — computeTestPerfBaseline's duration read and
 * computeTestFlipRateFlag's outcome-history read. With ~9.5k tests per run
 * and no index on test_id, both fell back to walking
 * idx_test_run_results_created_at and filtering, so each lookup scaled with
 * the whole table (measured 52 ms on 134,951 rows => ~17 minutes of
 * synchronous main-thread work after every test run, lengthening as the
 * table grew). These assert the access path, not timing, so a regression
 * shows up as a plan change rather than a flaky benchmark.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';

/** Plan text for a statement, joined so it can be asserted as a whole. */
function planFor(sql: string, params: unknown[]): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
      detail: string;
    }[]
  )
    .map((r) => r.detail)
    .join(' | ');
}

// The two statements exactly as queries.ts issues them.
const FLIP_RATE_SQL = `
  SELECT outcome FROM (
    SELECT outcome, created_at, id
    FROM test_run_results
    WHERE test_id = ?
      AND concurrent_run_count = 0
      AND oom_killed = 0
      AND outcome IN ('passed', 'failed')
      AND created_at < ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  )
  ORDER BY created_at ASC, id ASC
`;

const PERF_BASELINE_SQL = `
  SELECT duration_ms FROM test_run_results
  WHERE test_id = ? AND concurrent_run_count = 0 AND oom_killed = 0
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`;

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
});

describe('test_run_results(test_id, created_at) index', () => {
  it('is created by the schema', () => {
    const idx = db.prepare(`PRAGMA index_list(test_run_results)`).all() as {
      name: string;
    }[];
    expect(idx.map((i) => i.name)).toContain(
      'idx_test_run_results_test_id_created_at',
    );
  });

  it('resolves the flip-rate history read by test_id without scanning the table', () => {
    const plan = planFor(FLIP_RATE_SQL, [
      'some-test',
      Number.MAX_SAFE_INTEGER,
      20,
    ]);
    expect(plan).toContain('idx_test_run_results_test_id_created_at');
    // A bare "SCAN test_run_results" (no USING) is the regression this guards.
    expect(plan).not.toMatch(/SCAN test_run_results(?! USING)/);
  });

  it('resolves the perf-baseline duration read by test_id without scanning the table', () => {
    const plan = planFor(PERF_BASELINE_SQL, ['some-test', 20]);
    expect(plan).toContain('idx_test_run_results_test_id_created_at');
    expect(plan).not.toMatch(/SCAN test_run_results(?! USING)/);
  });

  it('serves ORDER BY created_at DESC from the index, without a temp b-tree sort', () => {
    const plan = planFor(PERF_BASELINE_SQL, ['some-test', 20]);
    expect(plan).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  it('still returns the same rows the unindexed query would have', () => {
    const insertRun = db.prepare(
      `INSERT INTO test_request_runs (id, project_id, content_hash, state, started_at)
       VALUES (?, 'proj-1', ?, 'passed', 0)`,
    );
    for (const r of ['run-1', 'run-2', 'run-3', 'run-4'])
      insertRun.run(r, `hash-${r}`);

    const insert = db.prepare(
      `INSERT INTO test_run_results
         (test_request_run_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
    );
    // Two tests interleaved in time, so a wrong index can't accidentally pass.
    insert.run('run-1', 'test-a', 'a', 'passed', 10, 100);
    insert.run('run-2', 'test-b', 'b', 'failed', 20, 110);
    insert.run('run-3', 'test-a', 'a', 'failed', 30, 120);
    insert.run('run-4', 'test-a', 'a', 'passed', 40, 130);

    const outcomes = db
      .prepare(FLIP_RATE_SQL)
      .all('test-a', Number.MAX_SAFE_INTEGER, 20) as { outcome: string }[];
    expect(outcomes.map((o) => o.outcome)).toEqual([
      'passed',
      'failed',
      'passed',
    ]);

    const durations = db.prepare(PERF_BASELINE_SQL).all('test-a', 20) as {
      duration_ms: number;
    }[];
    // ORDER BY created_at DESC — newest first.
    expect(durations.map((d) => d.duration_ms)).toEqual([40, 30, 10]);
  });

  it('returns nothing for a test_id with no rows', () => {
    expect(db.prepare(PERF_BASELINE_SQL).all('no-such-test', 20)).toEqual([]);
  });
});

describe('pull_requests(session_id) index', () => {
  it('resolves getPRBySessionId without scanning the table', () => {
    const plan = planFor(
      `SELECT * FROM pull_requests WHERE session_id = ? LIMIT 1`,
      ['sess-1'],
    );
    expect(plan).toContain('idx_pull_requests_session_id');
    expect(plan).not.toMatch(/SCAN pull_requests(?! USING)/);
  });
});
