/**
 * Tests for the test_run_results → test_perf_baselines digest backfill in
 * schema.ts: the forward-only migration that collapses every raw
 * test_run_results row accumulated before the digest-at-ingest change into
 * the per-test_id digest, then deletes the now-redundant passing rows. See
 * "Collapse the existing test_run_results rows into the digest" task.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  runMigrations,
  backfillTestRunResultsDigest,
  deleteSubsumedPassingTestRunResults,
  runTestRunResultsDigestBackfillAndPrune,
  TEST_RUN_RESULTS_DIGEST_BACKFILL_MARKER,
  TEST_RUN_RESULTS_PASSING_ROWS_DELETE_MARKER,
  TEST_RUN_RESULTS_DIGEST_OUTCOME_CAPACITY,
} from '../schema.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Clears the guard markers so a subsequent runMigrations() re-runs the backfill/delete as if against a pre-existing, never-migrated database. */
function resetBackfillMarkers(db: Database.Database): void {
  db.prepare(`DELETE FROM schema_backfills WHERE name IN (?, ?)`).run(
    TEST_RUN_RESULTS_DIGEST_BACKFILL_MARKER,
    TEST_RUN_RESULTS_PASSING_ROWS_DELETE_MARKER,
  );
}

let seq = 0;

function insertRun(db: Database.Database, projectId: string): string {
  seq += 1;
  const runId = `run-${seq}`;
  db.prepare(
    `INSERT INTO test_request_runs
       (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at)
     VALUES (@id, @project_id, @content_hash, NULL, 'passed', '', 0, 0, 0)`,
  ).run({ id: runId, project_id: projectId, content_hash: `hash-${seq}` });
  return runId;
}

