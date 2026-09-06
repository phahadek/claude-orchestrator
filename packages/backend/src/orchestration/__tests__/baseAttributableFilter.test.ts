/**
 * Tests for baseAttributableFilter.ts — filtering a session's failed
 * test.request run against the cross-SHA failure-breadth corpus
 * (db/queries.ts's computeTestFailureBreadthFlag), per test, rather than a
 * whole-tree base-health content-hash match.
 *
 * AC:
 *  - a run whose only failures are breadth-flagged (>= flip_rate_breadth_n
 *    distinct content hashes) filters to a passing report.
 *  - a run with a mix of breadth-flagged and not-breadth-flagged failures
 *    filters to only the not-flagged ones.
 *  - the breadth lookup uses the run's own session's first-run timestamp as
 *    the cutoff, so a PR's own repeated runs (sharing that session) never
 *    inflate its own breadth count.
 *  - no remediation task is filed from this path.
 *  - baseAttributableFilter.ts no longer imports checkBaseBranchHealth or
 *    matches on whole-tree content hash.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const {
  mockGetFailingTestIdsForRun,
  mockGetFlaggedFlakyTestIds,
  mockListTestRequestRunsForSession,
  mockComputeTestFailureBreadthFlag,
} = vi.hoisted(() => ({
  mockGetFailingTestIdsForRun: vi.fn(),
  mockGetFlaggedFlakyTestIds: vi.fn(() => new Set<string>()),
  mockListTestRequestRunsForSession: vi.fn(() => []),
  mockComputeTestFailureBreadthFlag: vi.fn(),
}));
vi.mock('../../db/queries', () => ({
  getFailingTestIdsForRun: mockGetFailingTestIdsForRun,
  getFlaggedFlakyTestIds: mockGetFlaggedFlakyTestIds,
  listTestRequestRunsForSession: mockListTestRequestRunsForSession,
  computeTestFailureBreadthFlag: mockComputeTestFailureBreadthFlag,
}));

const { mockTypedGetSetting } = vi.hoisted(() => ({
  mockTypedGetSetting: vi.fn((key: string) => {
    if (key === 'flip_rate_breadth_n') return 3;
    if (key === 'flip_rate_breadth_window_hours') return 24;
    throw new Error(`unexpected setting ${key}`);
  }),
}));
vi.mock('../../config/settings', () => ({
  typedGetSetting: mockTypedGetSetting,
}));

const { mockIsTestIdTouchedByChangedFiles } = vi.hoisted(() => ({
  mockIsTestIdTouchedByChangedFiles: vi.fn(() => ({
    touched: false,
    confident: true,
  })),
}));
vi.mock('../../session/test-runner', () => ({
  isTestIdTouchedByChangedFiles: mockIsTestIdTouchedByChangedFiles,
}));

import {
  filterBaseAttributableFailures,
  filterVerifyFailureByBaseHealth,
  renderBaseAttributableFilterDigest,
  applyF2GateMaskingGuards,
  type BaseAttributableFilterResult,
} from '../baseAttributableFilter';
import type { ProjectConfig } from '../../config';
import type { StructuredTestResult, TestRequestRunRow } from '../../db/types';

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
    started_at: 1_000_000,
    finished_at: null,
    structured_result: null,
    failure_reason: null,
    concurrent_run_count: null,
    oom_killed: 0,
    ...overrides,
  };
}

/** Flags `testId` breadth-attributable whenever `flaggedIds` contains it, regardless of window args. */
function stubBreadthFlags(flaggedIds: Set<string>) {
  mockComputeTestFailureBreadthFlag.mockImplementation(
    (testId: string, _windowHours: number, breadthN: number) => ({
      testId,
      distinctContentHashCount: flaggedIds.has(testId) ? breadthN : 0,
      flagged: flaggedIds.has(testId),
    }),
  );
}

