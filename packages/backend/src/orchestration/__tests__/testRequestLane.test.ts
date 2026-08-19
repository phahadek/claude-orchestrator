/**
 * The test.request lane's own concerns, independent of the staged-intent
 * auto-grant wiring: coalescing two concurrent requests for the same
 * (project, content-hash) into one execution, and crash-recovery marking a
 * leftover `running` row as `failed` at boot.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const {
  mockRunTestCommands,
  mockCollectStructuredTestResult,
  mockHasAdmission,
  mockLoadOrchestratorConfig,
} = vi.hoisted(() => ({
  mockRunTestCommands: vi.fn(),
  mockCollectStructuredTestResult: vi.fn(() => null),
  mockHasAdmission: vi.fn(() => true),
  mockLoadOrchestratorConfig: vi.fn(() => ({ test_report_glob: '' })),
}));

vi.mock('../../session/test-runner', () => ({
  runTestCommands: mockRunTestCommands,
  collectStructuredTestResult: mockCollectStructuredTestResult,
}));

vi.mock('../../session/orchestrator-config', () => ({
  resolvePreGrantCapabilities: vi.fn(() => []),
  loadOrchestratorConfig: mockLoadOrchestratorConfig,
}));

// Host memory headroom is real-machine-dependent and irrelevant to most of
// this suite (coalescing + crash recovery) — defaults to always-admit, but
// individual tests can override mockHasAdmission to exercise the wait loop.
vi.mock('../memoryAdmission', () => ({
  hasTestRequestAdmission: mockHasAdmission,
}));

import { db } from '../../db/db';
import {
  runProjectTestRequest,
  recoverInterruptedTestRequestRuns,
  ingestTestRunResults,
  sweepTestRunResultsExtraction,
  computeTestPerfBaseline,
} from '../testRequestLane';
import {
  insertTestRequestRun,
  completeTestRequestRun,
  clearSupersededStructuredResults,
  clearExtractedStructuredResultsBatch,
  listRunningTestRequestRuns,
  getLatestTestRequestRun,
  listTestRunResultsForRun,
  ingestTestRunResultsTx,
  hasTestRunSummary,
  getTestRunSummary,
  getTestPerfBaseline,
  listRecentValidTestDurations,
  computeTestFlipRateFlag,
  computeTestFailureBreadthFlag,
  TEST_OUTCOME_DIGEST_CAPACITY,
  TEST_DURATION_DIGEST_CAPACITY,
  countTestRequestRunsNeedingExtraction,
} from '../../db/queries';

beforeEach(() => {
  mockRunTestCommands.mockReset();
  mockCollectStructuredTestResult.mockReset();
  mockCollectStructuredTestResult.mockReturnValue(null);
  mockHasAdmission.mockReset();
  mockHasAdmission.mockReturnValue(true);
  mockLoadOrchestratorConfig.mockReset();
  mockLoadOrchestratorConfig.mockReturnValue({ test_report_glob: '' });
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_run_summaries').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM test_perf_baselines').run();
});

let sampleSeq = 0;

/**
 * Ingests one synthetic passing test result (with a backing test_request_runs
 * row for the FK) for a given test_id/duration/validity, through the same
 * ingestTestRunResultsTx path production ingestion uses — so the
 * test_perf_baselines digest (recent_outcomes/recent_durations) the
 * baseline/flip-rate query functions now read from gets populated exactly
 * like a real run would. concurrentRunCount is required, not defaulted — the
 * whole point of these baseline/flip-rate tests is exercising query logic
 * given an arbitrary already-recorded value, not re-deriving what the
 * production admission path writes; see the "concurrent_run_count" describe
 * block below for tests that drive the real admission path instead.
 */
function insertSample(
  testId: string,
  durationMs: number,
  opts: { concurrentRunCount: number; oomKilled?: boolean },
): void {
  const runId = `perf-run-${testId}-${sampleSeq++}`;
  insertTestRequestRun(runId, 'proj-1', `perf-hash-${runId}`, null, Date.now());
  ingestTestRunResultsTx(
    runId,
    'proj-1',
    [
      {
        test_id: testId,
        name: testId,
        outcome: 'passed',
        duration_ms: durationMs,
      },
    ],
    opts.concurrentRunCount,
    opts.oomKilled ?? false,
  );
}

/** Like insertSample, but with a caller-chosen outcome — for flip-rate digest tests. */
function insertOutcomeSample(
  testId: string,
  outcome: 'passed' | 'failed',
  durationMs: number,
  opts: { concurrentRunCount: number; oomKilled?: boolean },
): void {
  const runId = `flip-run-${testId}-${sampleSeq++}`;
  insertTestRequestRun(runId, 'proj-1', `flip-hash-${runId}`, null, Date.now());
  ingestTestRunResultsTx(
    runId,
    'proj-1',
    [{ test_id: testId, name: testId, outcome, duration_ms: durationMs }],
    opts.concurrentRunCount,
    opts.oomKilled ?? false,
  );
}

function baseSpec(
  overrides: Partial<Parameters<typeof runProjectTestRequest>[0]> = {},
) {
  return {
    projectId: 'proj-1',
    contentHash: 'hash-a',
    worktreePath: '/tmp/wt',
    commands: ['npm test'],
    timeoutSec: 60,
    maxRssMb: 0,
    failFast: true,
    sessionId: null,
    ...overrides,
  };
}

