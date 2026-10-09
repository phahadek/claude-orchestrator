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

const summaryState = vi.hoisted(() => ({ incomplete: 0 }));

const {
  mockGetFailingTestIdsForRun,
  mockGetFlaggedFlakyTestIds,
  mockListTestRequestRunsForSession,
  mockComputeTestFailureBreadthFlag,
  mockMarkTestResultExcused,
  mockResolveBreadthOwnTree,
} = vi.hoisted(() => ({
  mockGetFailingTestIdsForRun: vi.fn(),
  mockGetFlaggedFlakyTestIds: vi.fn(() => new Set<string>()),
  mockListTestRequestRunsForSession: vi.fn(() => []),
  mockComputeTestFailureBreadthFlag: vi.fn(),
  mockMarkTestResultExcused: vi.fn(),
  mockResolveBreadthOwnTree: vi.fn(() => ({
    sessionIds: ['sess-1'],
    worktreePaths: ['/wt/own'],
  })),
}));
vi.mock('../../db/queries', () => ({
  getFailingTestIdsForRun: mockGetFailingTestIdsForRun,
  // The real run-outcome accessor reads these: a run whose structured_result
  // is already cleared (null) with a durable extracted summary.
  getTestRequestRunById: (id: string) => ({
    id,
    structured_result: null,
  }),
  getTestRunSummary: (id: string) => ({
    test_request_run_id: id,
    passed_count: 0,
    failed_count: 1,
    skipped_count: 0,
    error_count: 0,
    total_count: 1,
    incomplete: summaryState.incomplete,
  }),
  getFlaggedFlakyTestIds: mockGetFlaggedFlakyTestIds,
  listTestRequestRunsForSession: mockListTestRequestRunsForSession,
  computeTestFailureBreadthFlag: mockComputeTestFailureBreadthFlag,
  resolveBreadthOwnTree: mockResolveBreadthOwnTree,
  markTestResultExcused: mockMarkTestResultExcused,
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

// The filter reads failing tests through the real run-outcome accessor, which
// awaits this run's own in-flight ingestion dispatch (tracked via
// trackRunIngestion) before reading test_run_results.
import { trackRunIngestion } from '../runTestOutcomes';
import {
  filterBaseAttributableFailures,
  filterVerifyFailureByBaseHealth,
  filterBaseAttributableFailuresForF2Gate,
  renderBaseAttributableFilterDigest,
  applyF2GateMaskingGuards,
  type BaseAttributableFilterResult,
} from '../baseAttributableFilter';
import { logger } from '../../logger';
import type { ProjectConfig } from '../../config';
import type { StructuredTestResult, TestRequestRunRow } from '../../db/types';

const PROJECT = { id: 'proj-1', projectDir: '/tmp/x' } as ProjectConfig;
const SUBJECT = { sessionId: 'sess-1', worktreePath: '/wt/own' };

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
  mockMarkTestResultExcused.mockReset();
  summaryState.incomplete = 0;
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
      { sessionIds: ['sess-1'], worktreePaths: ['/wt/own'] },
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

  it("resolves the run's own tree by its session and worktree and evaluates breadth at call time, not at the session's first run", async () => {
    const run = makeRun({
      id: 'run-latest',
      started_at: 5_000_000,
      worktree_path: '/wt/own',
    });
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testA', name: 'testA' },
    ]);
    stubBreadthFlags(new Set());
    const before = Date.now();

    await filterBaseAttributableFailures(PROJECT, run, 'task-1');

    expect(mockResolveBreadthOwnTree).toHaveBeenCalledWith('proj-1', {
      sessionId: 'sess-1',
      worktreePath: '/wt/own',
    });
    expect(mockListTestRequestRunsForSession).not.toHaveBeenCalled();
    const asOf = mockComputeTestFailureBreadthFlag.mock.calls[0][3] as number;
    expect(asOf).toBeGreaterThanOrEqual(before);
  });

  it('resolves the own tree from the worktree alone for a pr_gate run with no session', async () => {
    const run = makeRun({
      session_id: null,
      worktree_path: '/wt/own',
    });
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testA', name: 'testA' },
    ]);
    stubBreadthFlags(new Set());

    await filterBaseAttributableFailures(PROJECT, run, 'task-1');

    expect(mockResolveBreadthOwnTree).toHaveBeenCalledWith('proj-1', {
      sessionId: null,
      worktreePath: '/wt/own',
    });
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

  it('writes the same excused marker shape flaky.confirm(gate:"test_request") writes for a filtered_pass outcome', async () => {
    stubBreadthFlags(new Set(['suite.testA']));
    mockGetFlaggedFlakyTestIds.mockReturnValue(new Set(['suite.testB']));
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testA', name: 'testA' },
      { test_id: 'suite.testB', name: 'testB' },
    ]);

    const run = makeRun({ id: 'run-42' });
    const result = await filterBaseAttributableFailures(PROJECT, run, 'task-1');

    expect(result.outcome).toBe('filtered_pass');
    expect(mockMarkTestResultExcused).toHaveBeenCalledWith(
      'run-42',
      'suite.testA',
      'breadth_corpus',
    );
    expect(mockMarkTestResultExcused).toHaveBeenCalledWith(
      'run-42',
      'suite.testB',
      'flaky_rollup',
    );
  });

  it('writes no marker when the run is unfiltered', async () => {
    stubBreadthFlags(new Set());
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testC', name: 'testC' },
    ]);

    await filterBaseAttributableFailures(PROJECT, makeRun(), 'task-1');

    expect(mockMarkTestResultExcused).not.toHaveBeenCalled();
  });
});

