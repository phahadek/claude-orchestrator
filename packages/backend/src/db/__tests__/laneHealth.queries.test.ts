/**
 * Tests for db/queries.ts's getLaneHealthRollup — the milestone view's
 * project-scoped lane-health rollup. The load-bearing assertion is that
 * queue-wait (started_at - requested_at) and execution-time
 * (finished_at - started_at) are computed as separate percentile
 * distributions across a mix of coalesced/queued/immediate runs, so a slow
 * suite (execution-time) can be told apart from a run starved behind a
 * concurrent peer (queue-wait).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  getLaneHealthRollup,
  replaceFlaggedFlakyTestsRollup,
  recordTestPerfDigestSample,
} from '../queries.js';

/** Plan text for a statement, joined so it can be asserted as a whole. */
function planFor(sql: string, params: Record<string, unknown>): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as {
      detail: string;
    }[]
  )
    .map((r) => r.detail)
    .join(' | ');
}

// The driving statement exactly as getLaneHealthRollup issues it.
const ROLLUP_SQL = `
  SELECT state, requested_at, started_at, finished_at, failure_reason
  FROM test_request_runs
  WHERE project_id = @project_id AND state != 'running'
  ORDER BY finished_at DESC, rowid DESC
  LIMIT @limit
`;

let seq = 0;