describe('runProjectTestRequest — coalescing', () => {
  it('two concurrent requests for the same (project, content-hash) share one execution; the joiner reports joined=true and the shared runId', async () => {
    let resolveRun: (v: { passed: boolean; output: string }) => void;
    mockRunTestCommands.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );

    const spec = baseSpec();
    const p1 = runProjectTestRequest(spec);
    const p2 = runProjectTestRequest(spec);

    await vi.waitFor(() => expect(mockRunTestCommands).toHaveBeenCalled());
    resolveRun!({ passed: true, output: 'ok' });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);
    expect(r1.passed).toBe(true);
    expect(r1.joined).toBe(false);
    expect(r2.joined).toBe(true);
    expect(r2.runId).toBe(r1.runId);
  });

  it('a different content-hash starts an independent execution', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(baseSpec({ contentHash: 'hash-a' }));
    await runProjectTestRequest(baseSpec({ contentHash: 'hash-b' }));

    expect(mockRunTestCommands).toHaveBeenCalledTimes(2);
  });

  it('records a completed run in test_request_runs, linked to the originating session', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: false, output: 'boom' });

    await runProjectTestRequest(
      baseSpec({ contentHash: 'hash-c', sessionId: 'session-1' }),
    );

    const row = db
      .prepare(
        `SELECT state, output, session_id, failure_reason FROM test_request_runs WHERE project_id = ? AND content_hash = ?`,
      )
      .get('proj-1', 'hash-c') as {
      state: string;
      output: string;
      session_id: string | null;
      failure_reason: string | null;
    };
    expect(row.state).toBe('failed');
    expect(row.output).toBe('boom');
    expect(row.session_id).toBe('session-1');
    expect(row.failure_reason).toBe('generic');
  });

  it('captures requested_at before the admission wait resolves, not after', async () => {
    vi.useFakeTimers();
    try {
      // First admission check fails, forcing waitForMemoryAdmission's poll
      // loop to sleep once before granting — requested_at must reflect the
      // moment of the call, not the moment admission was eventually granted.
      mockHasAdmission.mockReturnValueOnce(false).mockReturnValue(true);
      mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

      const before = Date.now();
      const run = runProjectTestRequest(baseSpec({ contentHash: 'hash-d' }));

      await vi.advanceTimersByTimeAsync(5_000);
      await run;

      const row = db
        .prepare(
          `SELECT requested_at, started_at FROM test_request_runs WHERE project_id = ? AND content_hash = ?`,
        )
        .get('proj-1', 'hash-d') as {
        requested_at: number;
        started_at: number;
      };
      expect(row.requested_at).toBe(before);
      expect(row.started_at).toBeGreaterThan(row.requested_at);
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes timeout, oom-kill, and generic failure sub-reasons', async () => {
    mockRunTestCommands.mockResolvedValueOnce({
      passed: false,
      output: 'timed out',
      timedOut: true,
    });
    await runProjectTestRequest(baseSpec({ contentHash: 'hash-timeout' }));

    mockRunTestCommands.mockResolvedValueOnce({
      passed: false,
      output: 'oom',
      oomKilled: true,
    });
    await runProjectTestRequest(baseSpec({ contentHash: 'hash-oom' }));

    mockRunTestCommands.mockResolvedValueOnce({
      passed: false,
      output: 'nonzero exit',
    });
    await runProjectTestRequest(baseSpec({ contentHash: 'hash-generic' }));

    const reasonFor = (contentHash: string) =>
      (
        db
          .prepare(
            `SELECT failure_reason FROM test_request_runs WHERE project_id = ? AND content_hash = ?`,
          )
          .get('proj-1', contentHash) as { failure_reason: string }
      ).failure_reason;

    expect(reasonFor('hash-timeout')).toBe('timeout');
    expect(reasonFor('hash-oom')).toBe('oom_killed');
    expect(reasonFor('hash-generic')).toBe('generic');
  });
});

describe('recoverInterruptedTestRequestRuns', () => {
  it('marks a leftover running row as failed', () => {
    insertTestRequestRun('run-1', 'proj-1', 'hash-x', null, Date.now());
    expect(listRunningTestRequestRuns()).toHaveLength(1);

    recoverInterruptedTestRequestRuns();

    expect(listRunningTestRequestRuns()).toHaveLength(0);
    const row = db
      .prepare(`SELECT state FROM test_request_runs WHERE id = ?`)
      .get('run-1') as { state: string };
    expect(row.state).toBe('failed');
  });
});

// ── concurrent_run_count / oom_killed — validity signals captured at run time ──

describe('concurrent_run_count', () => {
  it('stores 0 — satisfying the concurrent_run_count = 0 validity predicate — for a run admitted with no concurrent peer', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(baseSpec({ contentHash: 'hash-solo' }));

    const row = db
      .prepare(
        `SELECT concurrent_run_count FROM test_request_runs WHERE content_hash = ?`,
      )
      .get('hash-solo') as { concurrent_run_count: number };
    expect(row.concurrent_run_count).toBe(0);
  });

  it('stores a nonzero peer count — failing the concurrent_run_count = 0 validity predicate — for a run admitted alongside one concurrent peer', async () => {
    const resolvers: Array<(v: { passed: boolean; output: string }) => void> =
      [];
    mockRunTestCommands.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const p1 = runProjectTestRequest(baseSpec({ contentHash: 'hash-conc-1' }));
    const p2 = runProjectTestRequest(baseSpec({ contentHash: 'hash-conc-2' }));

    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(2),
    );
    resolvers.forEach((resolve) => resolve({ passed: true, output: 'ok' }));
    await Promise.all([p1, p2]);

    const rows = db
      .prepare(
        `SELECT concurrent_run_count FROM test_request_runs WHERE content_hash IN ('hash-conc-1', 'hash-conc-2') ORDER BY concurrent_run_count`,
      )
      .all() as { concurrent_run_count: number }[];
    const counts = rows.map((r) => r.concurrent_run_count);
    // Both runs are admitted concurrently (default per-project limit is 2),
    // so each recorded peer count (occupancy excluding self) must fall
    // within [0, 1] — and since both were in flight together, at least one
    // of them must have observed the other, i.e. a peer count of 1, which
    // fails the = 0 validity predicate.
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(0);
      expect(count).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...counts)).toBe(1);
  });
});