describe("filterBaseAttributableFailures — ingestion-ordering race (test_request_lane races the run's own test_run_results write)", () => {
  it("awaits the run's own tracked in-flight ingestion dispatch before reading the failing set, rather than reading test_run_results while it is still uncommitted", async () => {
    const order: string[] = [];
    let resolveIngestion: () => void = () => {};
    const pendingIngestion = new Promise<void>((resolve) => {
      resolveIngestion = resolve;
    }).then(() => {
      order.push('ingestion-committed');
    });
    trackRunIngestion('run-session-1', pendingIngestion);
    stubBreadthFlags(new Set(['suite.testA']));
    mockGetFailingTestIdsForRun.mockImplementation(() => {
      order.push('read-failing-set');
      return [{ test_id: 'suite.testA', name: 'testA' }];
    });

    const resultPromise = filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    // Flush pending microtasks several times over while the ingestion gate
    // stays closed — if the filter read ahead of the write, 'read-failing-set'
    // would already be in `order` by now.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(order).toEqual([]);
    expect(mockGetFailingTestIdsForRun).not.toHaveBeenCalled();

    resolveIngestion();
    const result = await resultPromise;

    expect(order).toEqual(['ingestion-committed', 'read-failing-set']);
    expect(result.outcome).toBe('filtered_pass');
  });

  it('reads the failing set immediately, with no wait, when no ingestion dispatch is tracked for this run (already settled, or never dispatched)', async () => {
    stubBreadthFlags(new Set());
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testC', name: 'testC' },
    ]);

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun(),
      'task-1',
    );

    expect(mockGetFailingTestIdsForRun).toHaveBeenCalled();
    expect(result.outcome).toBe('unfiltered');
  });

  it('logs a warning naming the run id, but still proceeds to filter against whatever committed, when the tracked ingestion dispatch rejects', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    trackRunIngestion(
      'run-ingestion-failed',
      Promise.reject(new Error('worker crashed')),
    );
    stubBreadthFlags(new Set());
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testC', name: 'testC' },
    ]);

    const result = await filterBaseAttributableFailures(
      PROJECT,
      makeRun({ id: 'run-ingestion-failed' }),
      'task-1',
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('run-ingestion-failed'),
    );
    expect(result.outcome).toBe('unfiltered');
    warnSpy.mockRestore();
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
    const result = await filterVerifyFailureByBaseHealth(
      PROJECT,
      null,
      null,
      SUBJECT,
    );
    expect(result).toBeNull();
  });

  it('returns null when the structured report has no failing tests', async () => {
    const result = await filterVerifyFailureByBaseHealth(
      PROJECT,
      null,
      makeStructuredResult([], 10),
      SUBJECT,
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

    const result = await filterVerifyFailureByBaseHealth(
      PROJECT,
      null,
      sr,
      SUBJECT,
    );

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

    const result = await filterVerifyFailureByBaseHealth(
      PROJECT,
      null,
      sr,
      SUBJECT,
    );

    expect(result?.outcome).toBe('filtered_partial');
    expect(result?.passed).toBe(false);
    expect(result?.excludedTests.map((t) => t.test_id)).toEqual(['t1']);
    expect(result?.remainingTests.map((t) => t.test_id)).toEqual(['t2']);
  });

  it('replayed run with structured_result NULL and failing test_run_results rows yields the same filtered outcome as the fresh run', async () => {
    stubBreadthFlags(new Set(['t1']));
    const failing = [
      { test_id: 't1', name: 'a' },
      { test_id: 't2', name: 'b' },
    ];
    mockGetFailingTestIdsForRun.mockReturnValue(failing);
    const sr = makeStructuredResult(
      failing.map((f) => ({ id: f.test_id, name: f.name })),
    );

    const fresh = await filterVerifyFailureByBaseHealth(
      PROJECT,
      null,
      sr,
      SUBJECT,
    );
    const replayed = await filterVerifyFailureByBaseHealth(
      PROJECT,
      'run-replayed',
      null,
      SUBJECT,
    );

    expect(replayed).toEqual(fresh);
    expect(replayed?.outcome).toBe('filtered_partial');
    expect(replayed?.excludedTests.map((t) => t.test_id)).toEqual(['t1']);
    expect(mockGetFailingTestIdsForRun).toHaveBeenCalledWith('run-replayed');
  });

  it('marks breadth_corpus and flaky_rollup excusals on the given verify lane run', async () => {
    stubBreadthFlags(new Set(['t1']));
    mockGetFlaggedFlakyTestIds.mockReturnValue(new Set(['t2']));
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 't1', name: 'a' },
      { test_id: 't2', name: 'b' },
      { test_id: 't3', name: 'c' },
    ]);

    const result = await filterVerifyFailureByBaseHealth(
      PROJECT,
      'verify-run',
      null,
      SUBJECT,
    );

    expect(result?.outcome).toBe('filtered_partial');
    expect(mockMarkTestResultExcused).toHaveBeenCalledWith(
      'verify-run',
      't1',
      'breadth_corpus',
    );
    expect(mockMarkTestResultExcused).toHaveBeenCalledWith(
      'verify-run',
      't2',
      'flaky_rollup',
    );
    expect(mockMarkTestResultExcused).not.toHaveBeenCalledWith(
      'verify-run',
      't3',
      expect.anything(),
    );
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

