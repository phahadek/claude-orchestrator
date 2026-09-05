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
import {
  insertTestRunResults,
  recordTestPerfDigestSample,
} from '../../db/queries';

let seq = 0;

/** Shared across the flip-rate history fixtures so they keep pooling into one tree, as they did before content-hash scoping — this suite isn't testing that scoping itself. */
const HISTORY_SHARED_HASH = 'history-shared-hash';

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
  insertTestRequestRun();
  // computeTestFlipRateFlag (behind evaluateF2LaneFlakyDisposition) now
  // reads the test_perf_baselines digest rather than raw test_run_results
  // rows. createdAt doubles as the digest's caller-assigned sequenced-at
  // value, preserving the beforeMs cutoff semantics these tests exercise.
  recordTestPerfDigestSample(
    opts.testId,
    'proj-1',
    opts.testId,
    opts.outcome,
    1,
    0,
    false,
    opts.createdAt,
    undefined,
    undefined,
    HISTORY_SHARED_HASH,
  );
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

/**
 * One breadth-signal failure for `testId`, on its own freshly-minted
 * content_hash (insertTestRequestRun mints a new one per call) at `createdAt`
 * — independent of both the flip-rate digest and the run under evaluation,
 * mirroring insertHistorySample's role for the flip-rate signal above.
 */
function insertBreadthFailure(testId: string, createdAt: number): void {
  const runId = insertTestRequestRun('failed');
  db.prepare(
    `INSERT INTO test_run_results
       (test_request_run_id, project_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
     VALUES (@run_id, 'proj-1', @test_id, @name, 'failed', 1, 0, 0, @created_at)`,
  ).run({
    run_id: runId,
    test_id: testId,
    name: testId,
    created_at: createdAt,
  });
}

/** Seeds `testId` as breadth-flagged: `count` failures on distinct trees before `cutoff`. */
function flagTestByBreadth(
  testId: string,
  cutoff: number,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    insertBreadthFailure(testId, cutoff - 100 + i);
  }
}

/** Seeds `runId`'s own failing-test rows (the run under evaluation). */
function seedRunFailures(
  runId: string,
  tests: Array<{ testId: string; name: string }>,
): void {
  insertTestRunResults(
    runId,
    'proj-1',
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
  db.prepare('DELETE FROM test_perf_baselines').run();
  seq = 0;
});

describe('evaluateF2LaneFlakyDisposition', () => {
  const WINDOW_N = 20;
  const THRESHOLD_K = 2;
  const BREADTH_N = 3;
  const BREADTH_WINDOW_HOURS = 24;
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
      BREADTH_N,
      BREADTH_WINDOW_HOURS,
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
      BREADTH_N,
      BREADTH_WINDOW_HOURS,
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
      BREADTH_N,
      BREADTH_WINDOW_HOURS,
    );
    expect(eligible).toBe(false);
  });

  it("is not eligible when the diff touches the flagged test's own file", () => {
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
      BREADTH_N,
      BREADTH_WINDOW_HOURS,
    );
    expect(eligible).toBe(false);
  });

  it("is not eligible when the flip-rate window would only flag using a sample from this PR's own runs", () => {
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
      BREADTH_N,
      BREADTH_WINDOW_HOURS,
    );
    expect(eligible).toBe(false);
  });

  // ── breadth-of-trees signal ────────────────────────────────────────────
  // Supplements flip-rate: a test failing deterministically (never
  // alternates, so flip-rate can never flag it) is still reachable when it
  // fails across enough distinct content hashes to rule out any single diff.

  it('is eligible when the sole failing test is deterministically failing but breadth-flagged, and its file is untouched', () => {
    const testId = 'tests.unit.test_foo.test_bar';
    // Never alternates — flip-rate can never flag this — but fails across
    // BREADTH_N distinct trees, none of them this run.
    flagTestByBreadth(testId, CUTOFF, BREADTH_N);
    const runId = insertTestRequestRun('failed');
    seedRunFailures(runId, [{ testId, name: 'test_bar' }]);

    const eligible = evaluateF2LaneFlakyDisposition(
      runId,
      CUTOFF,
      ['src/unrelated.ts'],
      WINDOW_N,
      THRESHOLD_K,
      BREADTH_N,
      BREADTH_WINDOW_HOURS,
    );
    expect(eligible).toBe(true);
  });

  it('is not eligible when the same deterministically-failing test only fails on fewer than breadthN distinct trees', () => {
    const testId = 'tests.unit.test_foo.test_bar';
    flagTestByBreadth(testId, CUTOFF, BREADTH_N - 1);
    const runId = insertTestRequestRun('failed');
    seedRunFailures(runId, [{ testId, name: 'test_bar' }]);

    const eligible = evaluateF2LaneFlakyDisposition(
      runId,
      CUTOFF,
      ['src/unrelated.ts'],
      WINDOW_N,
      THRESHOLD_K,
      BREADTH_N,
      BREADTH_WINDOW_HOURS,
    );
    expect(eligible).toBe(false);
  });

  it("is not eligible when the diff touches the breadth-flagged test's own file", () => {
    const testId = 'tests.unit.test_foo.test_bar';
    flagTestByBreadth(testId, CUTOFF, BREADTH_N);
    const runId = insertTestRequestRun('failed');
    seedRunFailures(runId, [{ testId, name: 'test_bar' }]);

    const eligible = evaluateF2LaneFlakyDisposition(
      runId,
      CUTOFF,
      ['tests/unit/test_foo.py'],
      WINDOW_N,
      THRESHOLD_K,
      BREADTH_N,
      BREADTH_WINDOW_HOURS,
    );
    expect(eligible).toBe(false);
  });

  it("is not eligible when breadth failures at/after this PR's own created_at are excluded from the window", () => {
    const testId = 'tests.unit.test_foo.test_bar';
    // Only 1 breadth failure predates the PR; the rest occur at/after
    // CUTOFF and must not count toward BREADTH_N.
    insertBreadthFailure(testId, CUTOFF - 100);
    insertBreadthFailure(testId, CUTOFF + 50);
    insertBreadthFailure(testId, CUTOFF + 60);
    const runId = insertTestRequestRun('failed');
    seedRunFailures(runId, [{ testId, name: 'test_bar' }]);

    const eligible = evaluateF2LaneFlakyDisposition(
      runId,
      CUTOFF,
      ['src/unrelated.ts'],
      WINDOW_N,
      THRESHOLD_K,
      BREADTH_N,
      BREADTH_WINDOW_HOURS,
    );
    expect(eligible).toBe(false);
  });
});