describe('concurrent_run_count validity signal — end-to-end through the production admission path', () => {
  function structuredResultFor(
    testId: string,
    outcome: 'passed' | 'failed',
    durationMs: number,
  ) {
    return {
      format: 'junit-xml' as const,
      suites: [
        {
          name: 'suite',
          tests: [{ id: testId, name: testId, outcome, durationMs }],
        },
      ],
      totals: {
        passed: outcome === 'passed' ? 1 : 0,
        failed: outcome === 'failed' ? 1 : 0,
        skipped: 0,
        errors: 0,
      },
      durationMsTotal: durationMs,
    };
  }

  it('listRecentValidTestDurations returns a non-empty sample set and computeTestPerfBaseline writes a baseline row for a test ingested through the lane with no concurrent peer', async () => {
    mockLoadOrchestratorConfig.mockReturnValue({
      test_report_glob: 'reports/*.xml',
    });
    const testId = 'e2e-perf-test';
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });
    mockCollectStructuredTestResult.mockReturnValue(
      structuredResultFor(testId, 'passed', 123),
    );

    await runProjectTestRequest(baseSpec({ contentHash: 'hash-e2e-perf' }));
    const run = getLatestTestRequestRun('proj-1', 'hash-e2e-perf')!;
    expect(run.concurrent_run_count).toBe(0);
    ingestTestRunResults(run);

    expect(listRecentValidTestDurations(testId, 10)).toEqual([123]);

    const baseline = getTestPerfBaseline(testId);
    expect(baseline).toBeDefined();
    expect(baseline!.sample_count).toBe(1);
  });

  it('computeTestFlipRateFlag accumulates samples and flags a test whose outcomes alternate past the configured threshold, using samples ingested through the lane', async () => {
    mockLoadOrchestratorConfig.mockReturnValue({
      test_report_glob: 'reports/*.xml',
    });
    const testId = 'e2e-flip-test';
    const outcomes: Array<'passed' | 'failed'> = [
      'passed',
      'failed',
      'passed',
      'failed',
    ];

    for (const [i, outcome] of outcomes.entries()) {
      mockRunTestCommands.mockResolvedValueOnce({
        passed: outcome === 'passed',
        output: 'ok',
      });
      mockCollectStructuredTestResult.mockReturnValueOnce(
        structuredResultFor(testId, outcome, 10),
      );
      const contentHash = `hash-e2e-flip-${i}`;
      await runProjectTestRequest(baseSpec({ contentHash }));
      const run = getLatestTestRequestRun('proj-1', contentHash)!;
      expect(run.concurrent_run_count).toBe(0);
      ingestTestRunResults(run);
    }

    const flag = computeTestFlipRateFlag(testId, 10, 2);
    expect(flag.sampleCount).toBe(4);
    expect(flag.transitionCount).toBe(3);
    expect(flag.flagged).toBe(true);
  });

  it('computeTestFailureBreadthFlag flags a deterministically-failing test (never alternates, so flip-rate alone could never flag it) once it has failed across enough distinct content hashes ingested through the lane', async () => {
    mockLoadOrchestratorConfig.mockReturnValue({
      test_report_glob: 'reports/*.xml',
    });
    const testId = 'e2e-breadth-test';
    mockRunTestCommands.mockResolvedValue({ passed: false, output: 'fail' });
    mockCollectStructuredTestResult.mockReturnValue(
      structuredResultFor(testId, 'failed', 10),
    );

    for (let i = 0; i < 3; i++) {
      const contentHash = `hash-e2e-breadth-${i}`;
      await runProjectTestRequest(baseSpec({ contentHash }));
      const run = getLatestTestRequestRun('proj-1', contentHash)!;
      ingestTestRunResults(run);
    }

    const flipFlag = computeTestFlipRateFlag(testId, 10, 2);
    expect(flipFlag.transitionCount).toBe(0);
    expect(flipFlag.flagged).toBe(false);

    const breadthFlag = computeTestFailureBreadthFlag(
      testId,
      24,
      3,
      Date.now() + 1,
    );
    expect(breadthFlag.distinctContentHashCount).toBe(3);
    expect(breadthFlag.flagged).toBe(true);
  });
});

describe('oom_killed', () => {
  it('is set when TestCommandResult.oomKilled is true', async () => {
    mockRunTestCommands.mockResolvedValue({
      passed: false,
      output: 'killed',
      oomKilled: true,
    });

    await runProjectTestRequest(baseSpec({ contentHash: 'hash-oom' }));

    const row = db
      .prepare(
        `SELECT oom_killed FROM test_request_runs WHERE content_hash = ?`,
      )
      .get('hash-oom') as { oom_killed: number };
    expect(row.oom_killed).toBe(1);
  });

  it('defaults to 0 when TestCommandResult.oomKilled is absent', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(baseSpec({ contentHash: 'hash-no-oom' }));

    const row = db
      .prepare(
        `SELECT oom_killed FROM test_request_runs WHERE content_hash = ?`,
      )
      .get('hash-no-oom') as { oom_killed: number };
    expect(row.oom_killed).toBe(0);
  });
});

// ── structured_result acquisition wiring (testReportGlob) ──────────────────