describe('filterBaseAttributableFailuresForF2Gate — the shared PreReviewPipeline/AutoMerger/stagedIntents F2-gate entry point', () => {
  it("awaits the run's own tracked in-flight ingestion dispatch before reading the failing set — the same ordering guarantee filterBaseAttributableFailures provides, inherited here since this is a thin wrapper with no db/queries reads of its own before delegating", async () => {
    // PreReviewPipeline.ts (applyBaseAttributableF2GateFilter) and
    // AutoMerger.ts both call this exact function — neither reads
    // test_run_results directly, so proving the ordering guarantee holds
    // here proves it holds at both of those call sites too.
    const order: string[] = [];
    let resolveIngestion: () => void = () => {};
    const pendingIngestion = new Promise<void>((resolve) => {
      resolveIngestion = resolve;
    }).then(() => {
      order.push('ingestion-committed');
    });
    trackRunIngestion('run-session-1', pendingIngestion);
    stubBreadthFlags(new Set(['suite.testA']));
    mockGetFailingTestIdsForRun.mockImplementation(() => {
      order.push('read-failing-set');
      return [{ test_id: 'suite.testA', name: 'testA' }];
    });

    const gatePromise = filterBaseAttributableFailuresForF2Gate(
      PROJECT,
      makeRun(),
      [],
      'task-1',
    );

    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(order).toEqual([]);

    resolveIngestion();
    const { result } = await gatePromise;

    expect(order).toEqual(['ingestion-committed', 'read-failing-set']);
    expect(result.outcome).toBe('filtered_pass');
  });
});

describe('excused-marker write ordering and completeness guard', () => {
  it('never marks a diff-touching, breadth-flagged test excused', async () => {
    stubBreadthFlags(new Set(['suite.testA', 'suite.testB']));
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testA', name: 'testA' },
      { test_id: 'suite.testB', name: 'testB' },
    ]);
    mockIsTestIdTouchedByChangedFiles.mockImplementation(((id: string) => ({
      touched: id === 'suite.testA',
      confident: true,
    })) as never);

    const { result, guardBlocked } =
      await filterBaseAttributableFailuresForF2Gate(
        PROJECT,
        makeRun(),
        ['suite/testA.spec.ts'],
        'task-1',
      );

    expect(guardBlocked).toEqual([{ test_id: 'suite.testA', name: 'testA' }]);
    expect(result.remainingTests).toEqual([
      { test_id: 'suite.testA', name: 'testA' },
    ]);
    const marked = mockMarkTestResultExcused.mock.calls.map((c) => c[1]);
    expect(marked).not.toContain('suite.testA');
    expect(marked).toContain('suite.testB');
  });

  it('never flips an incomplete run to passed even when every captured failure clears breadth', async () => {
    summaryState.incomplete = 1;
    stubBreadthFlags(new Set(['suite.testA']));
    mockGetFailingTestIdsForRun.mockReturnValue([
      { test_id: 'suite.testA', name: 'testA' },
    ]);

    const { result } = await filterBaseAttributableFailuresForF2Gate(
      PROJECT,
      makeRun(),
      [],
      'task-1',
    );

    expect(result.passed).toBe(false);
    expect(result.outcome).toBe('unfiltered');
    expect(mockMarkTestResultExcused).not.toHaveBeenCalled();
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
