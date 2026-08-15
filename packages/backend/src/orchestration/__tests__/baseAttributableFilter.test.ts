/**
 * Tests for baseAttributableFilter.ts — filtering a session's failed
 * test.request run against the project's current base-branch health.
 *
 * AC:
 *  - a run whose only failures are confirmed base-attributable filters to
 *    a passing report.
 *  - a run with a mix of base-attributable and task-caused failures
 *    filters to only the task-caused ones.
 *  - a whole-process-crash base break (total_fail) reports the run as
 *    inconclusive, not a filtered pass.
 *  - a healthy or unknown base leaves the run's raw verdict untouched.
 *  - a confirmed-unhealthy base outcome triggers (best-effort) remediation
 *    filing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCheckBaseBranchHealth } = vi.hoisted(() => ({
  mockCheckBaseBranchHealth: vi.fn(),
}));
vi.mock('../baseHealthCheck', () => ({
  checkBaseBranchHealth: mockCheckBaseBranchHealth,
}));

const { mockGetFailingTestIdsForRun } = vi.hoisted(() => ({
  mockGetFailingTestIdsForRun: vi.fn(),
}));
vi.mock('../../db/queries', () => ({
  getFailingTestIdsForRun: mockGetFailingTestIdsForRun,
}));

const { mockRecordAndMaybeFileBaseHealthRemediation } = vi.hoisted(() => ({
  mockRecordAndMaybeFileBaseHealthRemediation: vi.fn(async () => ({
    filed: false,
  })),
}));
vi.mock('../../audit/baseHealthRemediationFiling', () => ({
  recordAndMaybeFileBaseHealthRemediation:
    mockRecordAndMaybeFileBaseHealthRemediation,
}));

import { filterBaseAttributableFailures } from '../baseAttributableFilter';
import type { ProjectConfig } from '../../config';
import type { TestRequestRunRow } from '../../db/types';

const PROJECT = { id: 'proj-1', projectDir: '/tmp/x' } as ProjectConfig;

function makeRun(overrides: Partial<TestRequestRunRow> = {}): TestRequestRunRow {
  return {
    id: 'run-session-1',
    project_id: 'proj-1',
    content_hash: 'session-hash',
    session_id: 'sess-1',
    state: 'failed',
    output: '',
    requested_at: null,
    started_at: 0,
    finished_at: null,
    structured_result: null,
    failure_reason: null,
    concurrent_run_count: null,
    oom_killed: 0,
    ...overrides,
  };
}

const BASE_RUN = makeRun({ id: 'run-base-1', content_hash: 'base-hash' });

beforeEach(() => {
  mockCheckBaseBranchHealth.mockReset();
  mockGetFailingTestIdsForRun.mockReset();
  mockRecordAndMaybeFileBaseHealthRemediation.mockReset();
  mockRecordAndMaybeFileBaseHealthRemediation.mockResolvedValue({
    filed: false,
  });
});

describe('filterBaseAttributableFailures', () => {
  it('reports a passing run when every failing test is also failing on the base tree', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({
      outcome: 'partial_fail',
      projectId: 'proj-1',
      contentHash: 'base-hash',
      cacheHit: true,
      run: BASE_RUN,
    });
    mockGetFailingTestIdsForRun.mockImplementation((runId: string) =>
      runId === 'run-session-1'
        ? [{ test_id: 'suite.testA', name: 'testA' }]
        : [{ test_id: 'suite.testA', name: 'testA' }],
    );

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(result.outcome).toBe('filtered_pass');
    expect(result.passed).toBe(true);
    expect(result.remainingTests).toEqual([]);
    expect(result.excludedTests).toEqual([
      { test_id: 'suite.testA', name: 'testA' },
    ]);
    expect(mockRecordAndMaybeFileBaseHealthRemediation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        contentHash: 'base-hash',
        outcome: 'partial_fail',
        triggeringTaskId: 'task-1',
      }),
    );
  });

  it('reports only the task-caused failures when some failures are base-attributable and some are not', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({
      outcome: 'partial_fail',
      projectId: 'proj-1',
      contentHash: 'base-hash',
      cacheHit: true,
      run: BASE_RUN,
    });
    mockGetFailingTestIdsForRun.mockImplementation((runId: string) =>
      runId === 'run-session-1'
        ? [
            { test_id: 'suite.testA', name: 'testA' },
            { test_id: 'suite.testB', name: 'testB' },
          ]
        : [{ test_id: 'suite.testA', name: 'testA' }],
    );

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(result.outcome).toBe('filtered_partial');
    expect(result.passed).toBe(false);
    expect(result.remainingTests).toEqual([
      { test_id: 'suite.testB', name: 'testB' },
    ]);
    expect(result.excludedTests).toEqual([
      { test_id: 'suite.testA', name: 'testA' },
    ]);
  });

  it('reports a whole-process-crash base break as inconclusive, not a filtered pass', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({
      outcome: 'total_fail',
      projectId: 'proj-1',
      contentHash: 'base-hash',
      cacheHit: true,
      run: makeRun({
        id: 'run-base-crash',
        content_hash: 'base-hash',
        structured_result: null,
      }),
    });

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(result.outcome).toBe('inconclusive');
    expect(result.passed).toBe(false);
    expect(mockRecordAndMaybeFileBaseHealthRemediation).toHaveBeenCalledWith(
      expect.objectContaining({
        contentHash: 'base-hash',
        outcome: 'total_fail',
      }),
    );
  });

  it('leaves the run unfiltered when the base is clean', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({
      outcome: 'clean_pass',
      projectId: 'proj-1',
      contentHash: 'base-hash',
      cacheHit: true,
      run: makeRun({ id: 'run-base-clean', state: 'passed' }),
    });

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(result.outcome).toBe('unfiltered');
    expect(result.passed).toBe(false);
    expect(mockRecordAndMaybeFileBaseHealthRemediation).not.toHaveBeenCalled();
  });

  it('leaves the run unfiltered when the base health check is unknown', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({
      outcome: 'unknown',
      projectId: 'proj-1',
      contentHash: null,
      cacheHit: false,
      run: null,
      unknownReason: 'no test commands configured',
    });

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(result.outcome).toBe('unfiltered');
    expect(mockRecordAndMaybeFileBaseHealthRemediation).not.toHaveBeenCalled();
  });

  it('leaves a passed run untouched without consulting base health', async () => {
    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun({ state: 'passed' }),
      'task-1',
    );

    expect(result.outcome).toBe('unfiltered');
    expect(result.passed).toBe(true);
    expect(mockCheckBaseBranchHealth).not.toHaveBeenCalled();
  });
});