describe('structured_result acquisition', () => {
  it('leaves structured_result null when testReportGlob is unset, behaving exactly as before', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(baseSpec({ contentHash: 'hash-no-glob' }));

    expect(mockCollectStructuredTestResult).not.toHaveBeenCalled();
    const row = db
      .prepare(
        `SELECT structured_result FROM test_request_runs WHERE content_hash = ?`,
      )
      .get('hash-no-glob') as { structured_result: string | null };
    expect(row.structured_result).toBeNull();
  });

  it('persists the acquired structured_result when testReportGlob is set and a report matches', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });
    const structured = {
      format: 'junit-xml' as const,
      suites: [
        {
          name: 'pytest',
          tests: [
            { id: 't1', name: 'test one', outcome: 'passed', durationMs: 10 },
          ],
        },
      ],
      totals: { passed: 1, failed: 0, skipped: 0, errors: 0 },
      durationMsTotal: 10,
    };
    mockCollectStructuredTestResult.mockReturnValue(structured);
    mockLoadOrchestratorConfig.mockReturnValue({
      test_report_glob: 'reports/*.xml',
    });

    await runProjectTestRequest(
      baseSpec({
        contentHash: 'hash-with-glob',
      }),
    );

    expect(mockCollectStructuredTestResult).toHaveBeenCalledWith(
      '/tmp/wt',
      'reports/*.xml',
      1,
    );
    const row = db
      .prepare(
        `SELECT structured_result FROM test_request_runs WHERE content_hash = ?`,
      )
      .get('hash-with-glob') as { structured_result: string | null };
    expect(JSON.parse(row.structured_result!)).toEqual(structured);
  });

  it('still runs to completion and leaves structured_result null when acquisition finds no matching report', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: false, output: 'boom' });
    mockCollectStructuredTestResult.mockReturnValue(null);
    mockLoadOrchestratorConfig.mockReturnValue({
      test_report_glob: 'reports/*.xml',
    });

    await runProjectTestRequest(
      baseSpec({
        contentHash: 'hash-glob-no-match',
      }),
    );

    const row = db
      .prepare(
        `SELECT state, structured_result FROM test_request_runs WHERE content_hash = ?`,
      )
      .get('hash-glob-no-match') as {
      state: string;
      structured_result: string | null;
    };
    expect(row.state).toBe('failed');
    expect(row.structured_result).toBeNull();
  });

  it("clears a superseded run's structured_result once a newer run lands for the same (project, content-hash), leaving its other columns and test_run_results extraction untouched", async () => {
    const structuredFirst = {
      format: 'junit-xml' as const,
      suites: [
        {
          name: 'pytest',
          tests: [
            { id: 't1', name: 'test one', outcome: 'failed', durationMs: 10 },
          ],
        },
      ],
      totals: { passed: 0, failed: 1, skipped: 0, errors: 0 },
      durationMsTotal: 10,
    };
    mockLoadOrchestratorConfig.mockReturnValue({
      test_report_glob: 'reports/*.xml',
    });

    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'first ok' });
    mockCollectStructuredTestResult.mockReturnValue(structuredFirst);
    const first = await runProjectTestRequest(
      baseSpec({ contentHash: 'hash-supersede' }),
    );

    const firstRowBefore = db
      .prepare(`SELECT structured_result FROM test_request_runs WHERE id = ?`)
      .get(first.runId) as { structured_result: string | null };
    expect(firstRowBefore.structured_result).not.toBeNull();

    ingestTestRunResults(getLatestTestRequestRun('proj-1', 'hash-supersede')!);
    const firstRunResultsBefore = listTestRunResultsForRun(first.runId);
    expect(firstRunResultsBefore).toHaveLength(1);

    const structuredSecond = {
      ...structuredFirst,
      suites: [
        {
          name: 'pytest',
          tests: [
            { id: 't1', name: 'test one', outcome: 'failed', durationMs: 12 },
          ],
        },
      ],
    };
    mockRunTestCommands.mockResolvedValue({
      passed: true,
      output: 'second ok',
    });
    mockCollectStructuredTestResult.mockReturnValue(structuredSecond);
    const second = await runProjectTestRequest(
      baseSpec({ contentHash: 'hash-supersede' }),
    );
    expect(second.runId).not.toBe(first.runId);

    const firstRowAfter = db
      .prepare(
        `SELECT state, output, structured_result FROM test_request_runs WHERE id = ?`,
      )
      .get(first.runId) as {
      state: string;
      output: string;
      structured_result: string | null;
    };
    expect(firstRowAfter.structured_result).toBeNull();
    expect(firstRowAfter.state).toBe('passed');
    expect(firstRowAfter.output).toBe('first ok');

    // The now-latest row keeps its own structured_result.
    const secondRow = db
      .prepare(`SELECT structured_result FROM test_request_runs WHERE id = ?`)
      .get(second.runId) as { structured_result: string | null };
    expect(secondRow.structured_result).not.toBeNull();

    // test_run_results extraction for the superseded run is untouched.
    expect(listTestRunResultsForRun(first.runId)).toEqual(
      firstRunResultsBefore,
    );
  });
});

// ── ingestTestRunResults — per-test extraction from structured_result ──────

