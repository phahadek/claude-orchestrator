/**
 * Tests for the on-demand base-branch health check:
 * - Extrapolation-only lookup against test_request_runs, keyed by the
 *   attributed commit's own content hash — never a fresh probe launch.
 * - Merge-base resolution against a supplied reference (sha or worktree
 *   path), vs. the base-tip degenerate case when no reference is supplied.
 * - The four distinguishable outcomes (clean_pass / partial_fail /
 *   total_fail / unknown).
 * - Worktree namespacing distinct from ScheduledAuditSweep's own checkout.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const { mockGitRunner } = vi.hoisted(() => ({
  mockGitRunner: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));

const { mockComputeWholeTreeContentHash } = vi.hoisted(() => ({
  mockComputeWholeTreeContentHash: vi.fn(),
}));

vi.mock('../../session/analyzeGating.js', () => ({
  computeWholeTreeContentHash: mockComputeWholeTreeContentHash,
}));

import { db } from '../../db/db';
import {
  checkBaseBranchHealth,
  classifyTestRunOutcome,
  classifyRun,
} from '../baseHealthCheck';
import {
  insertTestRequestRun,
  completeTestRequestRun,
  ingestTestRunResultsTx,
  clearExtractedStructuredResultsBatch,
  getTestRequestRunById,
} from '../../db/queries';
import { typedSetSetting } from '../../config/settings';
import type { ProjectConfig } from '../../config';
import type { TestRequestRunRow } from '../../db/types';

/** Writes a test_run_summaries row directly — insertTestRunSummary itself is db/queries.ts-private. */
function insertSummaryRow(
  runId: string,
  projectId: string,
  totalCount: number,
  failedCount: number,
  incomplete = false,
): void {
  db.prepare(
    `INSERT INTO test_run_summaries
       (test_request_run_id, project_id, passed_count, failed_count, skipped_count, error_count, other_count, total_count, total_duration_ms, concurrent_run_count, oom_killed, incomplete, created_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?, 1000, NULL, 0, ?, ?)`,
  ).run(
    runId,
    projectId,
    totalCount - failedCount,
    failedCount,
    totalCount,
    incomplete ? 1 : 0,
    Date.now(),
  );
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Project One',
    projectDir: '/tmp/fake-project-dir',
    contextUrl: 'https://example.com',
    boardId: 'board-1',
    taskSource: 'notion',
    gitMode: 'github',
    autoLaunchEnabled: false,
    autoLaunchMilestoneId: null,
    autoMergeEnabled: false,
    dataResidencyConfirmed: true,
    baseBranch: 'dev',
    nonMilestoneSourceConfig: { notionDatabaseId: 'db-nonmilestone' },
    ...overrides,
  } as ProjectConfig;
}

function structuredResultWith(passed: number, failed: number): string {
  return JSON.stringify({
    format: 'junit-xml',
    suites: [],
    totals: { passed, failed, skipped: 0, errors: 0 },
    durationMsTotal: 1000,
  });
}

beforeEach(() => {
  mockGitRunner.mockReset();
  mockGitRunner.mockResolvedValue({ stdout: '', stderr: '' });
  mockComputeWholeTreeContentHash.mockReset();
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_run_summaries').run();
  db.prepare('DELETE FROM test_request_runs').run();
});

