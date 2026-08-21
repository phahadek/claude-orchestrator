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

const { mockGetFailingTestIdsForRun, mockGetFlaggedFlakyTestIds } = vi.hoisted(
  () => ({
    mockGetFailingTestIdsForRun: vi.fn(),
    mockGetFlaggedFlakyTestIds: vi.fn(() => new Set<string>()),
  }),
);
vi.mock('../../db/queries', () => ({
  getFailingTestIdsForRun: mockGetFailingTestIdsForRun,
  getFlaggedFlakyTestIds: mockGetFlaggedFlakyTestIds,
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

import {
  filterBaseAttributableFailures,
  renderBaseAttributableFilterDigest,
} from '../baseAttributableFilter';
import type { ProjectConfig } from '../../config';
import type { TestRequestRunRow } from '../../db/types';

const PROJECT = { id: 'proj-1', projectDir: '/tmp/x' } as ProjectConfig;

function makeRun(
  overrides: Partial<TestRequestRunRow> = {},
): TestRequestRunRow {
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
  mockGetFlaggedFlakyTestIds.mockReset();
  mockGetFlaggedFlakyTestIds.mockReturnValue(new Set<string>());
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
    expect(result.flakyExcludedTests).toEqual([]);
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
    expect(result.flakyExcludedTests).toEqual([]);
  });

  it('excludes a failure flagged flaky for this project from remainingTests, even when it does not fail on base', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({
      outcome: 'partial_fail',
      projectId: 'proj-1',
      contentHash: 'base-hash',
      cacheHit: true,
      run: BASE_RUN,
    });
    mockGetFailingTestIdsForRun.mockImplementation((runId: string) =>
      runId === 'run-session-1'
        ? [{ test_id: 'suite.flakyTest', name: 'flakyTest' }]
        : [],
    );
    mockGetFlaggedFlakyTestIds.mockReturnValue(new Set(['suite.flakyTest']));

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(result.outcome).toBe('filtered_pass');
    expect(result.passed).toBe(true);
    expect(result.remainingTests).toEqual([]);
    expect(result.flakyExcludedTests).toEqual([
      { test_id: 'suite.flakyTest', name: 'flakyTest' },
    ]);
  });

  it('still charges a non-flagged failure that does not fail on base', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({
      outcome: 'partial_fail',
      projectId: 'proj-1',
      contentHash: 'base-hash',
      cacheHit: true,
      run: BASE_RUN,
    });
    mockGetFailingTestIdsForRun.mockImplementation((runId: string) =>
      runId === 'run-session-1'
        ? [{ test_id: 'suite.testC', name: 'testC' }]
        : [],
    );
    mockGetFlaggedFlakyTestIds.mockReturnValue(new Set(['suite.otherTest']));

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(result.outcome).toBe('filtered_partial');
    expect(result.passed).toBe(false);
    expect(result.remainingTests).toEqual([
      { test_id: 'suite.testC', name: 'testC' },
    ]);
    expect(result.flakyExcludedTests).toEqual([]);
  });

  it('scopes flaky exclusion per project — a test flagged for a different project is not excluded here', async () => {
    mockCheckBaseBranchHealth.mockResolvedValue({
      outcome: 'partial_fail',
      projectId: 'proj-1',
      contentHash: 'base-hash',
      cacheHit: true,
      run: BASE_RUN,
    });
    mockGetFailingTestIdsForRun.mockImplementation((runId: string) =>
      runId === 'run-session-1'
        ? [{ test_id: 'suite.flakyTest', name: 'flakyTest' }]
        : [],
    );
    // getFlaggedFlakyTestIds is called with project.id — simulate it being
    // scoped by only returning the flagged set for a different project.
    mockGetFlaggedFlakyTestIds.mockImplementation((projectId: string) =>
      projectId === 'proj-2' ? new Set(['suite.flakyTest']) : new Set(),
    );

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(mockGetFlaggedFlakyTestIds).toHaveBeenCalledWith('proj-1');
    expect(result.outcome).toBe('filtered_partial');
    expect(result.remainingTests).toEqual([
      { test_id: 'suite.flakyTest', name: 'flakyTest' },
    ]);
    expect(result.flakyExcludedTests).toEqual([]);
  });

  it('reports filtered_pass with passed:true when all remaining failures are flaky-excluded alongside base-attributed ones', async () => {
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
            { test_id: 'suite.flakyTest', name: 'flakyTest' },
          ]
        : [{ test_id: 'suite.testA', name: 'testA' }],
    );
    mockGetFlaggedFlakyTestIds.mockReturnValue(new Set(['suite.flakyTest']));

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
    expect(result.flakyExcludedTests).toEqual([
      { test_id: 'suite.flakyTest', name: 'flakyTest' },
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

  it('skips remediation filing for a partial_fail base outcome whose failing-test evidence is empty', async () => {
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
        : [],
    );

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    // Filtering itself is unaffected — only remediation filing is skipped
    // for the zero-evidence base outcome.
    expect(result.outcome).toBe('filtered_partial');
    expect(mockRecordAndMaybeFileBaseHealthRemediation).not.toHaveBeenCalled();
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

  it('reports a distinct unknown outcome — not unfiltered — when no usable base-health probe exists', async () => {
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

    expect(result.outcome).toBe('unknown');
    expect(result.outcome).not.toBe('unfiltered');
    expect(result.passed).toBe(false);
    expect(result.remainingTests).toEqual([]);
    expect(mockRecordAndMaybeFileBaseHealthRemediation).not.toHaveBeenCalled();
  });

  it('reproduces the observed regression shape: a session-failing set identical to the base tree\'s, with no usable probe for the current base hash, is not reported as an unattributed self-inflicted failure', async () => {
    // The base content hash moved (a merge landed seconds after the last
    // successful probe) and no fresh probe has resolved for it yet.
    mockCheckBaseBranchHealth.mockResolvedValue({
      outcome: 'unknown',
      projectId: 'proj-1',
      contentHash: null,
      cacheHit: false,
      run: null,
      unknownReason: 'worktree provisioning failed',
    });
    // The session's own run failed 8 tests — irrelevant to the outcome,
    // since no base breakdown exists to compare against at all.
    mockGetFailingTestIdsForRun.mockReturnValue(
      Array.from({ length: 8 }, (_, i) => ({
        test_id: `suite.test${i}`,
        name: `test${i}`,
      })),
    );

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(result.outcome).toBe('unknown');
    expect(result.outcome).not.toBe('unfiltered');
    expect(result.passed).toBe(false);

    const digest = renderBaseAttributableFilterDigest(result);
    expect(digest).toMatch(/base health.*unavailable/i);
    expect(digest).toMatch(/cannot be attributed to your/i);
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

describe('renderBaseAttributableFilterDigest', () => {
  it('distinguishes base-attributed exclusions from flaky exclusions in the filtered_pass digest', () => {
    const digest = renderBaseAttributableFilterDigest({
      outcome: 'filtered_pass',
      passed: true,
      excludedTests: [{ test_id: 'suite.testA', name: 'testA' }],
      flakyExcludedTests: [{ test_id: 'suite.flakyTest', name: 'flakyTest' }],
      remainingTests: [],
    });

    expect(digest).toContain('1 failing test(s) excluded');
    expect(digest).toContain('1 excluded as known-flaky');
  });

  it('distinguishes base-attributed exclusions from flaky exclusions in the filtered_partial digest', () => {
    const digest = renderBaseAttributableFilterDigest({
      outcome: 'filtered_partial',
      passed: false,
      excludedTests: [{ test_id: 'suite.testA', name: 'testA' }],
      flakyExcludedTests: [{ test_id: 'suite.flakyTest', name: 'flakyTest' }],
      remainingTests: [{ test_id: 'suite.testC', name: 'testC' }],
    });

    expect(digest).toContain(
      '1 additional failure(s) excluded as confirmed base-branch breaks',
    );
    expect(digest).toContain('1 excluded as known-flaky');
  });

  it('states base health was unavailable and does not attribute the failure to the session for the unknown outcome', () => {
    const digest = renderBaseAttributableFilterDigest({
      outcome: 'unknown',
      passed: false,
      excludedTests: [],
      flakyExcludedTests: [],
      remainingTests: [],
    });

    expect(digest).toMatch(/base health.*unavailable/i);
    expect(digest).toMatch(/cannot be attributed to your/i);
    expect(digest).toContain('Not counted against your test-request budget');
  });
});