describe('ingestTestRunResults', () => {
  it('writes zero test_run_results rows for a run whose results are all passed', () => {
    const structured = JSON.stringify({
      suites: [
        {
          tests: [
            { id: 't1', name: 'test one', outcome: 'passed', durationMs: 12 },
            { id: 't2', name: 'test two', outcome: 'passed', durationMs: 34 },
          ],
        },
      ],
    });
    insertTestRequestRun(
      'run-extract-allpass',
      'proj-1',
      'hash-extract-allpass',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-extract-allpass',
      'passed',
      'ok',
      null,
      structured,
    );

    const run = getLatestTestRequestRun('proj-1', 'hash-extract-allpass')!;
    ingestTestRunResults(run);

    expect(listTestRunResultsForRun('run-extract-allpass')).toHaveLength(0);
  });

  it('writes exactly one row per non-passing result for a mixed run, carrying the run validity signals, and folds the passing result into the digest without a raw row', () => {
    const structured = JSON.stringify({
      suites: [
        {
          tests: [
            { id: 't1', name: 'test one', outcome: 'passed', durationMs: 12 },
            { id: 't2', name: 'test two', outcome: 'failed', durationMs: 34 },
          ],
        },
      ],
    });
    insertTestRequestRun(
      'run-extract-1',
      'proj-1',
      'hash-extract-1',
      null,
      Date.now(),
      2,
    );
    completeTestRequestRun(
      'run-extract-1',
      'passed',
      'ok',
      null,
      structured,
      true,
    );

    const run = getLatestTestRequestRun('proj-1', 'hash-extract-1')!;
    ingestTestRunResults(run);

    const rows = listTestRunResultsForRun('run-extract-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      test_id: 't2',
      name: 'test two',
      outcome: 'failed',
      duration_ms: 34,
      concurrent_run_count: 2,
      oom_killed: 1,
    });

    // t1's passing result never got a raw row, but did reach the digest.
    expect(listRecentValidTestDurations('t1', 10)).toEqual([]); // invalid — concurrent_run_count=2
  });

  it('the per-run summary record reports outcome counts equal to the ingested results for a mixed pass/fail/skip run', () => {
    const structured = JSON.stringify({
      suites: [
        {
          tests: [
            { id: 't1', name: 'n1', outcome: 'passed', durationMs: 10 },
            { id: 't2', name: 'n2', outcome: 'passed', durationMs: 20 },
            { id: 't3', name: 'n3', outcome: 'failed', durationMs: 30 },
            { id: 't4', name: 'n4', outcome: 'skipped', durationMs: 0 },
          ],
        },
      ],
    });
    insertTestRequestRun(
      'run-extract-summary',
      'proj-1',
      'hash-extract-summary',
      null,
      Date.now(),
      0,
    );
    completeTestRequestRun(
      'run-extract-summary',
      'passed',
      'ok',
      null,
      structured,
    );

    const run = getLatestTestRequestRun('proj-1', 'hash-extract-summary')!;
    ingestTestRunResults(run);

    const summary = getTestRunSummary('run-extract-summary')!;
    expect(summary.passed_count).toBe(2);
    expect(summary.failed_count).toBe(1);
    expect(summary.skipped_count).toBe(1);
    expect(summary.error_count).toBe(0);
    expect(summary.total_count).toBe(4);
    expect(summary.total_duration_ms).toBe(60);
  });

  it('is idempotent — calling it twice does not duplicate the raw failure row, the summary, or the digest', () => {
    const structured = JSON.stringify({
      suites: [
        {
          tests: [
            { id: 't1', name: 'n', outcome: 'passed', durationMs: 1 },
            { id: 't2', name: 'n2', outcome: 'failed', durationMs: 2 },
          ],
        },
      ],
    });
    insertTestRequestRun(
      'run-extract-2',
      'proj-1',
      'hash-extract-2',
      null,
      Date.now(),
      0,
    );
    completeTestRequestRun('run-extract-2', 'passed', 'ok', null, structured);

    const run = getLatestTestRequestRun('proj-1', 'hash-extract-2')!;
    ingestTestRunResults(run);
    ingestTestRunResults(run);

    expect(listTestRunResultsForRun('run-extract-2')).toHaveLength(1);
    expect(listRecentValidTestDurations('t1', 10)).toEqual([1]);
  });

  it('is a no-op when structured_result is null', () => {
    insertTestRequestRun(
      'run-extract-3',
      'proj-1',
      'hash-extract-3',
      null,
      Date.now(),
    );
    completeTestRequestRun('run-extract-3', 'passed', 'ok');

    const run = getLatestTestRequestRun('proj-1', 'hash-extract-3')!;
    ingestTestRunResults(run);

    expect(listTestRunResultsForRun('run-extract-3')).toHaveLength(0);
    expect(hasTestRunSummary('run-extract-3')).toBe(false);
  });

  it('never clears the run\'s own structured_result — the lone-key own-row clear must not be inlined into the synchronous completion path, so a race with stagedIntents.ts\'s session-feedback digest read (which happens right after ingestTestRunResults returns) is impossible', () => {
    const structured = JSON.stringify({
      suites: [
        {
          tests: [{ id: 't1', name: 'n', outcome: 'failed', durationMs: 5 }],
        },
      ],
    });
    insertTestRequestRun(
      'run-extract-lonekey',
      'proj-1',
      'hash-extract-lonekey',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-extract-lonekey',
      'passed',
      'ok',
      null,
      structured,
    );

    const run = getLatestTestRequestRun('proj-1', 'hash-extract-lonekey')!;
    ingestTestRunResults(run);

    // Extraction succeeded (this is the only run for its key, so there is no
    // "other" row for clearSupersededStructuredResults to have cleared
    // either), yet the row's own blob must still be intact immediately after
    // ingestTestRunResults returns.
    expect(hasTestRunSummary('run-extract-lonekey')).toBe(true);
    const row = db
      .prepare(`SELECT structured_result FROM test_request_runs WHERE id = ?`)
      .get('run-extract-lonekey') as { structured_result: string | null };
    expect(row.structured_result).toBe(structured);
  });
});