describe('checkBaseBranchHealth', () => {
  it('extrapolates clean_pass from an existing test_request_runs row matching the base tip content hash — no reference supplied', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-clean');
    insertTestRequestRun(
      'run-clean',
      project.id,
      'hash-clean',
      null,
      Date.now(),
      undefined,
      'pr_pipeline',
    );
    completeTestRequestRun('run-clean', 'passed', '');

    const result = await checkBaseBranchHealth(project, undefined, {
      gitRunner: mockGitRunner,
    });
    expect(result.outcome).toBe('clean_pass');
    expect(result.run?.id).toBe('run-clean');
    expect(result.cacheHit).toBe(true);
  });

  it('extrapolates from any producer/run_origin — not just base_health_probe rows', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-any-origin');
    insertTestRequestRun(
      'run-session-attributed',
      project.id,
      'hash-any-origin',
      'some-session-id',
      Date.now(),
    );
    completeTestRequestRun('run-session-attributed', 'passed', '');

    const result = await checkBaseBranchHealth(project, undefined, {
      gitRunner: mockGitRunner,
    });
    expect(result.outcome).toBe('clean_pass');
    expect(result.run?.id).toBe('run-session-attributed');
  });

  it('never launches a fresh probe — an unmatched content hash resolves to unknown', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-no-existing-row');

    const result = await checkBaseBranchHealth(project, undefined, {
      gitRunner: mockGitRunner,
    });
    expect(result.outcome).toBe('unknown');
    expect(result.run).toBeNull();
    // No git command beyond fetch/worktree provisioning ever runs a test.
    expect(mockGitRunner.mock.calls.some(([args]) => args[0] === 'test')).toBe(
      false,
    );
  });

  it('resolves the merge-base commit against a supplied sha reference and keys the lookup on it, not the base tip', async () => {
    const project = makeProject();
    mockGitRunner.mockImplementation(async (args: string[]) => {
      if (args[0] === 'merge-base') {
        return { stdout: 'merge-base-sha\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-merge-base');
    insertTestRequestRun(
      'run-merge-base',
      project.id,
      'hash-merge-base',
      null,
      Date.now(),
    );
    completeTestRequestRun('run-merge-base', 'passed', '');

    const result = await checkBaseBranchHealth(project, 'session-head-sha', {
      gitRunner: mockGitRunner,
    });

    expect(result.outcome).toBe('clean_pass');
    expect(
      mockGitRunner.mock.calls.some(
        ([args]) =>
          args[0] === 'merge-base' && args.includes('session-head-sha'),
      ),
    ).toBe(true);
    expect(
      mockGitRunner.mock.calls.some(
        ([args]) => args[0] === 'worktree' && args.includes('merge-base-sha'),
      ),
    ).toBe(true);
  });

  it('returns unknown when merge-base resolution fails for a supplied reference', async () => {
    const project = makeProject();
    mockGitRunner.mockImplementation(async (args: string[]) => {
      if (args[0] === 'merge-base') {
        throw new Error('no merge base');
      }
      return { stdout: '', stderr: '' };
    });

    const result = await checkBaseBranchHealth(project, 'session-head-sha', {
      gitRunner: mockGitRunner,
    });
    expect(result.outcome).toBe('unknown');
    expect(result.run).toBeNull();
  });

  it('caches the resolved merge-base commit for a reference across repeated calls (does not re-invoke git merge-base)', async () => {
    const project = makeProject();
    let mergeBaseCalls = 0;
    mockGitRunner.mockImplementation(async (args: string[]) => {
      if (args[0] === 'merge-base') {
        mergeBaseCalls++;
        return { stdout: 'merge-base-sha-cached\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-cached-mb');
    insertTestRequestRun(
      'run-cached-mb',
      project.id,
      'hash-cached-mb',
      null,
      Date.now(),
    );
    completeTestRequestRun('run-cached-mb', 'passed', '');

    await checkBaseBranchHealth(project, 'repeat-reference', {
      gitRunner: mockGitRunner,
    });
    await checkBaseBranchHealth(project, 'repeat-reference', {
      gitRunner: mockGitRunner,
    });

    expect(mergeBaseCalls).toBe(1);
  });

  it('returns unknown when the content hash cannot be computed (empty tree)', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue(null);

    const result = await checkBaseBranchHealth(project, undefined, {
      gitRunner: mockGitRunner,
    });
    expect(result.outcome).toBe('unknown');
  });

  it('returns unknown, distinct from total_fail, when worktree provisioning fails', async () => {
    const project = makeProject();
    mockGitRunner.mockImplementation(async (args: string[]) => {
      if (args[0] === 'worktree') {
        throw new Error('git worktree add failed');
      }
      return { stdout: '', stderr: '' };
    });

    const result = await checkBaseBranchHealth(project, undefined, {
      gitRunner: mockGitRunner,
    });
    expect(result.outcome).toBe('unknown');
    expect(result.run).toBeNull();
  });

  it('classifies a failed run with a per-test breakdown as partial_fail', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-partial');
    insertTestRequestRun(
      'run-partial',
      project.id,
      'hash-partial',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-partial',
      'failed',
      'some tests failed',
      'generic',
      structuredResultWith(18, 2),
      false,
    );

    const result = await checkBaseBranchHealth(project, undefined, {
      gitRunner: mockGitRunner,
    });
    expect(result.outcome).toBe('partial_fail');
  });

  it('classifies an OOM-killed run (no per-test breakdown) as unknown, not total_fail — an OOM-kill is the orchestrator resource limit, not a base-tree signal', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-total');
    insertTestRequestRun(
      'run-total',
      project.id,
      'hash-total',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-total',
      'failed',
      'killed',
      'oom_killed',
      null,
      true,
      true,
    );

    const result = await checkBaseBranchHealth(project, undefined, {
      gitRunner: mockGitRunner,
    });
    expect(result.outcome).toBe('unknown');
  });

  it('classifies a run killed at the configured test-timeout budget (failure_reason=timeout, no summary row, no structured_result) as unknown, not total_fail', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-timeout');
    insertTestRequestRun(
      'run-timeout',
      project.id,
      'hash-timeout',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-timeout',
      'failed',
      'timed out',
      'timeout',
      null,
      false,
      true,
    );

    const result = await checkBaseBranchHealth(project, undefined, {
      gitRunner: mockGitRunner,
    });
    expect(result.outcome).toBe('unknown');
    expect(classifyTestRunOutcome(result.run!).outcome).toBe('timed-out');
  });

  it('classifies a failed run with structured_result nulled but extraction output (test_run_summaries) present as partial_fail, not total_fail', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-post-sweep');
    insertTestRequestRun(
      'run-post-sweep',
      project.id,
      'hash-post-sweep',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-post-sweep',
      'failed',
      'some tests failed',
      'generic',
      structuredResultWith(18, 2),
      false,
      true,
    );
    ingestTestRunResultsTx(
      'run-post-sweep',
      project.id,
      [
        { test_id: 'suite.a', name: 'a', outcome: 'failed', duration_ms: 10 },
        { test_id: 'suite.b', name: 'b', outcome: 'failed', duration_ms: 10 },
      ],
      null,
      false,
      false,
    );
    clearExtractedStructuredResultsBatch();

    const result = await checkBaseBranchHealth(project, undefined, {
      gitRunner: mockGitRunner,
    });
    expect(result.run?.structured_result).toBeNull();
    expect(result.outcome).toBe('partial_fail');
  });

  it('classifies a failed run with no structured_result and no extraction output as total_fail when acquisition was attempted (genuine crash case — failure_reason neither timeout nor OOM)', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-crash');
    insertTestRequestRun(
      'run-crash',
      project.id,
      'hash-crash',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-crash',
      'failed',
      'killed',
      'generic',
      null,
      false,
      true,
    );

    const result = await checkBaseBranchHealth(project, undefined, {
      gitRunner: mockGitRunner,
    });
    expect(result.outcome).toBe('total_fail');
  });

  it('classifies a failed run whose extraction output records an incomplete/missing-suite merge as total_fail', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-incomplete');
    insertTestRequestRun(
      'run-incomplete',
      project.id,
      'hash-incomplete',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-incomplete',
      'failed',
      'partial merge, one report missing',
      'generic',
      JSON.stringify({
        format: 'junit-xml',
        suites: [],
        totals: { passed: 5, failed: 1, skipped: 0, errors: 0 },
        durationMsTotal: 1000,
        incomplete: true,
      }),
      false,
      true,
    );
    ingestTestRunResultsTx(
      'run-incomplete',
      project.id,
      [
        {
          test_id: 'suite.recovered',
          name: 'recovered',
          outcome: 'failed',
          duration_ms: 10,
        },
      ],
      null,
      false,
      true,
    );
    clearExtractedStructuredResultsBatch();

    const result = await checkBaseBranchHealth(project, undefined, {
      gitRunner: mockGitRunner,
    });
    expect(result.outcome).toBe('total_fail');
  });

  it('records the missing/stale-report case (a fresh-cleanup run whose report was excluded as stale/never-written) with the distinct "no report acquired" outcome, not conflated with a genuine OOM/timeout crash', () => {
    const staleReportRun: TestRequestRunRow = {
      id: 'run-stale-excluded',
      project_id: 'proj-1',
      content_hash: 'hash-stale',
      session_id: null,
      state: 'failed',
      output: 'command failed before writing a fresh report',
      requested_at: null,
      started_at: 0,
      finished_at: null,
      structured_result: JSON.stringify({
        format: 'junit-xml',
        suites: [],
        totals: { passed: 0, failed: 0, skipped: 0, errors: 0 },
        durationMsTotal: 0,
        incomplete: true,
      }),
      failure_reason: 'generic',
      concurrent_run_count: null,
      oom_killed: 0,
      test_report_acquisition_attempted: 1,
      run_origin: null,
    } as TestRequestRunRow;

    const { outcome } = classifyTestRunOutcome(staleReportRun);

    expect(outcome).toBe('failed-with-no-report-acquired');
    expect(outcome).not.toBe('crashed-oom');
    expect(outcome).not.toBe('timed-out');
  });

  it('classifies a boot-swept interrupted_queued row identically to an execution_failed row — same outcome and nextAction', () => {
    const base: TestRequestRunRow = {
      id: 'run-interrupted',
      project_id: 'proj-1',
      content_hash: 'hash-interrupted',
      session_id: null,
      state: 'failed',
      output:
        '[testRequestLane] backend restarted while queued — run never began executing',
      requested_at: null,
      started_at: 0,
      finished_at: null,
      structured_result: null,
      failure_reason: 'interrupted_queued',
      concurrent_run_count: null,
      oom_killed: 0,
      test_report_acquisition_attempted: null,
      run_origin: null,
    } as TestRequestRunRow;
    const executionFailed: TestRequestRunRow = {
      ...base,
      id: 'run-execution-failed',
      failure_reason: 'execution_failed',
    };

    const interruptedQueuedResult = classifyTestRunOutcome(base);
    const executionFailedResult = classifyTestRunOutcome(executionFailed);

    expect(interruptedQueuedResult.outcome).toBe('execution-failed');
    expect(interruptedQueuedResult).toEqual(executionFailedResult);
  });

  it('classifies a queued row (durably recorded at admission, before its permit is acquired) as "queued"', () => {
    const queuedRun: TestRequestRunRow = {
      id: 'run-queued',
      project_id: 'proj-1',
      content_hash: 'hash-queued',
      session_id: 'session-1',
      state: 'queued',
      output: '',
      requested_at: 1000,
      started_at: 1000,
      finished_at: null,
      structured_result: null,
      failure_reason: null,
      concurrent_run_count: null,
      oom_killed: 0,
      test_report_acquisition_attempted: null,
      run_origin: null,
      producer: 'session_request',
    } as TestRequestRunRow;

    const { outcome } = classifyTestRunOutcome(queuedRun);
    expect(outcome).toBe('queued');
  });

  it('classifies a failed run whose acquisition was never attempted as partial_fail, not total_fail', async () => {
    const project = makeProject();
    mockComputeWholeTreeContentHash.mockResolvedValue('hash-unattempted');
    insertTestRequestRun(
      'run-unattempted',
      project.id,
      'hash-unattempted',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-unattempted',
      'failed',
      'some tests failed',
      'generic',
      null,
      false,
      false,
    );

    const result = await checkBaseBranchHealth(project, undefined, {
      gitRunner: mockGitRunner,
    });
    expect(result.outcome).toBe('partial_fail');
  });
});