beforeEach(() => {
  mockGetFailingTestIdsForRun.mockReset();
  mockGetFlaggedFlakyTestIds.mockReset();
  mockGetFlaggedFlakyTestIds.mockReturnValue(new Set<string>());
  mockListTestRequestRunsForSession.mockReset();
  mockListTestRequestRunsForSession.mockReturnValue([]);
  mockComputeTestFailureBreadthFlag.mockReset();
  stubBreadthFlags(new Set());
  mockIsTestIdTouchedByChangedFiles.mockReset();
  mockIsTestIdTouchedByChangedFiles.mockReturnValue({
    touched: false,
    confident: true,
  });
});

describe('baseAttributableFilter.ts source', () => {
  it('no longer imports checkBaseBranchHealth or matches on whole-tree content hash', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../baseAttributableFilter.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/checkBaseBranchHealth/);
    expect(src).not.toMatch(/baseHealthCheck/);
  });
});

describe('filterBaseAttributableFailures', () => {
  it('excludes a failing test flagged across at least flip_rate_breadth_n distinct content hashes and retains one that is not', async () => {
    stubBreadthFlags(new Set(['suite.testA']));
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testA', name: 'testA' },
      { test_id: 'suite.testB', name: 'testB' },
    ]);

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(result.outcome).toBe('filtered_partial');
    expect(result.passed).toBe(false);
    expect(result.excludedTests).toEqual([
      { test_id: 'suite.testA', name: 'testA' },
    ]);
    expect(result.remainingTests).toEqual([
      { test_id: 'suite.testB', name: 'testB' },
    ]);
    expect(result.flakyExcludedTests).toEqual([]);
    // No content-hash match against a base run is required — no such
    // concept exists in this module anymore.
    expect(mockComputeTestFailureBreadthFlag).toHaveBeenCalledWith(
      'suite.testA',
      24,
      3,
      expect.any(Number),
    );
  });

  it('reports filtered_pass when every failing test clears the breadth threshold', async () => {
    stubBreadthFlags(new Set(['suite.testA', 'suite.testB']));
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testA', name: 'testA' },
      { test_id: 'suite.testB', name: 'testB' },
    ]);

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(result.outcome).toBe('filtered_pass');
    expect(result.passed).toBe(true);
    expect(result.remainingTests).toEqual([]);
  });

  it('leaves the run unfiltered when no failing test is breadth-flagged or flaky-flagged', async () => {
    stubBreadthFlags(new Set());
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testC', name: 'testC' },
    ]);

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(result.outcome).toBe('unfiltered');
    expect(result.passed).toBe(false);
  });

  it('excludes a failure flagged flaky for this project even when not breadth-flagged', async () => {
    stubBreadthFlags(new Set());
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.flakyTest', name: 'flakyTest' },
    ]);
    mockGetFlaggedFlakyTestIds.mockReturnValue(new Set(['suite.flakyTest']));

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(result.outcome).toBe('filtered_pass');
    expect(result.passed).toBe(true);
    expect(result.flakyExcludedTests).toEqual([
      { test_id: 'suite.flakyTest', name: 'flakyTest' },
    ]);
  });

  it("uses the PR's own first-run timestamp as the breadth cutoff, so its own repeated runs cannot raise its breadth count", async () => {
    const run = makeRun({ id: 'run-latest', started_at: 5_000_000 });
    mockListTestRequestRunsForSession.mockReturnValue([
      makeRun({ id: 'run-earliest', started_at: 1_000_000 }),
      makeRun({ id: 'run-middle', started_at: 3_000_000 }),
      run,
    ]);
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testA', name: 'testA' },
    ]);
    stubBreadthFlags(new Set());

    await filterBaseAttributableFailures(PROJECT, run, 'task-1');

    expect(mockListTestRequestRunsForSession).toHaveBeenCalledWith(
      'proj-1',
      'sess-1',
      1000,
    );
    expect(mockComputeTestFailureBreadthFlag).toHaveBeenCalledWith(
      'suite.testA',
      24,
      3,
      1_000_000,
    );
  });

  it('falls back to the run’s own started_at when it has no session', async () => {
    const run = makeRun({ session_id: null, started_at: 2_500_000 });
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testA', name: 'testA' },
    ]);
    stubBreadthFlags(new Set());

    await filterBaseAttributableFailures(PROJECT, run, 'task-1');

    expect(mockListTestRequestRunsForSession).not.toHaveBeenCalled();
    expect(mockComputeTestFailureBreadthFlag).toHaveBeenCalledWith(
      'suite.testA',
      24,
      3,
      2_500_000,
    );
  });

  it('leaves a passed run untouched without consulting the breadth corpus', async () => {
    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun({ state: 'passed' }),
      'task-1',
    );

    expect(result.outcome).toBe('unfiltered');
    expect(result.passed).toBe(true);
    expect(mockComputeTestFailureBreadthFlag).not.toHaveBeenCalled();
  });

  it('leaves a failed run with no per-test breakdown unfiltered', async () => {
    mockGetFailingTestIdsForRun.mockReturnValue([]);

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(result.outcome).toBe('unfiltered');
    expect(result.passed).toBe(false);
  });
});