describe('sweepTestRunResultsExtraction', () => {
  it('catches a row with structured_result set but no test_run_results rows', async () => {
    const structured = JSON.stringify({
      suites: [
        {
          tests: [{ id: 't1', name: 'n', outcome: 'failed', durationMs: 5 }],
        },
      ],
    });
    insertTestRequestRun(
      'run-sweep-1',
      'proj-1',
      'hash-sweep-1',
      null,
      Date.now(),
    );
    completeTestRequestRun('run-sweep-1', 'passed', 'ok', null, structured);

    expect(listTestRunResultsForRun('run-sweep-1')).toHaveLength(0);

    await sweepTestRunResultsExtraction();

    expect(listTestRunResultsForRun('run-sweep-1')).toHaveLength(1);
  });

  it('clearExtractedStructuredResultsBatch clears an already-summarized row directly, and reports 0 once nothing matches', () => {
    const structured = JSON.stringify({
      suites: [
        { tests: [{ id: 't1', name: 'n', outcome: 'failed', durationMs: 5 }] },
      ],
    });
    insertTestRequestRun(
      'run-batch-clear',
      'proj-1',
      'hash-batch-clear',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-batch-clear',
      'passed',
      'ok',
      null,
      structured,
    );
    ingestTestRunResults(getLatestTestRequestRun('proj-1', 'hash-batch-clear')!);

    const cleared = clearExtractedStructuredResultsBatch();
    expect(cleared).toBe(1);
    const row = db
      .prepare(`SELECT structured_result FROM test_request_runs WHERE id = ?`)
      .get('run-batch-clear') as { structured_result: string | null };
    expect(row.structured_result).toBeNull();

    expect(clearExtractedStructuredResultsBatch()).toBe(0);
  });

  it('leaves an already-extracted run untouched', async () => {
    const structured = JSON.stringify({
      suites: [
        {
          tests: [{ id: 't1', name: 'n', outcome: 'failed', durationMs: 5 }],
        },
      ],
    });
    insertTestRequestRun(
      'run-sweep-2',
      'proj-1',
      'hash-sweep-2',
      null,
      Date.now(),
    );
    completeTestRequestRun('run-sweep-2', 'passed', 'ok', null, structured);
    await sweepTestRunResultsExtraction();
    expect(listTestRunResultsForRun('run-sweep-2')).toHaveLength(1);

    await sweepTestRunResultsExtraction();

    expect(listTestRunResultsForRun('run-sweep-2')).toHaveLength(1);
  });

  it('is a no-op — writes no duplicate digest samples — when re-run against an already-ingested all-passing run', async () => {
    const structured = JSON.stringify({
      suites: [
        {
          tests: [{ id: 't1', name: 'n', outcome: 'passed', durationMs: 5 }],
        },
      ],
    });
    insertTestRequestRun(
      'run-sweep-allpass',
      'proj-1',
      'hash-sweep-allpass',
      null,
      Date.now(),
      0,
    );
    completeTestRequestRun(
      'run-sweep-allpass',
      'passed',
      'ok',
      null,
      structured,
    );

    // No raw rows and no idempotency-check-detectable state for
    // hasTestRunResults — the boot-sweep case an all-passing run can no
    // longer catch via that check alone; hasTestRunSummary is what makes
    // this idempotent.
    expect(listTestRunResultsForRun('run-sweep-allpass')).toHaveLength(0);
    expect(hasTestRunSummary('run-sweep-allpass')).toBe(false);

    await sweepTestRunResultsExtraction();
    expect(hasTestRunSummary('run-sweep-allpass')).toBe(true);
    const durationsAfterFirstSweep = listRecentValidTestDurations('t1', 10);
    expect(durationsAfterFirstSweep).toEqual([5]);

    await sweepTestRunResultsExtraction();

    expect(listTestRunResultsForRun('run-sweep-allpass')).toHaveLength(0);
    expect(listRecentValidTestDurations('t1', 10)).toEqual([5]);
  });

  it("does not lose a superseded run's per-test data when its extraction was deferred past the run that superseded it", async () => {
    const structuredOld = JSON.stringify({
      suites: [
        {
          tests: [{ id: 't1', name: 'n', outcome: 'failed', durationMs: 5 }],
        },
      ],
    });
    // Simulates a run that completed and wrote structured_result but
    // crashed before its own ingestTestRunResults call — the extraction is
    // left for the boot sweep, same as recoverInterruptedTestRequestRuns'
    // scenario.
    insertTestRequestRun(
      'run-race-old',
      'proj-1',
      'hash-race',
      null,
      Date.now(),
    );
    completeTestRequestRun('run-race-old', 'passed', 'ok', null, structuredOld);
    expect(listTestRunResultsForRun('run-race-old')).toHaveLength(0);

    // A newer run for the same key completes before the sweep runs, and
    // clears every superseded row it can — but 'run-race-old' has not been
    // extracted (no test_run_summaries row) yet, so it must be skipped
    // rather than wiped.
    const structuredNew = JSON.stringify({
      suites: [
        {
          tests: [{ id: 't2', name: 'n2', outcome: 'failed', durationMs: 7 }],
        },
      ],
    });
    insertTestRequestRun(
      'run-race-new',
      'proj-1',
      'hash-race',
      null,
      Date.now() + 1,
    );
    completeTestRequestRun('run-race-new', 'passed', 'ok', null, structuredNew);
    clearSupersededStructuredResults('proj-1', 'hash-race', 'run-race-new');

    const oldRowMidRace = db
      .prepare(`SELECT structured_result FROM test_request_runs WHERE id = ?`)
      .get('run-race-old') as { structured_result: string | null };
    expect(oldRowMidRace.structured_result).toBe(structuredOld);

    // The sweep now extracts the deferred row, and only then retroactively
    // clears its structured_result since a newer run had already superseded
    // it.
    await sweepTestRunResultsExtraction();

    expect(listTestRunResultsForRun('run-race-old')).toHaveLength(1);
    const oldRowAfterSweep = db
      .prepare(`SELECT structured_result FROM test_request_runs WHERE id = ?`)
      .get('run-race-old') as { structured_result: string | null };
    expect(oldRowAfterSweep.structured_result).toBeNull();
  });

  it("clears a lone-key run's own structured_result once the sweep extracts it — the extraction-scoped clear that clearSupersededStructuredResults' supersession-scoped predicate can never reach for a key with only one run", async () => {
    const structured = JSON.stringify({
      suites: [
        {
          tests: [{ id: 't1', name: 'n', outcome: 'failed', durationMs: 5 }],
        },
      ],
    });
    insertTestRequestRun(
      'run-lonekey-sweep',
      'proj-1',
      'hash-lonekey-sweep',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-lonekey-sweep',
      'passed',
      'ok',
      null,
      structured,
    );

    await sweepTestRunResultsExtraction();

    expect(listTestRunResultsForRun('run-lonekey-sweep')).toHaveLength(1);
    const row = db
      .prepare(`SELECT structured_result FROM test_request_runs WHERE id = ?`)
      .get('run-lonekey-sweep') as { structured_result: string | null };
    expect(row.structured_result).toBeNull();
  });

  it('a run with no summary row (extraction produced zero tests, so no summary is written) retains its structured_result — the boot sweep must still have it as its only source', async () => {
    // Zero suites/tests: ingestTestRunResults's `tests.length === 0` early
    // return means no test_run_summaries row is ever written for this run —
    // the same "already extracted" guard clearExtractedStructuredResultsBatch
    // relies on must correctly read this as "not yet extracted", not clear it.
    const structured = JSON.stringify({ suites: [] });
    insertTestRequestRun(
      'run-unextracted',
      'proj-1',
      'hash-unextracted',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'run-unextracted',
      'passed',
      'ok',
      null,
      structured,
    );

    await sweepTestRunResultsExtraction();

    expect(hasTestRunSummary('run-unextracted')).toBe(false);
    const row = db
      .prepare(`SELECT structured_result FROM test_request_runs WHERE id = ?`)
      .get('run-unextracted') as { structured_result: string | null };
    expect(row.structured_result).toBe(structured);
  });

  function seedPendingRun(id: string, requestedAt: number): void {
    const structured = JSON.stringify({
      suites: [
        { tests: [{ id: 't1', name: 'n', outcome: 'failed', durationMs: 5 }] },
      ],
    });
    insertTestRequestRun(id, 'proj-1', `hash-${id}`, null, requestedAt);
    completeTestRequestRun(id, 'passed', 'ok', null, structured);
  }

  it('processes at most the configured cap and leaves the remainder pending, rather than draining the whole work list inline', async () => {
    for (let i = 0; i < 5; i++) {
      seedPendingRun(`run-cap-${i}`, Date.now() + i);
    }
    expect(countTestRequestRunsNeedingExtraction()).toBe(5);

    const result = await sweepTestRunResultsExtraction({ cap: 2 });

    expect(result.processed).toBe(2);
    expect(result.remaining).toBe(3);
    expect(countTestRequestRunsNeedingExtraction()).toBe(3);
  });

  it('a later capped call drains the remainder a bounded run left behind', async () => {
    for (let i = 0; i < 5; i++) {
      seedPendingRun(`run-drain-${i}`, Date.now() + i);
    }

    const first = await sweepTestRunResultsExtraction({ cap: 2 });
    expect(first.processed).toBe(2);
    expect(first.remaining).toBe(3);

    const second = await sweepTestRunResultsExtraction({ cap: 2 });
    expect(second.processed).toBe(2);
    expect(second.remaining).toBe(1);

    const third = await sweepTestRunResultsExtraction({ cap: 2 });
    expect(third.processed).toBe(1);
    expect(third.remaining).toBe(0);
  });

  it('reports progress with the remaining count in this batch after each unit of work', async () => {
    for (let i = 0; i < 3; i++) {
      seedPendingRun(`run-progress-${i}`, Date.now() + i);
    }
    const onProgress = vi.fn();

    await sweepTestRunResultsExtraction({ cap: 3, onProgress });

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls.map(([remaining]) => remaining)).toEqual([
      2, 1, 0,
    ]);
  });

  it('yields to the event loop between units of work — a macrotask scheduled mid-sweep runs before the sweep resolves', async () => {
    for (let i = 0; i < 3; i++) {
      seedPendingRun(`run-yield-${i}`, Date.now() + i);
    }
    const order: string[] = [];
    const onProgress = () => {
      order.push('sweep-progress');
      setImmediate(() => order.push('macrotask'));
    };

    await sweepTestRunResultsExtraction({ cap: 3, onProgress });

    // Every scheduled macrotask ran before the sweep's own await resolved —
    // if the sweep never yielded, all 'sweep-progress' entries would appear
    // before any 'macrotask' entry.
    expect(order).toEqual([
      'sweep-progress',
      'macrotask',
      'sweep-progress',
      'macrotask',
      'sweep-progress',
      'macrotask',
    ]);
  });
});