describe('classifyRun suite-size floor', () => {
  const projectId = 'proj-1';

  function seedBaseline(totalCounts: number[]): void {
    totalCounts.forEach((totalCount, i) => {
      const runId = `run-baseline-${i}`;
      insertTestRequestRun(
        runId,
        projectId,
        `hash-baseline-${i}`,
        null,
        Date.now(),
        undefined,
        'base_health_probe',
      );
      completeTestRequestRun(runId, 'passed', '');
      insertSummaryRow(runId, projectId, totalCount, 0);
    });
  }

  /** Persists the row under test itself (the FK from test_run_summaries requires it) and returns it. */
  function seedFailedRun(
    runId: string,
    overrides: Partial<TestRequestRunRow> = {},
  ): TestRequestRunRow {
    insertTestRequestRun(
      runId,
      projectId,
      `hash-${runId}`,
      null,
      Date.now(),
      undefined,
      'base_health_probe',
    );
    completeTestRequestRun(
      runId,
      'failed',
      '',
      overrides.failure_reason ?? 'generic',
      null,
      Boolean(overrides.oom_killed),
      overrides.test_report_acquisition_attempted !== 0,
    );
    return getTestRequestRunById(runId) as TestRequestRunRow;
  }

  it('classifies unknown when total_count falls below the configured fraction of the established baseline (be735798 shape: 6446 vs 11030)', () => {
    typedSetSetting('base_health_suite_size_floor_fraction', 0.8);
    seedBaseline([11007, 11030, 11032, 11046]);

    const run = seedFailedRun('run-truncated');
    insertSummaryRow(run.id, projectId, 6446, 368);

    expect(classifyRun(run)).toBe('unknown');
  });

  it('still classifies partial_fail when total_count is at or above the floor (75b97376 shape: 11046 total, 4 failed)', () => {
    typedSetSetting('base_health_suite_size_floor_fraction', 0.8);
    seedBaseline([11007, 11030, 11032, 11046]);

    const run = seedFailedRun('run-full');
    insertSummaryRow(run.id, projectId, 11046, 4);

    expect(classifyRun(run)).toBe('partial_fail');
  });

  it('classifies exactly as it does today (partial_fail) when no baseline can be established', () => {
    typedSetSetting('base_health_suite_size_floor_fraction', 0.8);
    // No prior base_health_probe runs seeded — baseline is unknown.

    const run = seedFailedRun('run-no-baseline');
    insertSummaryRow(run.id, projectId, 50, 3);

    expect(classifyRun(run)).toBe('partial_fail');
  });

  it('keeps unknown and total_fail as distinct outcomes', () => {
    typedSetSetting('base_health_suite_size_floor_fraction', 0.8);
    seedBaseline([11007, 11030, 11032, 11046]);

    const truncated = seedFailedRun('run-truncated-2');
    insertSummaryRow(truncated.id, projectId, 6446, 368);
    expect(classifyRun(truncated)).toBe('unknown');

    // No summary row and no structured_result at all — a genuine crash.
    const crashed = seedFailedRun('run-crashed');
    expect(classifyRun(crashed)).toBe('total_fail');
    expect(classifyRun(truncated)).not.toBe(classifyRun(crashed));
  });

  it('classifies an interrupted_queued run identically to an execution_failed run — a restart-swept queued row does not route into total_fail remediation filing any differently than the existing execution_failed sweep does', () => {
    const executionFailed = seedFailedRun('run-execution-failed', {
      failure_reason: 'execution_failed',
    });
    const interruptedQueued = seedFailedRun('run-interrupted-queued', {
      failure_reason: 'interrupted_queued',
    });

    expect(classifyRun(interruptedQueued)).toBe(classifyRun(executionFailed));
  });
});
