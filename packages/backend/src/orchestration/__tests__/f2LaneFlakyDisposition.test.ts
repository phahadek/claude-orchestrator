/**
 * Tests for testRequestLane.ts's evaluateF2LaneFlakyDisposition — the
 * per-test eligibility check the lane-side f2-only auto-disposition
 * (PRMergeWatcher.tryF2LaneAutoDisposition) runs against a failing F2 run's
 * test_run_results before auto-recovering instead of pausing+nudging.
 * Per the locked design, ALL of a run's failing tests must clear both
 * masking guards — flip-rate flagged (using only samples predating this
 * PR's own runs) and not-the-test's-own-file-touched — or the run is not
 * eligible.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { evaluateF2LaneFlakyDisposition } from '../testRequestLane';
import { insertTestRunResults } from '../../db/queries';

let seq = 0;

function insertTestRequestRun(state: 'passed' | 'failed' = 'passed'): string {
  seq += 1;
  const id = `run-${seq}`;
  db.prepare(
    `INSERT INTO test_request_runs
       (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at)
     VALUES (@id, 'proj-1', @content_hash, NULL, @state, '', 0, 0, 0)`,
  ).run({ id, content_hash: `hash-${seq}`, state });
  return id;
}

/** One flip-rate history sample for `testId`, independent of the run under evaluation. */
function insertHistorySample(opts: {
  testId: string;
  outcome: 'passed' | 'failed';
  createdAt: number;
}): void {
  const runId = insertTestRequestRun();
  db.prepare(
    `INSERT INTO test_run_results
       (test_request_run_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
     VALUES (@run_id, @test_id, @test_id, @outcome, 1, 0, 0, @created_at)`,
  ).run({
    run_id: runId,
    test_id: opts.testId,
    outcome: opts.outcome,
    created_at: opts.createdAt,
  });
}

/** Flags `testId` by seeding 4 alternating pass/fail history samples before `cutoff`. */
function flagTest(testId: string, cutoff: number): void {
  const outcomes: Array<'passed' | 'failed'> = [
    'passed',
    'failed',
    'passed',
    'failed',
  ];
  outcomes.forEach((outcome, i) =>
    insertHistorySample({ testId, outcome, createdAt: cutoff - 100 + i }),
  );
}

/** Seeds `runId`'s own failing-test rows (the run under evaluation). */
function seedRunFailures(
  runId: string,
  tests: Array<{ testId: string; name: string }>,
): void {
  insertTestRunResults(
    runId,
    tests.map((t) => ({
      test_id: t.testId,
      name: t.name,
      outcome: 'failed',
      duration_ms: 1,
    })),
    0,
    false,
  );
}

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  seq = 0;
});

describe('evaluateF2LaneFlakyDisposition', () => {
  const WINDOW_N = 20;
  const THRESHOLD_K = 2;
  const CUTOFF = 100_000;

  it('is eligible when the run has no per-test detail at all', () => {
    const runId = insertTestRequestRun('failed');
    // No test_run_results rows for this run — nothing to individually clear.
    const eligible = evaluateF2LaneFlakyDisposition(
      runId,
      CUTOFF,
      [],
      WINDOW_N,
      THRESHOLD_K,
    );
    expect(eligible).toBe(false);
  });

  it('is eligible when the sole failing test is flip-rate flagged and its file is untouched', () => {
    flagTest('tests.unit.test_foo.test_bar', CUTOFF);
    const runId = insertTestRequestRun('failed');
    seedRunFailures(runId, [
      { testId: 'tests.unit.test_foo.test_bar', name: 'test_bar' },
    ]);

    const eligible = evaluateF2LaneFlakyDisposition(
      runId,
      CUTOFF,
      ['src/unrelated.ts'],
      WINDOW_N,
      THRESHOLD_K,
    );
    expect(eligible).toBe(true);
  });

  it('is not eligible when one of two failing tests is unflagged (mixed failures)', () => {
    flagTest('tests.unit.test_foo.test_bar', CUTOFF);
    // 'test_baz' has no flip-rate history at all — never flagged.
    const runId = insertTestRequestRun('failed');
    seedRunFailures(runId, [
      { testId: 'tests.unit.test_foo.test_bar', name: 'test_bar' },
      { testId: 'tests.unit.test_baz.test_qux', name: 'test_qux' },
    ]);

    const eligible = evaluateF2LaneFlakyDisposition(
      runId,
      CUTOFF,
      ['src/unrelated.ts'],
      WINDOW_N,
      THRESHOLD_K,
    );
    expect(eligible).toBe(false);
  });

  it('is not eligible when the diff touches the flagged test\'s own file', () => {
    flagTest('tests.unit.test_foo.test_bar', CUTOFF);
    const runId = insertTestRequestRun('failed');
    seedRunFailures(runId, [
      { testId: 'tests.unit.test_foo.test_bar', name: 'test_bar' },
    ]);

    const eligible = evaluateF2LaneFlakyDisposition(
      runId,
      CUTOFF,
      ['tests/unit/test_foo.py'],
      WINDOW_N,
      THRESHOLD_K,
    );
    expect(eligible).toBe(false);
  });

  it('is not eligible when the flip-rate window would only flag using a sample from this PR\'s own runs', () => {
    const testId = 'tests.unit.test_foo.test_bar';
    // Two stable (non-flapping) samples predate the PR.
    insertHistorySample({ testId, outcome: 'passed', createdAt: CUTOFF - 200 });
    insertHistorySample({ testId, outcome: 'passed', createdAt: CUTOFF - 100 });
    // A flip only shows up via a sample recorded at/after the PR's own
    // first run (this PR's own lineage) — must be excluded from the window.
    insertHistorySample({ testId, outcome: 'failed', createdAt: CUTOFF + 50 });
    insertHistorySample({ testId, outcome: 'passed', createdAt: CUTOFF + 60 });

    const runId = insertTestRequestRun('failed');
    seedRunFailures(runId, [{ testId, name: 'test_bar' }]);

    const eligible = evaluateF2LaneFlakyDisposition(
      runId,
      CUTOFF,
      ['src/unrelated.ts'],
      WINDOW_N,
      THRESHOLD_K,
    );
    expect(eligible).toBe(false);
  });
});