function insertRun(opts: {
  projectId: string;
  state: 'passed' | 'failed';
  requestedAt: number | null;
  startedAt: number;
  finishedAt: number;
  failureReason?: 'timeout' | 'oom_killed' | 'generic' | null;
}): void {
  seq += 1;
  db.prepare(
    `INSERT INTO test_request_runs
       (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at, failure_reason)
     VALUES (@id, @project_id, @content_hash, NULL, @state, '', @requested_at, @started_at, @finished_at, @failure_reason)`,
  ).run({
    id: `run-${seq}`,
    project_id: opts.projectId,
    content_hash: `hash-${seq}`,
    state: opts.state,
    requested_at: opts.requestedAt,
    started_at: opts.startedAt,
    finished_at: opts.finishedAt,
    failure_reason: opts.failureReason ?? null,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM flagged_flaky_tests_rollup').run();
  db.prepare('DELETE FROM flagged_flaky_tests_rollup_watermark').run();
  db.prepare('DELETE FROM test_perf_baselines').run();
  seq = 0;
});

describe('getLaneHealthRollup', () => {
  it('returns nulls and zero counts when the project has no finished runs', () => {
    expect(getLaneHealthRollup('proj-empty')).toEqual({
      project: 'proj-empty',
      totalRuns: 0,
      passRate: null,
      timeoutRate: null,
      queueWaitMs: { p50: null, p90: null, p99: null, sampleCount: 0 },
      executionTimeMs: { p50: null, p90: null, p99: null, sampleCount: 0 },
      regressedTests: [],
      flakyTests: { count: 0, tests: [] },
      cycleLimitCrossings: 0,
    });
  });

  it('excludes still-running runs from every aggregate', () => {
    db.prepare(
      `INSERT INTO test_request_runs
         (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at, failure_reason)
       VALUES ('running-1', 'proj-1', 'h', NULL, 'running', '', 1000, 1000, NULL, NULL)`,
    ).run();

    const result = getLaneHealthRollup('proj-1');
    expect(result.totalRuns).toBe(0);
  });

  it('separates queue-wait from execution-time percentiles across coalesced, queued, and immediate runs', () => {
    // Immediate run: no admission wait recorded (requested_at === started_at) — 100ms execution.
    insertRun({
      projectId: 'proj-1',
      state: 'passed',
      requestedAt: 0,
      startedAt: 0,
      finishedAt: 100,
    });
    // Queued run: waited 500ms behind the semaphore, then a fast 50ms execution.
    insertRun({
      projectId: 'proj-1',
      state: 'passed',
      requestedAt: 1000,
      startedAt: 1500,
      finishedAt: 1550,
    });
    // Another queued run: waited 900ms, 200ms execution, times out.
    insertRun({
      projectId: 'proj-1',
      state: 'failed',
      requestedAt: 2000,
      startedAt: 2900,
      finishedAt: 3100,
      failureReason: 'timeout',
    });
    // Coalesced run: rode along on an in-flight run, so it has no independent
    // requested_at of its own (pre-instrumentation / coalesced rows record
    // null) — must be excluded from queue-wait but still counted for
    // execution-time and pass/timeout rate.
    insertRun({
      projectId: 'proj-1',
      state: 'passed',
      requestedAt: null,
      startedAt: 5000,
      finishedAt: 5300,
    });

    const result = getLaneHealthRollup('proj-1');

    expect(result.totalRuns).toBe(4);
    expect(result.passRate).toBe(3 / 4);
    expect(result.timeoutRate).toBe(1 / 4);

    // queue-wait samples: 0, 500, 900 (the null-requested_at row excluded)
    expect(result.queueWaitMs.sampleCount).toBe(3);
    expect(result.queueWaitMs.p50).toBe(500);
    expect(result.queueWaitMs.p99).toBe(900);

    // execution-time samples: 100, 50, 200, 300 (all four rows included)
    expect(result.executionTimeMs.sampleCount).toBe(4);
    expect(result.executionTimeMs.p50).toBe(100);
    expect(result.executionTimeMs.p99).toBe(300);
  });

  it('scopes strictly by project', () => {
    insertRun({
      projectId: 'proj-a',
      state: 'passed',
      requestedAt: 0,
      startedAt: 0,
      finishedAt: 100,
    });
    insertRun({
      projectId: 'proj-b',
      state: 'failed',
      requestedAt: 0,
      startedAt: 0,
      finishedAt: 200,
      failureReason: 'generic',
    });

    const result = getLaneHealthRollup('proj-a');
    expect(result.totalRuns).toBe(1);
    expect(result.passRate).toBe(1);
  });

  it('bounds the window to the most recent `limit` finished runs', () => {
    for (let i = 0; i < 5; i++) {
      insertRun({
        projectId: 'proj-1',
        state: 'passed',
        requestedAt: i * 1000,
        startedAt: i * 1000,
        finishedAt: i * 1000 + 100,
      });
    }

    const result = getLaneHealthRollup('proj-1', 2);
    expect(result.totalRuns).toBe(2);
  });

  it('surfaces a regressed test scoped to the run it belongs to, and excludes non-regressed/other-project tests', () => {
    insertRun({
      projectId: 'proj-1',
      state: 'passed',
      requestedAt: 0,
      startedAt: 0,
      finishedAt: 100,
    });
    insertRun({
      projectId: 'proj-b',
      state: 'passed',
      requestedAt: 0,
      startedAt: 0,
      finishedAt: 100,
    });

    db.prepare(
      `INSERT INTO test_run_results
         (test_request_run_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
       VALUES ('run-1', 'test-a', 'suite > slow test', 'passed', 900, 0, 0, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO test_run_results
         (test_request_run_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
       VALUES ('run-1', 'test-b', 'suite > steady test', 'passed', 100, 0, 0, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO test_run_results
         (test_request_run_id, test_id, name, outcome, duration_ms, concurrent_run_count, oom_killed, created_at)
       VALUES ('run-2', 'test-c', 'other project regressed test', 'passed', 900, 0, 0, 1)`,
    ).run();

    db.prepare(
      `INSERT INTO test_perf_baselines
         (test_id, project_id, name, median_duration_ms, mad_duration_ms, sample_count, last_duration_ms, is_regressed, updated_at)
       VALUES ('test-a', 'proj-1', 'suite > slow test', 100, 10, 5, 900, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO test_perf_baselines
         (test_id, project_id, name, median_duration_ms, mad_duration_ms, sample_count, last_duration_ms, is_regressed, updated_at)
       VALUES ('test-b', 'proj-1', 'suite > steady test', 100, 10, 5, 100, 0, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO test_perf_baselines
         (test_id, project_id, name, median_duration_ms, mad_duration_ms, sample_count, last_duration_ms, is_regressed, updated_at)
       VALUES ('test-c', 'proj-b', 'other project regressed test', 100, 10, 5, 900, 1, 1)`,
    ).run();

    const result = getLaneHealthRollup('proj-1');
    expect(result.regressedTests).toEqual([
      {
        testId: 'test-a',
        name: 'suite > slow test',
        medianDurationMs: 100,
        lastDurationMs: 900,
      },
    ]);
  });

  describe('flakyTests', () => {
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
      // computeTestFlipRateFlag (behind replaceFlaggedFlakyTestsRollup) now
      // reads the test_perf_baselines digest rather than raw rows.
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

    // getLaneHealthRollup reads flakyTests off the precomputed
    // flagged_flaky_tests_rollup table rather than recomputing live — see
    // replaceFlaggedFlakyTestsRollup. Mirrors FlakyTestRollupJob's write.
    function refreshRollup(projectId: string): void {
      replaceFlaggedFlakyTestsRollup(projectId, 20, 2, 0);
    }

    it('includes a flagged test, with its name and flip stats, when its transition count meets the threshold', () => {
      const outcomes: Array<'passed' | 'failed'> = [
        'passed',
        'failed',
        'passed',
        'failed',
      ];
      outcomes.forEach((outcome, i) =>
        insertTestResult({
          projectId: 'proj-1',
          testId: 'test-a',
          name: 'suite > flaky test',
          outcome,
          createdAt: i,
        }),
      );

      refreshRollup('proj-1');
      const result = getLaneHealthRollup('proj-1', 500);
      expect(result.flakyTests.count).toBe(1);
      expect(result.flakyTests.tests).toEqual([
        {
          testId: 'test-a',
          name: 'suite > flaky test',
          sampleCount: 4,
          transitionCount: 3,
        },
      ]);
    });

    it('omits a test whose transition count is below the threshold', () => {
      const outcomes: Array<'passed' | 'failed'> = [
        'passed',
        'passed',
        'failed',
        'failed',
      ];
      outcomes.forEach((outcome, i) =>
        insertTestResult({
          projectId: 'proj-1',
          testId: 'test-b',
          name: 'suite > stable test',
          outcome,
          createdAt: i,
        }),
      );

      refreshRollup('proj-1');
      const result = getLaneHealthRollup('proj-1', 500);
      expect(result.flakyTests).toEqual({ count: 0, tests: [] });
    });

    it('scopes flagged tests strictly by project', () => {
      const outcomes: Array<'passed' | 'failed'> = [
        'passed',
        'failed',
        'passed',
        'failed',
      ];
      outcomes.forEach((outcome, i) =>
        insertTestResult({
          projectId: 'proj-other',
          testId: 'test-c',
          name: 'suite > other project test',
          outcome,
          createdAt: i,
        }),
      );

      refreshRollup('proj-other');
      refreshRollup('proj-1');
      const result = getLaneHealthRollup('proj-1', 500);
      expect(result.flakyTests).toEqual({ count: 0, tests: [] });
    });

    it('collapses a test_id into a single entry even when its recorded name varies across runs', () => {
      const outcomes: Array<'passed' | 'failed'> = [
        'passed',
        'failed',
        'passed',
        'failed',
      ];
      outcomes.forEach((outcome, i) =>
        insertTestResult({
          projectId: 'proj-1',
          testId: 'test-d',
          name: i < 2 ? 'suite > renamed test (old)' : 'suite > renamed test',
          outcome,
          createdAt: i,
        }),
      );

      refreshRollup('proj-1');
      const result = getLaneHealthRollup('proj-1', 500);
      expect(result.flakyTests.count).toBe(1);
      expect(result.flakyTests.tests).toEqual([
        {
          testId: 'test-d',
          name: 'suite > renamed test',
          sampleCount: 4,
          transitionCount: 3,
        },
      ]);
    });
  });

  describe('driving query plan', () => {
    it('is created by the schema', () => {
      const idx = db
        .prepare(`PRAGMA index_list(test_request_runs)`)
        .all() as { name: string }[];
      expect(idx.map((i) => i.name)).toContain(
        'idx_test_request_runs_project_finished',
      );
    });

    it('resolves the project-scoped rollup read via the new index, without a full-scan or a full-result sort', () => {
      const plan = planFor(ROLLUP_SQL, { project_id: 'proj-1', limit: 500 });
      expect(plan).toContain('idx_test_request_runs_project_finished');
      // A bare "SCAN test_request_runs" (no USING) is the regression this guards.
      expect(plan).not.toMatch(/SCAN test_request_runs(?! USING)/);
      // The old failure mode materialized every matching row into a temp
      // b-tree to sort the whole result set. The index leaves only a much
      // cheaper "LAST TERM" tiebreak sort for rows sharing an exact
      // finished_at, which this must not be confused with.
      expect(plan).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    });

    it('returns the same rows, in the same order — including the rowid tiebreaker for a shared finished_at — as the unindexed scan would', () => {
      insertRun({
        projectId: 'proj-1',
        state: 'passed',
        requestedAt: 0,
        startedAt: 0,
        finishedAt: 1000,
      });
      // Two runs finishing at the exact same instant: insertion (rowid)
      // order is the only thing that can make their relative order
      // deterministic, so the later-inserted row must sort first under
      // `ORDER BY finished_at DESC, rowid DESC`.
      insertRun({
        projectId: 'proj-1',
        state: 'passed',
        requestedAt: 500,
        startedAt: 500,
        finishedAt: 2000,
      });
      insertRun({
        projectId: 'proj-1',
        state: 'failed',
        requestedAt: 600,
        startedAt: 600,
        finishedAt: 2000,
        failureReason: 'generic',
      });
      insertRun({
        projectId: 'proj-1',
        state: 'passed',
        requestedAt: 100,
        startedAt: 100,
        finishedAt: 500,
      });

      const rows = db
        .prepare(ROLLUP_SQL)
        .all({ project_id: 'proj-1', limit: 500 }) as {
        finished_at: number;
        state: string;
      }[];

      expect(rows.map((r) => [r.finished_at, r.state])).toEqual([
        [2000, 'failed'], // run-3, inserted after run-2 — rowid DESC breaks the tie
        [2000, 'passed'], // run-2
        [1000, 'passed'], // run-1
        [500, 'passed'], // run-4
      ]);
    });

    it('still excludes running runs and honours the LIMIT with the new index in play', () => {
      db.prepare(
        `INSERT INTO test_request_runs
           (id, project_id, content_hash, session_id, state, output, requested_at, started_at, finished_at, failure_reason)
         VALUES ('running-x', 'proj-1', 'h', NULL, 'running', '', 1000, 1000, NULL, NULL)`,
      ).run();
      for (let i = 0; i < 5; i++) {
        insertRun({
          projectId: 'proj-1',
          state: 'passed',
          requestedAt: i * 1000,
          startedAt: i * 1000,
          finishedAt: i * 1000 + 100,
        });
      }

      const rows = db
        .prepare(ROLLUP_SQL)
        .all({ project_id: 'proj-1', limit: 2 }) as { state: string }[];

      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.state !== 'running')).toBe(true);
    });
  });
});
