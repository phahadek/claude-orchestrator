/**
 * getRegressedTestsForProject (db/queries.ts) must not run its three-way
 * join across test_perf_baselines/test_run_results/test_request_runs when
 * test_perf_baselines holds no is_regressed=1 rows at all — which is always,
 * until the baseline job populates it. This is asserted as its own file so
 * the guard statement's db.prepare call hasn't already been cached by some
 * other test importing queries.ts first.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import { getLaneHealthRollup } from '../queries.js';

describe('getRegressedTestsForProject short-circuit', () => {
  it('never prepares the three-way join when test_perf_baselines has no regressed rows', () => {
    db.prepare(
      `INSERT INTO test_request_runs
         (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at)
       VALUES ('run-1', 'proj-1', 'hash-1', NULL, 'passed', '', 0, 0, 100)`,
    ).run();
    db.prepare(
      `INSERT INTO test_run_results
         (test_request_run_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
       VALUES ('run-1', 'test-a', 'suite > a', 'passed', 10, 0, 0, 1)`,
    ).run();

    const prepareSpy = vi.spyOn(db, 'prepare');
    const rollup = getLaneHealthRollup('proj-1', 500);
    expect(rollup.regressedTests).toEqual([]);

    const sqlTexts = prepareSpy.mock.calls.map((c) => String(c[0]));
    expect(
      sqlTexts.some((sql) => sql.includes('JOIN test_run_results trr')),
    ).toBe(false);

    prepareSpy.mockRestore();
  });
});