// ── computeTestPerfBaseline — rolling per-test median/MAD baseline ─────────

describe('computeTestPerfBaseline', () => {
  it('excludes concurrent/OOM-marked samples from the baseline', () => {
    const testId = 'baseline-excludes-invalid';
    for (let i = 0; i < 10; i++)
      insertSample(testId, 100, { concurrentRunCount: 0 });
    // Invalid samples with wildly different durations must not move the
    // median/MAD at all.
    insertSample(testId, 9999, { concurrentRunCount: 2 });
    insertSample(testId, 1, { concurrentRunCount: 0, oomKilled: true });

    computeTestPerfBaseline(testId);

    const baseline = getTestPerfBaseline(testId)!;
    expect(baseline.median_duration_ms).toBe(100);
    expect(baseline.mad_duration_ms).toBe(0);
    expect(baseline.sample_count).toBe(7); // 10 valid samples minus the 3-sample recent window
  });

  it('does not flag a regression from a single noisy sample', () => {
    const testId = 'single-noisy-sample';
    for (let i = 0; i < 12; i++)
      insertSample(testId, 100, { concurrentRunCount: 0 });
    insertSample(testId, 100, { concurrentRunCount: 0 });
    insertSample(testId, 100, { concurrentRunCount: 0 });
    insertSample(testId, 1000, { concurrentRunCount: 0 }); // one noisy outlier as the most recent sample

    computeTestPerfBaseline(testId);

    const baseline = getTestPerfBaseline(testId)!;
    expect(baseline.is_regressed).toBe(0);
    expect(baseline.last_duration_ms).toBe(1000);
  });

  it('flags a regression from a sustained duration shift across the minimum consecutive run', () => {
    const testId = 'sustained-shift';
    for (let i = 0; i < 15; i++)
      insertSample(testId, 100, { concurrentRunCount: 0 });
    insertSample(testId, 500, { concurrentRunCount: 0 });
    insertSample(testId, 500, { concurrentRunCount: 0 });
    insertSample(testId, 500, { concurrentRunCount: 0 });

    computeTestPerfBaseline(testId);

    const baseline = getTestPerfBaseline(testId)!;
    expect(baseline.is_regressed).toBe(1);
    expect(baseline.median_duration_ms).toBe(100);
  });

  it('persists the per-test aggregate, overwriting the previous baseline rather than appending', () => {
    const testId = 'persists-aggregate';
    for (let i = 0; i < 10; i++)
      insertSample(testId, 50, { concurrentRunCount: 0 });

    computeTestPerfBaseline(testId);
    const first = getTestPerfBaseline(testId)!;
    expect(first.sample_count).toBeGreaterThan(0);

    insertSample(testId, 60, { concurrentRunCount: 0 });
    computeTestPerfBaseline(testId);

    const rows = db
      .prepare('SELECT * FROM test_perf_baselines WHERE test_id = ?')
      .all(testId);
    expect(rows).toHaveLength(1);
    const second = getTestPerfBaseline(testId)!;
    expect(second.last_duration_ms).toBe(60);
  });

  it('is a no-op when there are no valid samples for the test', () => {
    computeTestPerfBaseline('never-seen-test');
    expect(getTestPerfBaseline('never-seen-test')).toBeUndefined();
  });
});

