/**
 * Covers the lane-health perf fix: listFlaggedFlakyTests's full-history
 * aggregate must never run on the GET /api/milestones/:project/lane-health
 * request path, and the precomputed replacement must report the exact same
 * flagged set the from-scratch computation would have.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  listFlaggedFlakyTests,
  replaceFlaggedFlakyTestsRollup,
  getFlaggedFlakyTestsRollup,
  getLaneHealthRollup,
  recordTestPerfDigestSample,
  computeTestFlipRateFlag,
} from '../queries.js';

/**
 * pruneGhostFlaggedFlakyTests' DELETE statement is prepared once and cached
 * as module state in queries.ts (`_stmtPruneGhostFlaggedFlakyTests`), so
 * `db.prepare` is only ever called with its SQL text on the very first tick
 * anywhere in this file that actually has something to prune. Wrapping
 * `db.prepare` here — before any test runs — lets us intercept that one
 * creation and patch a counter onto the returned statement's `run`, which
 * then stays in place (the module keeps reusing that same statement object)
 * for every later call in the file, regardless of which test triggers it
 * first.
 */
const deleteCalls = { count: 0 };
const originalDbPrepare = db.prepare.bind(db);
vi.spyOn(db, 'prepare').mockImplementation(
  (sql: string, ...rest: unknown[]) => {
    const stmt = (originalDbPrepare as any)(sql, ...rest);
    if (
      typeof sql === 'string' &&
      sql.includes('DELETE FROM flagged_flaky_tests_rollup')
    ) {
      const originalRun = stmt.run.bind(stmt);

      stmt.run = (...runArgs: unknown[]) => {
        deleteCalls.count += 1;
        return originalRun(...runArgs);
      };
    }
    return stmt;
  },
);

let seq = 0;

/**
 * Ingests one synthetic outcome: for a 'failed' outcome, a raw
 * test_run_results row (listFlaggedFlakyTests' candidate-gathering join
 * still reads that table — see its own doc comment: any flaggable test must
 * have failed at least once, so scoping candidates off failure rows alone
 * stays correct), and — for every outcome, including 'passed' — a sample on
 * the test_perf_baselines digest, since computeTestFlipRateFlag (and the
 * flip-rate rollup's candidate scan) now read from there rather than raw
 * rows. createdAt doubles as the digest's caller-assigned sequenced-at value
 * (recordTestPerfDigestSample) so ordering in these fixtures stays exactly
 * what the test author wrote.
 */
function insertTestResult(opts: {
  projectId: string;
  testId: string;
  name: string;
  outcome: 'passed' | 'failed';
  createdAt: number;
}): void {
  seq += 1;
  const runId = `run-${seq}`;
  db.prepare(
    `INSERT INTO test_request_runs
       (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at)
     VALUES (@id, @project_id, @content_hash, NULL, 'passed', '', 0, 0, 0)`,
  ).run({
    id: runId,
    project_id: opts.projectId,
    content_hash: `hash-${seq}`,
  });
  if (opts.outcome === 'failed') {
    db.prepare(
      `INSERT INTO test_run_results
         (test_request_run_id, project_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
       VALUES (@run_id, @project_id, @test_id, @name, @outcome, 1, 0, 0, @created_at)`,
    ).run({
      run_id: runId,
      project_id: opts.projectId,
      test_id: opts.testId,
      name: opts.name,
      outcome: opts.outcome,
      created_at: opts.createdAt,
    });
  }
  recordTestPerfDigestSample(
    opts.testId,
    opts.projectId,
    opts.name,
    opts.outcome,
    1,
    0,
    false,
    opts.createdAt,
  );
}

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM flagged_flaky_tests_rollup').run();
  db.prepare('DELETE FROM flagged_flaky_tests_rollup_watermark').run();
  db.prepare('DELETE FROM test_perf_baselines').run();
  seq = 0;
  deleteCalls.count = 0;
});

