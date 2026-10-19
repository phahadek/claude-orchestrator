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

/** Shared across most fixtures below so pre-existing window/exclusion assertions (which predate hash-scoping) keep testing what they test. */
const SHARED_HASH = 'shared-hash';

/**
 * test_request_runs.content_hash is NOT NULL in the real schema (every
 * requested run always carries the tree hash it was requested against) — a
 * "legacy sample with no content hash" is a test_perf_baselines digest-entry
 * concept (a sample recorded before the `h` field existed), never a
 * test_request_runs row. So this helper always writes a real placeholder
 * hash to satisfy the table's NOT NULL constraint; callers that want to
 * simulate an absent digest hash pass `null` to recordTestPerfDigestSample
 * directly (see insertSample below), not here.
 */
function insertRun(contentHash: string | null): string {
  seq += 1;
  const id = `run-${seq}`;
  db.prepare(
    `INSERT INTO test_request_runs
       (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at)
     VALUES (@id, 'proj-1', @content_hash, NULL, 'passed', '', 0, 0, 0)`,
  ).run({ id, content_hash: contentHash ?? `placeholder-${id}` });
  return id;
}

/**
 * computeTestFlipRateFlag now reads the test_perf_baselines digest rather
 * than raw test_run_results rows — recordTestPerfDigestSample is the same
 * write ingestTestRunResultsTx makes per test at ingestion time.
 * createdAt doubles as the digest's caller-assigned sequenced-at value, so
 * ordering in these fixtures stays exactly what the test author wrote.
 * contentHash defaults to one shared value so fixtures not exercising the
 * hash-scoping behavior itself keep pooling into a single tree, as they did
 * before content-hash scoping existed.
 */