describe('filterBaseAttributableFailures does not file remediation tasks', () => {
  it('never imports or calls a remediation-filing module for any outcome', async () => {
    stubBreadthFlags(new Set(['suite.testA']));
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testA', name: 'testA' },
    ]);

    await filterBaseAttributableFailures(PROJECT, makeRun(), 'task-1');

    const src = fs.readFileSync(
      path.join(__dirname, '../baseAttributableFilter.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/baseHealthRemediationFiling/);
    expect(src).not.toMatch(/recordAndMaybeFileBaseHealthRemediation/);
  });

  it('the base-health remediation filing module has been deleted', () => {
    const filingPath = path.join(
      __dirname,
      '../../audit/baseHealthRemediationFiling.ts',
    );
    expect(fs.existsSync(filingPath)).toBe(false);
  });
});

function makeStructuredResult(
  failing: { id: string; name: string }[],
  passedCount = 0,
): StructuredTestResult {
  return {
    format: 'junit-xml',
    suites: [
      {
        name: 'suite',
        tests: failing.map((f) => ({
          id: f.id,
          name: f.name,
          outcome: 'failed',
          durationMs: 1,
        })),
      },
    ],
    totals: {
      passed: passedCount,
      failed: failing.length,
      skipped: 0,
      errors: 0,
    },
    durationMsTotal: 1000,
  };
}

describe('filterVerifyFailureByBaseHealth', () => {
  it('returns null when the verify failure has no structured report', async () => {
    const result = await filterVerifyFailureByBaseHealth(PROJECT, null);
    expect(result).toBeNull();
  });

  it('returns null when the structured report has no failing tests', async () => {
    const result = await filterVerifyFailureByBaseHealth(
      PROJECT,
      makeStructuredResult([], 10),
    );
    expect(result).toBeNull();
  });

  it('excludes breadth-flagged failing tests from a structured verify report', async () => {
    stubBreadthFlags(new Set(['t1', 't2']));
    const sr = makeStructuredResult(
      [
        { id: 't1', name: 'a' },
        { id: 't2', name: 'b' },
      ],
      6686,
    );

    const result = await filterVerifyFailureByBaseHealth(PROJECT, sr);

    expect(result?.outcome).toBe('filtered_pass');
    expect(result?.passed).toBe(true);
    expect(result?.excludedTests.map((t) => t.test_id).sort()).toEqual([
      't1',
      't2',
    ]);
  });

  it('reports only the non-breadth-flagged remainder when one failing test is not flagged', async () => {
    stubBreadthFlags(new Set(['t1']));
    const sr = makeStructuredResult([
      { id: 't1', name: 'a' },
      { id: 't2', name: 'b' },
    ]);

    const result = await filterVerifyFailureByBaseHealth(PROJECT, sr);

    expect(result?.outcome).toBe('filtered_partial');
    expect(result?.passed).toBe(false);
    expect(result?.excludedTests.map((t) => t.test_id)).toEqual(['t1']);
    expect(result?.remainingTests.map((t) => t.test_id)).toEqual(['t2']);
  });
});