describe('ingestTestRunResults — inline baseline recomputation', () => {
  it('recomputes the per-test baseline for every test_id touched by the extracted run', () => {
    const structured = JSON.stringify({
      suites: [
        {
          tests: [
            { id: 'inline-t1', name: 'n1', outcome: 'passed', durationMs: 42 },
          ],
        },
      ],
    });
    insertTestRequestRun(
      'run-inline-baseline',
      'proj-1',
      'hash-inline-baseline',
      null,
      Date.now(),
      0,
    );
    completeTestRequestRun(
      'run-inline-baseline',
      'passed',
      'ok',
      null,
      structured,
    );

    const run = getLatestTestRequestRun('proj-1', 'hash-inline-baseline')!;
    ingestTestRunResults(run);

    const baseline = getTestPerfBaseline('inline-t1');
    expect(baseline).toBeDefined();
    expect(baseline!.last_duration_ms).toBe(42);
  });
});

// ── test_perf_baselines digest — fixed-width outcome/duration rings ────────

describe('test_perf_baselines digest', () => {
  it('excludes samples with concurrent_run_count != 0 or oom_killed = 1 from both the outcome sequence and the duration ring', () => {
    const testId = 'digest-excludes-invalid';
    insertOutcomeSample(testId, 'passed', 100, { concurrentRunCount: 0 });
    insertOutcomeSample(testId, 'failed', 200, { concurrentRunCount: 1 }); // excluded — concurrent peer
    insertOutcomeSample(testId, 'failed', 300, {
      concurrentRunCount: 0,
      oomKilled: true,
    }); // excluded — oom-killed
    insertOutcomeSample(testId, 'passed', 400, { concurrentRunCount: 0 });

    expect(listRecentValidTestDurations(testId, 10)).toEqual([400, 100]);
    const flag = computeTestFlipRateFlag(testId, 10, 1);
    expect(flag.sampleCount).toBe(2);
    expect(flag.transitionCount).toBe(0); // both retained samples are 'passed'
  });

  it('matches the transition count a raw-row scan over the same synthetic sequence would produce, including a run that alternates pass/fail every run', () => {
    const testId = 'digest-transition-parity';
    const outcomes: Array<'passed' | 'failed'> = [
      'passed',
      'failed',
      'passed',
      'failed',
      'passed',
      'failed',
    ];
    outcomes.forEach((outcome) =>
      insertOutcomeSample(testId, outcome, 10, { concurrentRunCount: 0 }),
    );

    let expectedTransitions = 0;
    for (let i = 1; i < outcomes.length; i++) {
      if (outcomes[i] !== outcomes[i - 1]) expectedTransitions++;
    }

    const flag = computeTestFlipRateFlag(testId, outcomes.length, 2);
    expect(flag.sampleCount).toBe(outcomes.length);
    expect(flag.transitionCount).toBe(expectedTransitions);
    expect(flag.transitionCount).toBe(outcomes.length - 1); // alternates every run
    expect(flag.flagged).toBe(true);
  });

  it('the retained outcome sequence is fixed-width — ingesting past TEST_OUTCOME_DIGEST_CAPACITY does not grow the stored value', () => {
    const testId = 'digest-outcome-fixed-width';
    const overflow = TEST_OUTCOME_DIGEST_CAPACITY + 25;
    for (let i = 0; i < overflow; i++) {
      insertOutcomeSample(testId, i % 2 === 0 ? 'passed' : 'failed', 1, {
        concurrentRunCount: 0,
      });
    }

    const row = db
      .prepare(
        `SELECT recent_outcomes FROM test_perf_baselines WHERE test_id = ?`,
      )
      .get(testId) as { recent_outcomes: string };
    const outcomes = JSON.parse(row.recent_outcomes) as unknown[];
    expect(outcomes.length).toBe(TEST_OUTCOME_DIGEST_CAPACITY);

    // The window requested at the digest's own cap must still be fully served.
    const flag = computeTestFlipRateFlag(
      testId,
      TEST_OUTCOME_DIGEST_CAPACITY,
      1,
    );
    expect(flag.sampleCount).toBe(TEST_OUTCOME_DIGEST_CAPACITY);
  });

  it('the retained duration ring is fixed-width — ingesting past TEST_DURATION_DIGEST_CAPACITY does not grow the stored value', () => {
    const testId = 'digest-duration-fixed-width';
    const overflow = TEST_DURATION_DIGEST_CAPACITY + 25;
    for (let i = 0; i < overflow; i++) {
      insertSample(testId, i, { concurrentRunCount: 0 });
    }

    const row = db
      .prepare(
        `SELECT recent_durations FROM test_perf_baselines WHERE test_id = ?`,
      )
      .get(testId) as { recent_durations: string };
    const durations = JSON.parse(row.recent_durations) as unknown[];
    expect(durations.length).toBe(TEST_DURATION_DIGEST_CAPACITY);

    const window = listRecentValidTestDurations(
      testId,
      TEST_DURATION_DIGEST_CAPACITY,
    );
    expect(window).toHaveLength(TEST_DURATION_DIGEST_CAPACITY);
    // Newest-first: the very last ingested sample (overflow - 1) leads.
    expect(window[0]).toBe(overflow - 1);
  });

  it('listRecentValidTestDurations/upsertTestPerfBaseline compute the same median and MAD from the retained window when more runs were ingested than the window retains', () => {
    const testId = 'digest-median-mad-window';
    // 30 old samples at 1000ms (well outside the baseline window), then 23
    // recent valid samples at 100ms — BASELINE_WINDOW_SAMPLES (20) +
    // MIN_CONSECUTIVE_REGRESSED_SAMPLES (3).
    for (let i = 0; i < 30; i++) {
      insertSample(testId, 1000, { concurrentRunCount: 0 });
    }
    for (let i = 0; i < 23; i++) {
      insertSample(testId, 100, { concurrentRunCount: 0 });
    }

    computeTestPerfBaseline(testId);

    const baseline = getTestPerfBaseline(testId)!;
    // The 1000ms samples must have aged fully out of the window — the
    // median/MAD reflect only the 100ms samples.
    expect(baseline.median_duration_ms).toBe(100);
    expect(baseline.mad_duration_ms).toBe(0);
    expect(baseline.sample_count).toBe(20);
  });
});