describe('flagged_flaky_tests_rollup equivalence', () => {
  it('matches listFlaggedFlakyTests (the pre-optimization from-scratch computation) for a mixed fixture', () => {
    const outcomes: Array<'passed' | 'failed'> = [
      'passed',
      'failed',
      'passed',
      'failed',
    ];
    outcomes.forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-1',
        testId: 'test-flaky',
        name: 'suite > flaky test',
        outcome,
        createdAt: i,
      }),
    );
    ['passed', 'passed', 'passed', 'passed'].forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-1',
        testId: 'test-stable',
        name: 'suite > stable test',
        outcome: outcome as 'passed',
        createdAt: i,
      }),
    );

    const preOptimization = listFlaggedFlakyTests('proj-1', 20, 2);
    replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, 1000);
    const precomputed = getFlaggedFlakyTestsRollup('proj-1');

    expect(precomputed).toEqual(preOptimization);
    expect(precomputed).toEqual([
      {
        testId: 'test-flaky',
        name: 'suite > flaky test',
        sampleCount: 4,
        transitionCount: 3,
        remediationTaskOpen: false,
        remediationTaskId: null,
      },
    ]);
  });

  it("getLaneHealthRollup's flaky/regressed figures for a snapshot match what the pre-optimization implementation reported for the same snapshot", () => {
    const outcomes: Array<'passed' | 'failed'> = [
      'passed',
      'failed',
      'passed',
      'failed',
    ];
    outcomes.forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-1',
        testId: 'test-flaky',
        name: 'suite > flaky test',
        outcome,
        createdAt: i,
      }),
    );
    // The digest sample calls above (via insertTestResult) already created
    // test-flaky's test_perf_baselines row — update its median/mad/
    // is_regressed columns rather than INSERT, which would collide on the
    // test_id primary key.
    db.prepare(
      `UPDATE test_perf_baselines
       SET median_duration_ms = 100, mad_duration_ms = 10, sample_count = 5,
           last_duration_ms = 900, is_regressed = 1
       WHERE test_id = 'test-flaky'`,
    ).run();

    const preOptimizationFlaky = listFlaggedFlakyTests('proj-1', 20, 2);

    replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, 1000);
    const rollup = getLaneHealthRollup('proj-1', 500);

    expect(rollup.flakyTests.tests).toEqual(preOptimizationFlaky);
    expect(rollup.regressedTests).toEqual([
      {
        testId: 'test-flaky',
        name: 'suite > flaky test',
        medianDurationMs: 100,
        lastDurationMs: 900,
      },
    ]);
  });
});

describe('ghost pruning for renamed/retired tests', () => {
  it('removes a flagged rollup row once its test_perf_baselines row goes stale, without that test_id crossing the watermark again', () => {
    ['passed', 'failed', 'passed', 'failed'].forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-1',
        testId: 'test-renamed-old',
        name: 'suite > old name (before rename)',
        outcome: outcome as 'passed' | 'failed',
        createdAt: i,
      }),
    );
    replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, 1000);
    expect(getFlaggedFlakyTestsRollup('proj-1').map((t) => t.testId)).toEqual([
      'test-renamed-old',
    ]);

    // test-renamed-old never gets another sample again — it was renamed, so
    // recordTestPerfDigestSample now only ever touches the NEW test_id's
    // baseline row. Its own test_perf_baselines row is frozen at
    // updated_at=3, forever behind the watermark this first tick already
    // advanced past. A much-later tick — with no new candidates of its own —
    // must still prune it via staleness, not by re-visiting it through the
    // keyset scan.
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const laterComputedAt = 1000 + SEVEN_DAYS_MS + 1;
    replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, laterComputedAt);

    expect(getFlaggedFlakyTestsRollup('proj-1')).toEqual([]);
  });

  it('leaves a flagged rollup row alone when its test_perf_baselines row is still fresh', () => {
    // createdAt values sit on the same ms timescale as computedAt below
    // (unlike the tiny 0..3 offsets other fixtures use) so the staleness
    // window — measured from computedAt back FLAGGED_FLAKY_ROLLUP_GHOST_STALE_MS
    // — is actually exercised rather than trivially satisfied either way.
    const baseAt = 1_700_000_000_000;
    ['passed', 'failed', 'passed', 'failed'].forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-1',
        testId: 'test-still-flaky',
        name: 'suite > still flaky test',
        outcome: outcome as 'passed' | 'failed',
        createdAt: baseAt + i,
      }),
    );
    replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, baseAt + 1000);

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const soonComputedAt = baseAt + SEVEN_DAYS_MS - 1;
    replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, soonComputedAt);

    expect(getFlaggedFlakyTestsRollup('proj-1').map((t) => t.testId)).toEqual([
      'test-still-flaky',
    ]);
  });
});