describe('applyF2GateMaskingGuards', () => {
  const candidateResult: BaseAttributableFilterResult = {
    outcome: 'filtered_pass',
    passed: true,
    excludedTests: [{ test_id: 'suite.testA', name: 'testA' }],
    flakyExcludedTests: [],
    remainingTests: [],
    baseRun: null,
  };

  it('clears the exclusion when the diff does not touch the test file and the breadth signal re-confirms', () => {
    mockIsTestIdTouchedByChangedFiles.mockReturnValue({
      touched: false,
      confident: true,
    });
    stubBreadthFlags(new Set(['suite.testA']));
    const prRun = makeRun();

    const { result, guardBlocked } = applyF2GateMaskingGuards(
      candidateResult,
      prRun,
      ['unrelated/file.ts'],
    );

    expect(guardBlocked).toEqual([]);
    expect(result.outcome).toBe('filtered_pass');
    expect(result.excludedTests).toEqual([
      { test_id: 'suite.testA', name: 'testA' },
    ]);
  });

  it('blocks the exclusion when the diff touches the test file', () => {
    mockIsTestIdTouchedByChangedFiles.mockReturnValue({
      touched: true,
      confident: true,
    });
    stubBreadthFlags(new Set(['suite.testA']));
    const prRun = makeRun();

    const { result, guardBlocked } = applyF2GateMaskingGuards(
      candidateResult,
      prRun,
      ['suite/testA.spec.ts'],
    );

    expect(guardBlocked).toEqual([{ test_id: 'suite.testA', name: 'testA' }]);
    expect(result.excludedTests).toEqual([]);
    expect(result.remainingTests).toEqual([
      { test_id: 'suite.testA', name: 'testA' },
    ]);
    expect(result.passed).toBe(false);
  });

  it('blocks the exclusion when the breadth signal no longer re-confirms', () => {
    mockIsTestIdTouchedByChangedFiles.mockReturnValue({
      touched: false,
      confident: true,
    });
    stubBreadthFlags(new Set());
    const prRun = makeRun();

    const { result, guardBlocked } = applyF2GateMaskingGuards(
      candidateResult,
      prRun,
      ['unrelated/file.ts'],
    );

    expect(guardBlocked).toEqual([{ test_id: 'suite.testA', name: 'testA' }]);
    expect(result.excludedTests).toEqual([]);
  });
});

describe('renderBaseAttributableFilterDigest', () => {
  it('distinguishes breadth-attributed exclusions from flaky exclusions in the filtered_pass digest', () => {
    const digest = renderBaseAttributableFilterDigest({
      outcome: 'filtered_pass',
      passed: true,
      excludedTests: [{ test_id: 'suite.testA', name: 'testA' }],
      flakyExcludedTests: [{ test_id: 'suite.flakyTest', name: 'flakyTest' }],
      remainingTests: [],
      baseRun: null,
    });

    expect(digest).toContain('1 failing test(s) excluded');
    expect(digest).toContain('1 excluded as known-flaky');
  });

  it('distinguishes breadth-attributed exclusions from flaky exclusions in the filtered_partial digest', () => {
    const digest = renderBaseAttributableFilterDigest({
      outcome: 'filtered_partial',
      passed: false,
      excludedTests: [{ test_id: 'suite.testA', name: 'testA' }],
      flakyExcludedTests: [{ test_id: 'suite.flakyTest', name: 'flakyTest' }],
      remainingTests: [{ test_id: 'suite.testC', name: 'testC' }],
      baseRun: null,
    });

    expect(digest).toContain('1 additional failure(s) excluded');
    expect(digest).toContain('1 excluded as known-flaky');
    expect(digest).toContain('suite.testC');
  });

  it('reports the plain unfiltered digest when nothing was excused', () => {
    const digest = renderBaseAttributableFilterDigest({
      outcome: 'unfiltered',
      passed: false,
      excludedTests: [],
      flakyExcludedTests: [],
      remainingTests: [],
      baseRun: null,
    });

    expect(digest).toContain('no failing test was excused');
  });
});