function insertRawRow(
  db: Database.Database,
  opts: {
    runId: string;
    projectId: string;
    testId: string;
    name: string;
    outcome: string;
    durationMs: number;
    concurrentRunCount: number;
    oomKilled: boolean;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO test_run_results
       (test_request_run_id, project_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
     VALUES (@run_id, @project_id, @test_id, @name, @outcome, @duration_ms, @concurrent_run_count, @oom_killed, @created_at)`,
  ).run({
    run_id: opts.runId,
    project_id: opts.projectId,
    test_id: opts.testId,
    name: opts.name,
    outcome: opts.outcome,
    duration_ms: opts.durationMs,
    concurrent_run_count: opts.concurrentRunCount,
    oom_killed: opts.oomKilled ? 1 : 0,
    created_at: opts.createdAt,
  });
}

function getDigest(
  db: Database.Database,
  testId: string,
):
  | {
      median_duration_ms: number;
      mad_duration_ms: number;
      sample_count: number;
      recent_outcomes: string;
      recent_durations: string;
    }
  | undefined {
  return db
    .prepare(
      `SELECT median_duration_ms, mad_duration_ms, sample_count, recent_outcomes, recent_durations
       FROM test_perf_baselines WHERE test_id = ?`,
    )
    .get(testId) as
    | {
        median_duration_ms: number;
        mad_duration_ms: number;
        sample_count: number;
        recent_outcomes: string;
        recent_durations: string;
      }
    | undefined;
}

// Independent reference implementation of the median/MAD windowed baseline
// algorithm (computeTestPerfBaseline in testRequestLane.ts), computed
// directly from raw newest-first durations — used to prove the backfilled
// digest matches "computing directly from the raw rows".
const BASELINE_WINDOW_SAMPLES = 20;
const MIN_CONSECUTIVE_REGRESSED_SAMPLES = 3;

function referenceMedian(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function referenceMad(values: number[], center: number): number {
  const deviations = values
    .map((v) => Math.abs(v - center))
    .sort((a, b) => a - b);
  return referenceMedian(deviations);
}

function referenceBaseline(durationsNewestFirst: number[]): {
  median: number;
  mad: number;
  sampleCount: number;
} {
  const samples = durationsNewestFirst.slice(
    0,
    BASELINE_WINDOW_SAMPLES + MIN_CONSECUTIVE_REGRESSED_SAMPLES,
  );
  if (samples.length <= MIN_CONSECUTIVE_REGRESSED_SAMPLES) {
    const sorted = [...samples].sort((a, b) => a - b);
    const med = referenceMedian(sorted);
    return {
      median: med,
      mad: referenceMad(samples, med),
      sampleCount: samples.length,
    };
  }
  const baselineSamples = samples.slice(MIN_CONSECUTIVE_REGRESSED_SAMPLES);
  const sortedBaseline = [...baselineSamples].sort((a, b) => a - b);
  const baselineMedian = referenceMedian(sortedBaseline);
  return {
    median: baselineMedian,
    mad: referenceMad(baselineSamples, baselineMedian),
    sampleCount: baselineSamples.length,
  };
}

function referenceTransitionCount(outcomesOldestFirst: string[]): number {
  let transitions = 0;
  for (let i = 1; i < outcomesOldestFirst.length; i++) {
    if (outcomesOldestFirst[i] !== outcomesOldestFirst[i - 1]) transitions++;
  }
  return transitions;
}

describe('test_run_results digest backfill', () => {
  it('matches median/MAD and flip-rate transition count computed directly from raw rows, using only valid samples', () => {
    const db = freshDb();
    const runId = insertRun(db, 'proj-1');
    const testId = 'test-a';

    const validOutcomesOldestFirst: string[] = [];
    const validDurationsOldestFirst: number[] = [];
    let createdAt = 1;
    for (let i = 0; i < 35; i++) {
      const outcome = i % 3 === 0 ? 'failed' : 'passed';
      const durationMs = 100 + i;
      insertRawRow(db, {
        runId,
        projectId: 'proj-1',
        testId,
        name: 'suite > a',
        outcome,
        durationMs,
        concurrentRunCount: 0,
        oomKilled: false,
        createdAt: createdAt++,
      });
      validOutcomesOldestFirst.push(outcome);
      validDurationsOldestFirst.push(durationMs);

      // Interleave invalid samples with wildly different values that must
      // never influence the digest.
      insertRawRow(db, {
        runId,
        projectId: 'proj-1',
        testId,
        name: 'suite > a',
        outcome: 'failed',
        durationMs: 99999,
        concurrentRunCount: 2,
        oomKilled: false,
        createdAt: createdAt++,
      });
    }

    backfillTestRunResultsDigest(db);

    const digest = getDigest(db, testId);
    expect(digest).toBeDefined();

    const expectedDurationsNewestFirst = [...validDurationsOldestFirst]
      .slice(-32)
      .reverse();
    const expectedBaseline = referenceBaseline(expectedDurationsNewestFirst);
    const expectedTransitionCount = referenceTransitionCount(
      validOutcomesOldestFirst.slice(-200),
    );

    expect(digest!.median_duration_ms).toBe(expectedBaseline.median);
    expect(digest!.mad_duration_ms).toBe(expectedBaseline.mad);
    expect(digest!.sample_count).toBe(expectedBaseline.sampleCount);

    const outcomes = JSON.parse(digest!.recent_outcomes) as {
      o: string;
      t: number;
    }[];
    let actualTransitions = 0;
    for (let i = 1; i < outcomes.length; i++) {
      if (outcomes[i].o !== outcomes[i - 1].o) actualTransitions++;
    }
    expect(actualTransitions).toBe(expectedTransitionCount);
  });

  it('excludes rows with concurrent_run_count != 0 or oom_killed = 1 from the derived sequence and ring', () => {
    const db = freshDb();
    const runId = insertRun(db, 'proj-1');
    const testId = 'test-validity';

    for (let i = 0; i < 5; i++) {
      insertRawRow(db, {
        runId,
        projectId: 'proj-1',
        testId,
        name: 'suite > validity',
        outcome: 'passed',
        durationMs: 100,
        concurrentRunCount: 0,
        oomKilled: false,
        createdAt: i + 1,
      });
    }
    for (let i = 0; i < 5; i++) {
      insertRawRow(db, {
        runId,
        projectId: 'proj-1',
        testId,
        name: 'suite > validity',
        outcome: 'failed',
        durationMs: 777,
        concurrentRunCount: 1,
        oomKilled: false,
        createdAt: 100 + i,
      });
    }
    insertRawRow(db, {
      runId,
      projectId: 'proj-1',
      testId,
      name: 'suite > validity',
      outcome: 'failed',
      durationMs: 888,
      concurrentRunCount: 0,
      oomKilled: true,
      createdAt: 200,
    });

    backfillTestRunResultsDigest(db);

    const digest = getDigest(db, testId)!;
    const outcomes = JSON.parse(digest.recent_outcomes) as { o: string }[];
    const durations = JSON.parse(digest.recent_durations) as number[];

    expect(outcomes.every((o) => o.o === 'P')).toBe(true);
    expect(outcomes.length).toBe(5);
    expect(durations.every((d) => d === 100)).toBe(true);
  });

  it('retains non-passing rows and deletes passing rows subsumed by the digest', () => {
    const db = freshDb();
    const runId = insertRun(db, 'proj-1');
    const testId = 'test-delete';

    for (let i = 0; i < 4; i++) {
      insertRawRow(db, {
        runId,
        projectId: 'proj-1',
        testId,
        name: 'suite > delete',
        outcome: 'passed',
        durationMs: 100,
        concurrentRunCount: 0,
        oomKilled: false,
        createdAt: i + 1,
      });
    }
    for (const outcome of ['failed', 'skipped', 'error']) {
      insertRawRow(db, {
        runId,
        projectId: 'proj-1',
        testId,
        name: 'suite > delete',
        outcome,
        durationMs: 200,
        concurrentRunCount: 0,
        oomKilled: false,
        createdAt: 10,
      });
    }

    backfillTestRunResultsDigest(db);
    deleteSubsumedPassingTestRunResults(db);

    const remaining = db
      .prepare(`SELECT outcome FROM test_run_results WHERE test_id = ?`)
      .all(testId) as { outcome: string }[];
    expect(remaining.map((r) => r.outcome).sort()).toEqual([
      'error',
      'failed',
      'skipped',
    ]);
  });

  it('runs the backfill and delete in bounded batches, never exceeding the declared per-statement cap', () => {
    const db = freshDb();
    const runId = insertRun(db, 'proj-1');
    const smallBatch = 4;
    const distinctTestIdCount = 11; // > 2 * smallBatch, forces multiple pagination rounds

    for (let t = 0; t < distinctTestIdCount; t++) {
      insertRawRow(db, {
        runId,
        projectId: 'proj-1',
        testId: `test-batch-${t}`,
        name: 'suite > batch',
        outcome: 'passed',
        durationMs: 100,
        concurrentRunCount: 0,
        oomKilled: false,
        createdAt: t + 1,
      });
    }

    const originalPrepare = db.prepare.bind(db);
    const idPaginationCallSizes: number[] = [];
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((
      sql: string,
      ...rest: unknown[]
    ) => {
      const stmt = originalPrepare(sql, ...(rest as []));
      if (sql.includes('SELECT DISTINCT test_id')) {
        const originalAll = stmt.all.bind(stmt);
        (stmt as unknown as { all: typeof stmt.all }).all = ((
          ...args: unknown[]
        ) => {
          const rows = originalAll(...(args as []));
          idPaginationCallSizes.push((rows as unknown[]).length);
          return rows;
        }) as typeof stmt.all;
      }
      return stmt;
    }) as typeof db.prepare;

    const processed = backfillTestRunResultsDigest(db, smallBatch);

    expect(processed).toBe(distinctTestIdCount);
    expect(idPaginationCallSizes.length).toBeGreaterThan(1);
    for (const size of idPaginationCallSizes) {
      expect(size).toBeLessThanOrEqual(smallBatch);
    }

    // Per-test_id raw-row reads are capped independently at
    // TEST_RUN_RESULTS_DIGEST_OUTCOME_CAPACITY regardless of batchSize —
    // seed one test_id well past that cap and confirm the ring never
    // exceeds it.
    const heavyTestId = 'test-batch-heavy';
    for (let i = 0; i < TEST_RUN_RESULTS_DIGEST_OUTCOME_CAPACITY + 50; i++) {
      insertRawRow(db, {
        runId,
        projectId: 'proj-1',
        testId: heavyTestId,
        name: 'suite > batch-heavy',
        outcome: i % 2 === 0 ? 'passed' : 'failed',
        durationMs: 100 + i,
        concurrentRunCount: 0,
        oomKilled: false,
        createdAt: 5000 + i,
      });
    }
    backfillTestRunResultsDigest(db, smallBatch);
    const heavyDigest = getDigest(db, heavyTestId)!;
    const heavyOutcomes = JSON.parse(heavyDigest.recent_outcomes) as unknown[];
    expect(heavyOutcomes.length).toBeLessThanOrEqual(
      TEST_RUN_RESULTS_DIGEST_OUTCOME_CAPACITY,
    );

    // Delete side: seed more passing rows than smallBatch across a single
    // test_id and confirm every row is still removed via multiple bounded
    // DELETE iterations.
    const deleteRunId = insertRun(db, 'proj-1');
    for (let i = 0; i < 13; i++) {
      insertRawRow(db, {
        runId: deleteRunId,
        projectId: 'proj-1',
        testId: 'test-delete-batch',
        name: 'suite > delete-batch',
        outcome: 'passed',
        durationMs: 50,
        concurrentRunCount: 0,
        oomKilled: false,
        createdAt: 2000 + i,
      });
    }
    const deleted = deleteSubsumedPassingTestRunResults(db, smallBatch);
    expect(deleted).toBeGreaterThanOrEqual(13);
    const remainingPassing = db
      .prepare(
        `SELECT COUNT(*) as c FROM test_run_results WHERE outcome = 'passed'`,
      )
      .get() as { c: number };
    expect(remainingPassing.c).toBe(0);
  });

  it('is idempotent: running the guarded migration twice leaves digest values unchanged and never double-deletes', () => {
    const db = freshDb();
    resetBackfillMarkers(db);
    const runId = insertRun(db, 'proj-1');
    const testId = 'test-idem';

    for (let i = 0; i < 5; i++) {
      insertRawRow(db, {
        runId,
        projectId: 'proj-1',
        testId,
        name: 'suite > idem',
        outcome: i % 2 === 0 ? 'passed' : 'failed',
        durationMs: 100 + i,
        concurrentRunCount: 0,
        oomKilled: false,
        createdAt: i + 1,
      });
    }

    runTestRunResultsDigestBackfillAndPrune(db);
    const firstDigest = getDigest(db, testId);
    const firstRowCount = (
      db.prepare(`SELECT COUNT(*) as c FROM test_run_results`).get() as {
        c: number;
      }
    ).c;

    runMigrations(db);

    const secondDigest = getDigest(db, testId);
    const secondRowCount = (
      db.prepare(`SELECT COUNT(*) as c FROM test_run_results`).get() as {
        c: number;
      }
    ).c;

    expect(secondDigest).toEqual(firstDigest);
    expect(secondRowCount).toBe(firstRowCount);
  });

  it('gives a test_id present only in raw rows (no existing test_perf_baselines row) a digest row rather than skipping it', () => {
    const db = freshDb();
    const runId = insertRun(db, 'proj-1');
    const testId = 'test-new';

    expect(getDigest(db, testId)).toBeUndefined();

    insertRawRow(db, {
      runId,
      projectId: 'proj-1',
      testId,
      name: 'suite > new',
      outcome: 'passed',
      durationMs: 123,
      concurrentRunCount: 0,
      oomKilled: false,
      createdAt: 1,
    });

    backfillTestRunResultsDigest(db);

    const digest = getDigest(db, testId);
    expect(digest).toBeDefined();
    expect(digest!.sample_count).toBe(1);
  });
});