describe('computeTestFlipRateFlag microsecond/millisecond unit normalization', () => {
  it('keeps both a live microsecond-stamped sample and a legacy millisecond-stamped sample inside a realistic epoch-ms cutoff window', () => {
    const nowMs = Date.now();
    // The live ingest path (ingestTestRunResultsTx's baseSequence = Date.now() * 1000)
    // stamps microseconds.
    recordTestPerfDigestSample(
      'test-mixed-units',
      'proj-1',
      'suite > mixed units',
      'passed',
      1,
      0,
      false,
      nowMs * 1000,
    );
    // The pre-cutover backfill stamped milliseconds.
    recordTestPerfDigestSample(
      'test-mixed-units',
      'proj-1',
      'suite > mixed units',
      'failed',
      1,
      0,
      false,
      nowMs - 60_000,
    );

    // A real caller-supplied cutoff — a PR's created_at — in epoch-milliseconds.
    const beforeMs = nowMs + 60_000;
    const flag = computeTestFlipRateFlag('test-mixed-units', 20, 2, beforeMs);

    expect(flag.sampleCount).toBe(2);
    expect(flag.transitionCount).toBe(1);
  });

  it('returns the same sampleCount/transitionCount with the default (no-filter) Number.MAX_SAFE_INTEGER cutoff as before normalization', () => {
    const nowMs = Date.now();
    (['passed', 'failed', 'passed'] as const).forEach((outcome, i) =>
      recordTestPerfDigestSample(
        'test-no-cutoff',
        'proj-1',
        'suite > no cutoff',
        outcome,
        1,
        0,
        false,
        nowMs * 1000 + i,
      ),
    );

    const flag = computeTestFlipRateFlag('test-no-cutoff', 20, 2);

    expect(flag.sampleCount).toBe(3);
    expect(flag.transitionCount).toBe(2);
  });
});

describe('pruneGhostFlaggedFlakyTests microsecond/millisecond unit normalization', () => {
  it('deletes a flagged rollup row whose test_perf_baselines updated_at (stored in production microsecond form) is older than the 7-day staleness window', () => {
    const nowMs = Date.now();
    const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
    const staleMicros = (nowMs - EIGHT_DAYS_MS) * 1000;

    ['passed', 'failed', 'passed', 'failed'].forEach((outcome, i) =>
      recordTestPerfDigestSample(
        'test-stale-micros',
        'proj-1',
        'suite > stale (microseconds)',
        outcome as 'passed' | 'failed',
        1,
        0,
        false,
        staleMicros + i,
      ),
    );
    // Flag it once, using a computedAt in the same era as the samples so the
    // flip-rate window itself isn't the thing filtering them out.
    replaceFlaggedFlakyTestsRollup(
      'proj-1',
      20,
      2,
      nowMs - EIGHT_DAYS_MS + 1000,
    );
    expect(getFlaggedFlakyTestsRollup('proj-1').map((t) => t.testId)).toEqual([
      'test-stale-micros',
    ]);

    // A present-day tick: the row's updated_at is well outside the 7-day
    // window measured from `nowMs`.
    replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, nowMs);

    expect(getFlaggedFlakyTestsRollup('proj-1')).toEqual([]);
  });

  it('leaves a flagged rollup row alone whose test_perf_baselines updated_at (production microsecond form) is inside the 7-day window', () => {
    const nowMs = Date.now();
    const freshMicros = (nowMs - 1000) * 1000;

    ['passed', 'failed', 'passed', 'failed'].forEach((outcome, i) =>
      recordTestPerfDigestSample(
        'test-fresh-micros',
        'proj-1',
        'suite > fresh (microseconds)',
        outcome as 'passed' | 'failed',
        1,
        0,
        false,
        freshMicros + i,
      ),
    );
    replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, nowMs);

    expect(getFlaggedFlakyTestsRollup('proj-1').map((t) => t.testId)).toEqual([
      'test-fresh-micros',
    ]);
  });
});

