/**
 * Regression coverage for the Tests-tab history endpoint's event-loop-block
 * fix: listTestRunResultsForRun must never return more than
 * TEST_RUN_RESULTS_PER_RUN_CAP rows for a single run, and
 * getTaskTestFlipRateFlags must never fan out to more than
 * FLIP_RATE_FLAG_TEST_ID_CAP computeTestFlipRateFlag invocations — regardless
 * of how many rows/unique test ids actually exist. Both are plan/count
 * assertions on the returned data, not timing-based benchmarks (mirrors
 * commit d30cdce7's own query-plan-assertion approach for the ingestion path
 * this endpoint mirrors on the read side).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertTestRequestRun,
  insertTestRunResults,
  listTestRunResultsForRun,
  countTestRunResultsForRun,
  getTaskTestFlipRateFlags,
  TEST_RUN_RESULTS_PER_RUN_CAP,
  FLIP_RATE_FLAG_TEST_ID_CAP,
} from '../queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
});

describe('listTestRunResultsForRun row cap', () => {
  it('never returns more than TEST_RUN_RESULTS_PER_RUN_CAP rows for a run with far more rows than the cap', () => {
    const runId = 'cap-run-1';
    insertTestRequestRun(runId, 'proj-1', 'hash-1', null, Date.now());
    const rowCount = TEST_RUN_RESULTS_PER_RUN_CAP + 250;
    const tests = Array.from({ length: rowCount }, (_, i) => ({
      test_id: `test-${i}`,
      name: `test-${i}`,
      outcome: 'passed',
      duration_ms: 10,
    }));
    insertTestRunResults(runId, tests, 0, false);

    expect(countTestRunResultsForRun(runId)).toBe(rowCount);
    const results = listTestRunResultsForRun(runId);
    expect(results.length).toBe(TEST_RUN_RESULTS_PER_RUN_CAP);
  });

  it('reports the true row count via countTestRunResultsForRun even when the list itself is capped', () => {
    const runId = 'cap-run-2';
    insertTestRequestRun(runId, 'proj-1', 'hash-2', null, Date.now());
    const tests = Array.from(
      { length: TEST_RUN_RESULTS_PER_RUN_CAP + 1 },
      (_, i) => ({
        test_id: `test-${i}`,
        name: `test-${i}`,
        outcome: 'passed',
        duration_ms: 10,
      }),
    );
    insertTestRunResults(runId, tests, 0, false);

    expect(countTestRunResultsForRun(runId)).toBe(
      TEST_RUN_RESULTS_PER_RUN_CAP + 1,
    );
    expect(listTestRunResultsForRun(runId).length).toBe(
      TEST_RUN_RESULTS_PER_RUN_CAP,
    );
  });
});

describe('getTaskTestFlipRateFlags fan-out cap', () => {
  it('never computes flip-rate flags for more than FLIP_RATE_FLAG_TEST_ID_CAP unique test ids', () => {
    const testIds = Array.from(
      { length: FLIP_RATE_FLAG_TEST_ID_CAP + 500 },
      (_, i) => `test-${i}`,
    );

    const flags = getTaskTestFlipRateFlags(testIds, 20, 2);

    expect(flags.length).toBe(FLIP_RATE_FLAG_TEST_ID_CAP);
  });

  it('dedupes before capping so the count reflects unique ids, not raw occurrences', () => {
    const uniqueIds = Array.from({ length: 10 }, (_, i) => `test-${i}`);
    const testIds = uniqueIds.flatMap((id) => [id, id, id]);

    const flags = getTaskTestFlipRateFlags(testIds, 20, 2);

    expect(flags.length).toBe(10);
  });
});
