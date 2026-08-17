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
  listRunningTestRequestRuns,
  getLatestTestRequestRun,
  listTestRunResultsForRun,
  insertTestRunResults,
  getTestPerfBaseline,
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
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM test_perf_baselines').run();
});

let sampleSeq = 0;

/** Inserts one test_run_results row (with a backing test_request_runs row for the FK) for a given test_id/duration/validity. */
function insertSample(
  testId: string,
  durationMs: number,
  opts: { concurrentRunCount?: number; oomKilled?: boolean } = {},
): void {
  const runId = `perf-run-${testId}-${sampleSeq++}`;
  insertTestRequestRun(runId, 'proj-1', `perf-hash-${runId}`, null, Date.now());
  insertTestRunResults(
    runId,
    [
      {
        test_id: testId,
        name: testId,
        outcome: 'passed',
        duration_ms: durationMs,
      },
    ],
    opts.concurrentRunCount ?? 0,
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
  it("reflects the per-project Semaphore's actual occupancy under concurrent test.request calls", async () => {
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
    // so each recorded occupancy must fall within [1, 2] — and since both
    // were in flight together, the true concurrent occupancy of 2 must have
    // been observed by at least one of them.
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(2);
    }
    expect(Math.max(...counts)).toBe(2);
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

  it('clears a superseded run\'s structured_result once a newer run lands for the same (project, content-hash), leaving its other columns and test_run_results extraction untouched', async () => {
    const structuredFirst = {
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
    mockLoadOrchestratorConfig.mockReturnValue({
      test_report_glob: 'reports/*.xml',
    });

    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'first ok' });
    mockCollectStructuredTestResult.mockReturnValue(structuredFirst);
    const first = await runProjectTestRequest(
      baseSpec({ contentHash: 'hash-supersede' }),
    );

    const firstRowBefore = db
      .prepare(
        `SELECT structured_result FROM test_request_runs WHERE id = ?`,
      )
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
            { id: 't1', name: 'test one', outcome: 'passed', durationMs: 12 },
          ],
        },
      ],
    };
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'second ok' });
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
      .prepare(
        `SELECT structured_result FROM test_request_runs WHERE id = ?`,
      )
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
  it('produces one row per test with correct outcome/duration, carrying the run validity signals', () => {
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
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      test_id: 't1',
      name: 'test one',
      outcome: 'passed',
      duration_ms: 12,
      concurrent_run_count: 2,
      oom_killed: 1,
    });
    expect(rows[1]).toMatchObject({
      test_id: 't2',
      name: 'test two',
      outcome: 'failed',
      duration_ms: 34,
    });
  });

  it('is idempotent — calling it twice does not duplicate rows', () => {
    const structured = JSON.stringify({
      suites: [
        { tests: [{ id: 't1', name: 'n', outcome: 'passed', durationMs: 1 }] },
      ],
    });
    insertTestRequestRun(
      'run-extract-2',
      'proj-1',
      'hash-extract-2',
      null,
      Date.now(),
    );
    completeTestRequestRun('run-extract-2', 'passed', 'ok', null, structured);

    const run = getLatestTestRequestRun('proj-1', 'hash-extract-2')!;
    ingestTestRunResults(run);
    ingestTestRunResults(run);

    expect(listTestRunResultsForRun('run-extract-2')).toHaveLength(1);
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
  });
});

describe('sweepTestRunResultsExtraction', () => {
  it('catches a row with structured_result set but no test_run_results rows', () => {
    const structured = JSON.stringify({
      suites: [
        {
          tests: [{ id: 't1', name: 'n', outcome: 'passed', durationMs: 5 }],
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

    sweepTestRunResultsExtraction();

    expect(listTestRunResultsForRun('run-sweep-1')).toHaveLength(1);
  });

  it('leaves an already-extracted run untouched', () => {
    const structured = JSON.stringify({
      suites: [
        {
          tests: [{ id: 't1', name: 'n', outcome: 'passed', durationMs: 5 }],
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
    sweepTestRunResultsExtraction();
    expect(listTestRunResultsForRun('run-sweep-2')).toHaveLength(1);

    sweepTestRunResultsExtraction();

    expect(listTestRunResultsForRun('run-sweep-2')).toHaveLength(1);
  });
});

// ── computeTestPerfBaseline — rolling per-test median/MAD baseline ─────────

describe('computeTestPerfBaseline', () => {
  it('excludes concurrent/OOM-marked samples from the baseline', () => {
    const testId = 'baseline-excludes-invalid';
    for (let i = 0; i < 10; i++) insertSample(testId, 100);
    // Invalid samples with wildly different durations must not move the
    // median/MAD at all.
    insertSample(testId, 9999, { concurrentRunCount: 2 });
    insertSample(testId, 1, { oomKilled: true });

    computeTestPerfBaseline(testId);

    const baseline = getTestPerfBaseline(testId)!;
    expect(baseline.median_duration_ms).toBe(100);
    expect(baseline.mad_duration_ms).toBe(0);
    expect(baseline.sample_count).toBe(7); // 10 valid samples minus the 3-sample recent window
  });

  it('does not flag a regression from a single noisy sample', () => {
    const testId = 'single-noisy-sample';
    for (let i = 0; i < 12; i++) insertSample(testId, 100);
    insertSample(testId, 100);
    insertSample(testId, 100);
    insertSample(testId, 1000); // one noisy outlier as the most recent sample

    computeTestPerfBaseline(testId);

    const baseline = getTestPerfBaseline(testId)!;
    expect(baseline.is_regressed).toBe(0);
    expect(baseline.last_duration_ms).toBe(1000);
  });

  it('flags a regression from a sustained duration shift across the minimum consecutive run', () => {
    const testId = 'sustained-shift';
    for (let i = 0; i < 15; i++) insertSample(testId, 100);
    insertSample(testId, 500);
    insertSample(testId, 500);
    insertSample(testId, 500);

    computeTestPerfBaseline(testId);

    const baseline = getTestPerfBaseline(testId)!;
    expect(baseline.is_regressed).toBe(1);
    expect(baseline.median_duration_ms).toBe(100);
  });

  it('persists the per-test aggregate, overwriting the previous baseline rather than appending', () => {
    const testId = 'persists-aggregate';
    for (let i = 0; i < 10; i++) insertSample(testId, 50);

    computeTestPerfBaseline(testId);
    const first = getTestPerfBaseline(testId)!;
    expect(first.sample_count).toBeGreaterThan(0);

    insertSample(testId, 60);
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