describe('conditional ghost-prune write (zero-work tick cost)', () => {
  it('issues no write against flagged_flaky_tests_rollup and still reports items_processed = 0 on a tick with no new candidates and nothing to prune', async () => {
    // Establish a stable baseline and let the watermark advance past it, so
    // the follow-up tick below has nothing new to examine.
    ['passed', 'passed', 'passed', 'passed'].forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-1',
        testId: 'test-stable',
        name: 'suite > stable test',
        outcome: outcome as 'passed',
        createdAt: i,
      }),
    );
    await replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, 1000);
    deleteCalls.count = 0;

    const result = await replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, 2000);

    expect(deleteCalls.count).toBe(0);
    expect(result).toEqual({ itemsProcessed: 0 });
  });

  it('still prunes a stale/ghost row even when there are zero new candidates that tick', async () => {
    ['passed', 'failed', 'passed', 'failed'].forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-1',
        testId: 'test-renamed-old',
        name: 'suite > old name (before rename)',
        outcome: outcome as 'passed' | 'failed',
        createdAt: i,
      }),
    );
    await replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, 1000);
    expect(getFlaggedFlakyTestsRollup('proj-1').map((t) => t.testId)).toEqual([
      'test-renamed-old',
    ]);
    deleteCalls.count = 0;

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const laterComputedAt = 1000 + SEVEN_DAYS_MS + 1;
    const result = await replaceFlaggedFlakyTestsRollup(
      'proj-1',
      20,
      2,
      laterComputedAt,
    );

    expect(deleteCalls.count).toBeGreaterThan(0);
    expect(result.itemsProcessed).toBeGreaterThan(0);
    expect(getFlaggedFlakyTestsRollup('proj-1')).toEqual([]);
  });

  it('handles the first-ever tick for a project with no watermark row without early-exiting or mistreating existing rows as ghosts', async () => {
    const outcomes: Array<'passed' | 'failed'> = [
      'passed',
      'failed',
      'passed',
      'failed',
    ];
    outcomes.forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-first-tick',
        testId: 'test-flaky',
        name: 'suite > flaky test',
        outcome,
        createdAt: i,
      }),
    );

    const preOptimization = listFlaggedFlakyTests('proj-first-tick', 20, 2);
    const result = await replaceFlaggedFlakyTestsRollup(
      'proj-first-tick',
      20,
      2,
      1000,
    );

    expect(result.itemsProcessed).toBeGreaterThan(0);
    expect(getFlaggedFlakyTestsRollup('proj-first-tick')).toEqual(
      preOptimization,
    );
  });

  it('recomputes and matches a from-scratch listFlaggedFlakyTests recomputation once the watermark has advanced', async () => {
    const outcomes: Array<'passed' | 'failed'> = [
      'passed',
      'failed',
      'passed',
      'failed',
    ];
    outcomes.forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-1',
        testId: 'test-flaky',
        name: 'suite > flaky test',
        outcome,
        createdAt: i,
      }),
    );
    await replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, 1000);

    // A second batch of results advances the watermark on a later tick.
    ['failed', 'passed', 'failed', 'passed'].forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-1',
        testId: 'test-flaky',
        name: 'suite > flaky test',
        outcome: outcome as 'passed' | 'failed',
        createdAt: 10 + i,
      }),
    );
    const preOptimization = listFlaggedFlakyTests('proj-1', 20, 2);
    await replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, 2000);

    const precomputed = getFlaggedFlakyTestsRollup('proj-1');
    expect(precomputed).toEqual(preOptimization);
    expect(precomputed[0]?.sampleCount).toBe(preOptimization[0]?.sampleCount);
    expect(precomputed[0]?.transitionCount).toBe(
      preOptimization[0]?.transitionCount,
    );
  });
});

