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
} from '../queries.js';

let seq = 0;

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
}

beforeEach(() => {
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM flagged_flaky_tests_rollup').run();
  db.prepare('DELETE FROM test_perf_baselines').run();
  seq = 0;
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
    db.prepare(
      `INSERT INTO test_perf_baselines
         (test_id, median_duration_ms, mad_duration_ms, sample_count, last_duration_ms, is_regressed, updated_at)
       VALUES ('test-flaky', 100, 10, 5, 900, 1, 1)`,
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