function insertSample(opts: {
  testId: string;
  outcome: 'passed' | 'failed';
  concurrentRunCount?: number;
  oomKilled?: boolean;
  createdAt: number;
  foreignConcurrentRunCount?: number | null;
  contentHash?: string | null;
}): void {
  const contentHash =
    opts.contentHash === undefined ? SHARED_HASH : opts.contentHash;
  insertRun(contentHash);
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
    contentHash,
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

  it('never counts an oom_killed sample as a window slot, pass, fail, or transition, but does count concurrent ones', () => {
    insertSample({ testId: 'test-c', outcome: 'passed', createdAt: 0 });
    insertSample({
      testId: 'test-c',
      outcome: 'passed',
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
    expect(flag.sampleCount).toBe(3);
    expect(flag.transitionCount).toBe(0);
    expect(flag.flagged).toBe(false);
  });

  it('counts a sample with a nonzero or NULL foreign_concurrent_run_count as an outcome window slot', () => {
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
    expect(flag.sampleCount).toBe(3);
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

  it('counts zero transitions for an alternating P/F sequence where every sample carries a distinct content hash', () => {
    const outcomes: Array<'passed' | 'failed'> = [
      'passed',
      'failed',
      'passed',
      'failed',
    ];
    outcomes.forEach((outcome, i) =>
      insertSample({
        testId: 'test-distinct-hash',
        outcome,
        createdAt: i,
        contentHash: `hash-${i}`,
      }),
    );

    const flag = computeTestFlipRateFlag('test-distinct-hash', 20, 2);
    expect(flag.transitionCount).toBe(0);
    expect(flag.flagged).toBe(false);
  });

  it('counts transitions for an alternating P/F/P sequence sharing one content hash, and flags at threshold 2', () => {
    const outcomes: Array<'passed' | 'failed' | 'passed'> = [
      'passed',
      'failed',
      'passed',
    ];
    outcomes.forEach((outcome, i) =>
      insertSample({
        testId: 'test-same-hash',
        outcome,
        createdAt: i,
        contentHash: 'one-tree',
      }),
    );

    const flag = computeTestFlipRateFlag('test-same-hash', 20, 2);
    expect(flag.transitionCount).toBe(2);
    expect(flag.flagged).toBe(true);
  });

  it('never counts a transition when either or both samples in the pair lack a content hash, including a mixed window of legacy and hash-bearing samples', () => {
    // Legacy samples (no h at all) interleaved with hash-bearing samples
    // that don't match each other.
    insertSample({
      testId: 'test-mixed-hash',
      outcome: 'passed',
      createdAt: 0,
      contentHash: null,
    });
    insertSample({
      testId: 'test-mixed-hash',
      outcome: 'failed',
      createdAt: 1,
      contentHash: null,
    });
    insertSample({
      testId: 'test-mixed-hash',
      outcome: 'passed',
      createdAt: 2,
      contentHash: 'hash-x',
    });
    insertSample({
      testId: 'test-mixed-hash',
      outcome: 'failed',
      createdAt: 3,
      contentHash: 'hash-y',
    });

    const flag = computeTestFlipRateFlag('test-mixed-hash', 20, 2);
    expect(flag.sampleCount).toBe(4);
    expect(flag.transitionCount).toBe(0);
    expect(flag.flagged).toBe(false);
  });
});

describe('recordTestPerfDigestSample content hash persistence', () => {
  it('persists h on the appended sample, and stores a null content hash as an absent h rather than a literal null string', () => {
    insertRun('hash-1');
    recordTestPerfDigestSample(
      'test-persist-hash',
      'proj-1',
      'test-persist-hash',
      'passed',
      1,
      0,
      false,
      0,
      undefined,
      undefined,
      'hash-1',
    );
    insertRun(null);
    recordTestPerfDigestSample(
      'test-persist-hash',
      'proj-1',
      'test-persist-hash',
      'failed',
      1,
      0,
      false,
      1,
      undefined,
      undefined,
      null,
    );

    const row = db
      .prepare(
        `SELECT recent_outcomes FROM test_perf_baselines WHERE test_id = ?`,
      )
      .get('test-persist-hash') as { recent_outcomes: string };
    const samples = JSON.parse(row.recent_outcomes);
    expect(samples).toHaveLength(2);
    expect(samples[0].h).toBe('hash-1');
    expect('h' in samples[1]).toBe(false);
  });

  it('appends outcome but not duration samples for concurrent and foreign-concurrent runs, advancing updated_at', () => {
    recordTestPerfDigestSample(
      'test-conc',
      'proj-1',
      'test-conc',
      'passed',
      100,
      0,
      false,
      10,
      undefined,
      undefined,
      'hash-1',
    );
    const concurrent = recordTestPerfDigestSample(
      'test-conc',
      'proj-1',
      'test-conc',
      'failed',
      9999,
      3,
      false,
      20,
      undefined,
      undefined,
      'hash-1',
    );
    const foreign = recordTestPerfDigestSample(
      'test-conc',
      'proj-1',
      'test-conc',
      'passed',
      9999,
      0,
      false,
      30,
      undefined,
      2,
      'hash-1',
    );
    expect(concurrent?.durationAdmitted).toBe(false);
    expect(foreign?.durationAdmitted).toBe(false);

    const row = db
      .prepare(
        `SELECT recent_outcomes, recent_durations, updated_at FROM test_perf_baselines WHERE test_id = ?`,
      )
      .get('test-conc') as {
      recent_outcomes: string;
      recent_durations: string;
      updated_at: number;
    };
    expect(
      JSON.parse(row.recent_outcomes).map((s: { o: string }) => s.o),
    ).toEqual(['P', 'F', 'P']);
    expect(JSON.parse(row.recent_durations)).toEqual([100]);
    expect(row.updated_at).toBe(30);
  });

  it('flags a flip sequence made entirely of concurrent-run outcome samples', () => {
    const outcomes: Array<'passed' | 'failed'> = [
      'passed',
      'failed',
      'passed',
      'failed',
    ];
    outcomes.forEach((outcome, i) =>
      insertSample({
        testId: 'test-conc-flip',
        outcome,
        concurrentRunCount: 3,
        createdAt: i,
      }),
    );
    const flag = computeTestFlipRateFlag('test-conc-flip', 20, 2);
    expect(flag.sampleCount).toBe(4);
    expect(flag.transitionCount).toBe(3);
    expect(flag.flagged).toBe(true);
  });

  it('never writes a digest sample when the run is oom_killed or timed out, even when concurrent', () => {
    recordTestPerfDigestSample(
      'test-excluded',
      'proj-1',
      'test-excluded',
      'failed',
      1,
      1,
      true,
      0,
      undefined,
      undefined,
      'hash-1',
    );
    recordTestPerfDigestSample(
      'test-excluded',
      'proj-1',
      'test-excluded',
      'failed',
      1,
      0,
      false,
      1,
      undefined,
      undefined,
      'hash-1',
      true,
    );
    recordTestPerfDigestSample(
      'test-excluded',
      'proj-1',
      'test-excluded',
      'failed',
      1,
      0,
      true,
      2,
      undefined,
      1,
      'hash-1',
    );

    const row = db
      .prepare(`SELECT * FROM test_perf_baselines WHERE test_id = ?`)
      .get('test-excluded');
    expect(row).toBeUndefined();
  });
});