describe('getFlaggedFlakyTestsRollup remediation-tracking join', () => {
  it('reports remediationTaskOpen/remediationTaskId for a tracked-open test and false/null for an untracked one', () => {
    ['passed', 'failed', 'passed', 'failed'].forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-1',
        testId: 'test-open',
        name: 'suite > open remediation test',
        outcome: outcome as 'passed' | 'failed',
        createdAt: i,
      }),
    );
    ['passed', 'failed', 'passed', 'failed'].forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-1',
        testId: 'test-untracked',
        name: 'suite > untracked flaky test',
        outcome: outcome as 'passed' | 'failed',
        createdAt: i,
      }),
    );
    replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, 1000);

    db.prepare(
      `INSERT INTO flaky_remediation_tracking
         (test_id, remediation_task_id, remediation_task_open, auto_disposition_count, created_at, updated_at)
       VALUES ('test-open', 'task-abc', 1, 1, '2024-01-01', '2024-01-01')`,
    ).run();

    const rollup = getFlaggedFlakyTestsRollup('proj-1').sort((a, b) =>
      a.testId.localeCompare(b.testId),
    );

    expect(rollup).toEqual([
      {
        testId: 'test-open',
        name: 'suite > open remediation test',
        sampleCount: 4,
        transitionCount: 3,
        remediationTaskOpen: true,
        remediationTaskId: 'task-abc',
      },
      {
        testId: 'test-untracked',
        name: 'suite > untracked flaky test',
        sampleCount: 4,
        transitionCount: 3,
        remediationTaskOpen: false,
        remediationTaskId: null,
      },
    ]);
  });

  it('reports remediationTaskOpen false for a test with a closed tracking row', () => {
    ['passed', 'failed', 'passed', 'failed'].forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-1',
        testId: 'test-closed',
        name: 'suite > closed remediation test',
        outcome: outcome as 'passed' | 'failed',
        createdAt: i,
      }),
    );
    replaceFlaggedFlakyTestsRollup('proj-1', 20, 2, 1000);

    db.prepare(
      `INSERT INTO flaky_remediation_tracking
         (test_id, remediation_task_id, remediation_task_open, auto_disposition_count, created_at, updated_at)
       VALUES ('test-closed', 'task-old', 0, 1, '2024-01-01', '2024-01-01')`,
    ).run();

    expect(getFlaggedFlakyTestsRollup('proj-1')).toEqual([
      {
        testId: 'test-closed',
        name: 'suite > closed remediation test',
        sampleCount: 4,
        transitionCount: 3,
        remediationTaskOpen: false,
        remediationTaskId: null,
      },
    ]);
  });
});

describe('lane-health request path', () => {
  it('reads flakyTests from the precomputed rollup, not recomputed live from test_run_results', () => {
    // Flaky pattern that WOULD be flagged if recomputed live from
    // test_run_results, but the rollup is never refreshed for it — proving
    // getLaneHealthRollup reads only the precomputed table.
    ['passed', 'failed', 'passed', 'failed'].forEach((outcome, i) =>
      insertTestResult({
        projectId: 'proj-1',
        testId: 'test-not-in-rollup',
        name: 'suite > flaky but unrolled',
        outcome: outcome as 'passed' | 'failed',
        createdAt: i,
      }),
    );
    expect(
      listFlaggedFlakyTests('proj-1', 20, 2).map((t) => t.testId),
    ).toContain('test-not-in-rollup');

    // Rollup stays empty for proj-1 (never refreshed).
    const rollup = getLaneHealthRollup('proj-1', 500);
    expect(rollup.flakyTests).toEqual({ count: 0, tests: [] });
  });

  it('resolves the rollup read by project_id using its primary-key index, not a table scan', () => {
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT test_id, name, sample_count, transition_count
           FROM flagged_flaky_tests_rollup
           WHERE project_id = ?
           ORDER BY test_id ASC`,
        )
        .all('proj-1') as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(plan).not.toMatch(/SCAN flagged_flaky_tests_rollup(?! USING)/);
  });
});
