/**
 * Tests for db/queries.ts's computeTestFlipRateFlag — the per-test flip-rate
 * flakiness signal. The load-bearing assertions are: the flag flips on at
 * >=K pass<->fail transitions among the last N valid samples, invalid
 * samples (concurrent_run_count > 0 or oom_killed) never occupy a window
 * slot, and the flag is recomputed live (not sticky) so it clears once a
 * fresh sample set no longer carries K transitions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  computeTestFlipRateFlag,
  recordTestPerfDigestSample,
} from '../queries.js';

let seq = 0;

function insertRun(): string {
  seq += 1;
  const id = `run-${seq}`;
  db.prepare(
    `INSERT INTO test_request_runs
       (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at)
     VALUES (@id, 'proj-1', @content_hash, NULL, 'passed', '', 0, 0, 0)`,
  ).run({ id, content_hash: `hash-${seq}` });
  return id;
}

/**
 * computeTestFlipRateFlag now reads the test_perf_baselines digest rather
 * than raw test_run_results rows — recordTestPerfDigestSample is the same
 * write ingestTestRunResultsTx makes per test at ingestion time.
 * createdAt doubles as the digest's caller-assigned sequenced-at value, so
 * ordering in these fixtures stays exactly what the test author wrote.
 */
function insertSample(opts: {
  testId: string;
  outcome: 'passed' | 'failed';
  concurrentRunCount?: number;
  oomKilled?: boolean;
  createdAt: number;
  foreignConcurrentRunCount?: number | null;
}): void {
  insertRun();
  recordTestPerfDigestSample(
    opts.testId,
    'proj-1',
    opts.testId,
    opts.outcome,
    1,
    opts.concurrentRunCount ?? 0,
    opts.oomKilled ?? false,
    opts.createdAt,
    undefined,
    opts.foreignConcurrentRunCount,
  );
}

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM test_perf_baselines').run();
  seq = 0;
});

describe('computeTestFlipRateFlag', () => {
  it('flags a test with >=K transitions among its last N valid samples', () => {
    const outcomes: Array<'passed' | 'failed'> = [
      'passed',
      'failed',
      'passed',
      'failed',
    ];
    outcomes.forEach((outcome, i) =>
      insertSample({ testId: 'test-a', outcome, createdAt: i }),
    );

    const flag = computeTestFlipRateFlag('test-a', 20, 2);
    expect(flag.transitionCount).toBe(3);
    expect(flag.flagged).toBe(true);
  });

  it('does not flag a test with <K transitions', () => {
    const outcomes: Array<'passed' | 'failed'> = [
      'passed',
      'passed',
      'failed',
      'failed',
    ];
    outcomes.forEach((outcome, i) =>
      insertSample({ testId: 'test-b', outcome, createdAt: i }),
    );

    const flag = computeTestFlipRateFlag('test-b', 20, 2);
    expect(flag.transitionCount).toBe(1);
    expect(flag.flagged).toBe(false);
  });

  it('never counts a sample with concurrent_run_count > 0 or oom_killed as a window slot, pass, fail, or transition', () => {
    insertSample({ testId: 'test-c', outcome: 'passed', createdAt: 0 });
    insertSample({
      testId: 'test-c',
      outcome: 'failed',
      concurrentRunCount: 1,
      createdAt: 1,
    });
    insertSample({
      testId: 'test-c',
      outcome: 'failed',
      oomKilled: true,
      createdAt: 2,
    });
    insertSample({ testId: 'test-c', outcome: 'passed', createdAt: 3 });

    const flag = computeTestFlipRateFlag('test-c', 20, 2);
    expect(flag.sampleCount).toBe(2);
    expect(flag.transitionCount).toBe(0);
    expect(flag.flagged).toBe(false);
  });

  it('never counts a sample with a nonzero foreign_concurrent_run_count as a window slot, and treats a NULL foreign count as zero', () => {
    insertSample({ testId: 'test-foreign', outcome: 'passed', createdAt: 0 });
    insertSample({
      testId: 'test-foreign',
      outcome: 'failed',
      foreignConcurrentRunCount: 1,
      createdAt: 1,
    });
    insertSample({
      testId: 'test-foreign',
      outcome: 'failed',
      foreignConcurrentRunCount: null,
      createdAt: 2,
    });

    const flag = computeTestFlipRateFlag('test-foreign', 20, 2);
    // The foreign-contended sample never occupies a slot; the NULL-foreign
    // sample (a pre-migration row) is treated as 0 and does occupy one.
    expect(flag.sampleCount).toBe(2);
    expect(flag.transitionCount).toBe(1);
  });

  it('clears once a fresh window recomputation drops the transition count back below K', () => {
    const flapping: Array<'passed' | 'failed'> = [
      'passed',
      'failed',
      'passed',
      'failed',
    ];
    flapping.forEach((outcome, i) =>
      insertSample({ testId: 'test-d', outcome, createdAt: i }),
    );
    expect(computeTestFlipRateFlag('test-d', 4, 2).flagged).toBe(true);

    // Fresh ingestions push the window forward with stable passes, aging
    // the flapping samples out of the last-N window.
    insertSample({ testId: 'test-d', outcome: 'passed', createdAt: 4 });
    insertSample({ testId: 'test-d', outcome: 'passed', createdAt: 5 });
    insertSample({ testId: 'test-d', outcome: 'passed', createdAt: 6 });

    const flag = computeTestFlipRateFlag('test-d', 4, 2);
    expect(flag.transitionCount).toBeLessThan(2);
    expect(flag.flagged).toBe(false);
  });
});
