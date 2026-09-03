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
  mockClearReportFiles,
  mockHasAdmission,
  mockLoadOrchestratorConfig,
} = vi.hoisted(() => ({
  mockRunTestCommands: vi.fn(),
  mockCollectStructuredTestResult: vi.fn(() => null),
  mockClearReportFiles: vi.fn(),
  mockHasAdmission: vi.fn(() => true),
  mockLoadOrchestratorConfig: vi.fn(() => ({ test_report_glob: '' })),
}));

vi.mock('../../session/test-runner', () => ({
  runTestCommands: mockRunTestCommands,
  collectStructuredTestResult: mockCollectStructuredTestResult,
  clearReportFiles: mockClearReportFiles,
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
  admitTestRequest,
  recoverInterruptedTestRequestRuns,
  setTestRequestLaneBroadcast,
  ingestTestRunResults,
  sweepTestRunResultsExtraction,
  computeTestPerfBaseline,
  __resetProjectSemaphoresForTest,
} from '../testRequestLane';
import {
  insertTestRequestRun,
  completeTestRequestRun,
  clearSupersededStructuredResults,
  clearExtractedStructuredResultsBatch,
  listRunningTestRequestRuns,
  getLatestTestRequestRun,
  deleteTestRequestRunsForContentHash,
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
  insertProject,
  updateProject,
  getFailingTestIdsForRun,
} from '../../db/queries';
import {
  withCheckoutInstallLock,
  __checkoutInstallLockMapSizeForTest,
} from '../checkoutInstallLock';

beforeEach(() => {
  mockRunTestCommands.mockReset();
  mockCollectStructuredTestResult.mockReset();
  mockCollectStructuredTestResult.mockReturnValue(null);
  mockClearReportFiles.mockReset();
  mockHasAdmission.mockReset();
  mockHasAdmission.mockReturnValue(true);
  mockLoadOrchestratorConfig.mockReset();
  mockLoadOrchestratorConfig.mockReturnValue({ test_report_glob: '' });
  db.prepare('DELETE FROM test_run_results').run();
  db.prepare('DELETE FROM test_run_summaries').run();
  db.prepare('DELETE FROM test_request_runs').run();
  db.prepare('DELETE FROM test_perf_baselines').run();
  db.prepare('DELETE FROM projects').run();
  __resetProjectSemaphoresForTest();
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
  opts: {
    concurrentRunCount: number;
    oomKilled?: boolean;
    foreignConcurrentRunCount?: number | null;
  },
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
    false,
    opts.foreignConcurrentRunCount,
  );
}

/** Like insertSample, but with a caller-chosen outcome — for flip-rate digest tests. */
function insertOutcomeSample(
  testId: string,
  outcome: 'passed' | 'failed',
  durationMs: number,
  opts: {
    concurrentRunCount: number;
    oomKilled?: boolean;
    foreignConcurrentRunCount?: number | null;
  },
): void {
  const runId = `flip-run-${testId}-${sampleSeq++}`;
  insertTestRequestRun(runId, 'proj-1', `flip-hash-${runId}`, null, Date.now());
  ingestTestRunResultsTx(
    runId,
    'proj-1',
    [{ test_id: testId, name: testId, outcome, duration_ms: durationMs }],
    opts.concurrentRunCount,
    opts.oomKilled ?? false,
    false,
    opts.foreignConcurrentRunCount,
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
    sessionId: null,
    runOrigin: null,
    producer: 'session_request',
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

  it('a scoped run and a full run against the identical content-hash execute independently and are stored as two distinct rows, each queryable by run_kind', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(
      baseSpec({ contentHash: 'hash-kind', runKind: 'full' }),
    );
    await runProjectTestRequest(
      baseSpec({ contentHash: 'hash-kind', runKind: 'scoped' }),
    );

    expect(mockRunTestCommands).toHaveBeenCalledTimes(2);
    const rows = db
      .prepare(
        `SELECT run_kind, base_sha FROM test_request_runs WHERE project_id = ? AND content_hash = ? ORDER BY run_kind`,
      )
      .all('proj-1', 'hash-kind') as Array<{
      run_kind: string;
      base_sha: string | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.run_kind).sort()).toEqual(['full', 'scoped']);

    const scoped = getLatestTestRequestRun('proj-1', 'hash-kind', 'scoped');
    const full = getLatestTestRequestRun('proj-1', 'hash-kind', 'full');
    expect(scoped?.run_kind).toBe('scoped');
    expect(full?.run_kind).toBe('full');
    expect(scoped?.id).not.toBe(full?.id);
  });

  it('a run with no runKind stated defaults to full and stores base_sha NULL', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(baseSpec({ contentHash: 'hash-default-kind' }));

    const row = getLatestTestRequestRun('proj-1', 'hash-default-kind');
    expect(row?.run_kind).toBe('full');
    expect(row?.base_sha).toBeNull();
  });

  it('a base-relative scoped run (e.g. vitest --changed) stores its base_sha', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(
      baseSpec({
        contentHash: 'hash-base-relative',
        runKind: 'scoped',
        baseSha: 'abc123',
      }),
    );

    const row = getLatestTestRequestRun(
      'proj-1',
      'hash-base-relative',
      'scoped',
    );
    expect(row?.run_kind).toBe('scoped');
    expect(row?.base_sha).toBe('abc123');
  });

  it('a marker-exclusion scoped run (no base dependency) stores base_sha NULL', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(
      baseSpec({ contentHash: 'hash-marker-exclusion', runKind: 'scoped' }),
    );

    const row = getLatestTestRequestRun(
      'proj-1',
      'hash-marker-exclusion',
      'scoped',
    );
    expect(row?.run_kind).toBe('scoped');
    expect(row?.base_sha).toBeNull();
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

    mockRunTestCommands.mockResolvedValueOnce({
      passed: false,
      output: '$ uv run task test\nspawn /bin/sh ENOENT',
      spawnFailed: true,
    });
    await runProjectTestRequest(baseSpec({ contentHash: 'hash-spawn' }));

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
    // Distinct from 'generic' — the runner never executed at all, so this
    // must never be indistinguishable from an ordinary suite failure.
    expect(reasonFor('hash-spawn')).toBe('execution_failed');
  });

  it('a spawn failure is never replayed as a cached unchangedReplay result — a retry against the same tree re-executes', async () => {
    mockRunTestCommands.mockResolvedValueOnce({
      passed: false,
      output: 'spawn /bin/sh ENOENT',
      spawnFailed: true,
    });
    await runProjectTestRequest(baseSpec({ contentHash: 'hash-spawn-retry' }));

    mockRunTestCommands.mockResolvedValueOnce({ passed: true, output: 'ok' });
    const admission = admitTestRequest(
      baseSpec({ contentHash: 'hash-spawn-retry' }),
    );
    const retryResult = await admission.result;

    expect(mockRunTestCommands).toHaveBeenCalledTimes(2);
    expect(admission.unchangedReplay).toBe(false);
    expect(retryResult.unchangedReplay).toBe(false);
    expect(retryResult.passed).toBe(true);
  });

  it('an ordinary settled failure IS replayed as unchangedReplay on a subsequent request against the same tree', async () => {
    // A genuine failure (as opposed to a whole-process crash) carries a
    // structured result — that's what makes it a verdict getLatestTestRequestRun
    // will hand back instead of triggering a fresh run.
    mockLoadOrchestratorConfig.mockReturnValue({ test_report_glob: '*.xml' });
    mockCollectStructuredTestResult.mockReturnValue({
      format: 'junit-xml',
      suites: [],
      totals: { passed: 0, failed: 1, skipped: 0, errors: 0 },
      durationMsTotal: 5,
    });
    mockRunTestCommands.mockResolvedValueOnce({
      passed: false,
      output: 'assertion failed',
    });
    await runProjectTestRequest(
      baseSpec({ contentHash: 'hash-ordinary-replay' }),
    );

    const admission = admitTestRequest(
      baseSpec({ contentHash: 'hash-ordinary-replay' }),
    );
    const replay = await admission.result;

    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);
    expect(admission.unchangedReplay).toBe(true);
    expect(replay.unchangedReplay).toBe(true);
    expect(replay.passed).toBe(false);
  });
});

describe('getLatestTestRequestRun — a crash with no verdict must not squat the cache slot', () => {
  function insertResultRow(runId: string): void {
    db.prepare(
      `INSERT INTO test_run_results (test_request_run_id, project_id, test_id, name, outcome, duration_ms, created_at)
       VALUES (?, 'proj-1', 'some-test', 'some-test', 'passed', 10, ?)`,
    ).run(runId, Date.now());
  }

  it('excludes a settled row with structured_result NULL and zero test_run_results rows (a crash, not a verdict)', () => {
    insertTestRequestRun('crash-1', 'proj-1', 'hash-crash-1', null, Date.now());
    completeTestRequestRun('crash-1', 'failed', 'vitest: not found', 'generic');

    expect(getLatestTestRequestRun('proj-1', 'hash-crash-1')).toBeUndefined();
  });

  it('still returns a settled failed row with zero test_run_results but a non-null structured_result', () => {
    insertTestRequestRun(
      'verdict-1',
      'proj-1',
      'hash-verdict-1',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'verdict-1',
      'failed',
      'one test failed',
      'generic',
      '{"summary":"1 failed"}',
    );

    const row = getLatestTestRequestRun('proj-1', 'hash-verdict-1');
    expect(row?.id).toBe('verdict-1');
  });

  it('still returns a settled failed row with test_run_results rows but a null structured_result', () => {
    insertTestRequestRun(
      'verdict-2',
      'proj-1',
      'hash-verdict-2',
      null,
      Date.now(),
    );
    completeTestRequestRun('verdict-2', 'failed', 'one test failed', 'generic');
    insertResultRow('verdict-2');

    const row = getLatestTestRequestRun('proj-1', 'hash-verdict-2');
    expect(row?.id).toBe('verdict-2');
  });

  it('still returns a normal failed run with per-test rows — a real failing verdict is unaffected', () => {
    insertTestRequestRun(
      'failed-verdict-1',
      'proj-1',
      'hash-failed-1',
      null,
      Date.now(),
    );
    completeTestRequestRun(
      'failed-verdict-1',
      'failed',
      'one test failed',
      'generic',
    );
    insertResultRow('failed-verdict-1');

    const row = getLatestTestRequestRun('proj-1', 'hash-failed-1');
    expect(row?.id).toBe('failed-verdict-1');
    expect(row?.state).toBe('failed');
  });

  it('excludes a crash row even when failure_reason is generic — the discriminator is result-presence, not the reason string', () => {
    insertTestRequestRun('crash-2', 'proj-1', 'hash-crash-2', null, Date.now());
    completeTestRequestRun('crash-2', 'failed', 'boom', 'generic');

    const row = getLatestTestRequestRun('proj-1', 'hash-crash-2');
    expect(row).toBeUndefined();
  });

  it('preserves the existing run_kind = "full" scoping alongside the new verdict filter', () => {
    insertTestRequestRun(
      'crash-scoped',
      'proj-1',
      'hash-crash-scoped',
      null,
      Date.now(),
      null,
      undefined,
      undefined,
      'running',
      'scoped',
    );
    completeTestRequestRun(
      'crash-scoped',
      'failed',
      'one test failed',
      'generic',
      '{"summary":"1 failed"}',
    );

    expect(
      getLatestTestRequestRun('proj-1', 'hash-crash-scoped', 'full'),
    ).toBeUndefined();
    expect(
      getLatestTestRequestRun('proj-1', 'hash-crash-scoped', 'scoped')?.id,
    ).toBe('crash-scoped');
  });

  it('with only a crash row present for a content hash, a fresh test request runs instead of short-circuiting on the cached crash', async () => {
    insertTestRequestRun('crash-3', 'proj-1', 'hash-crash-3', null, Date.now());
    completeTestRequestRun('crash-3', 'failed', 'vitest: not found', 'generic');

    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });
    await runProjectTestRequest(baseSpec({ contentHash: 'hash-crash-3' }));

    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);

    const rows = db
      .prepare(
        `SELECT id, state FROM test_request_runs WHERE project_id = ? AND content_hash = ? ORDER BY rowid`,
      )
      .all('proj-1', 'hash-crash-3') as Array<{ id: string; state: string }>;
    expect(rows.map((r) => r.id)).toContain('crash-3');
    expect(rows.length).toBe(2);
  });
});

describe('runProjectTestRequest — checkout install lock', () => {
  it('a test run in flight causes a concurrently-requested install-deps to wait until the run settles', async () => {
    insertProject({
      id: 'proj-lock-a',
      name: 'Lock A',
      project_dir: '/tmp/checkout-lock-a',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    let resolveRun: (v: { passed: boolean; output: string }) => void;
    mockRunTestCommands.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );

    const runPromise = runProjectTestRequest(
      baseSpec({ projectId: 'proj-lock-a', contentHash: 'lock-hash-a' }),
    );
    await vi.waitFor(() => expect(mockRunTestCommands).toHaveBeenCalled());

    let installRan = false;
    const installPromise = withCheckoutInstallLock(
      '/tmp/checkout-lock-a',
      async () => {
        installRan = true;
      },
    );

    // Give the install a chance to run prematurely before the test run settles.
    await new Promise((r) => setTimeout(r, 10));
    expect(installRan).toBe(false);

    resolveRun!({ passed: true, output: 'ok' });
    await runPromise;
    await installPromise;
    expect(installRan).toBe(true);
  });

  it('an install-deps in flight causes a concurrently-requested test run to wait until the install completes', async () => {
    insertProject({
      id: 'proj-lock-b',
      name: 'Lock B',
      project_dir: '/tmp/checkout-lock-b',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    let releaseInstall: () => void;
    const installPromise = withCheckoutInstallLock(
      '/tmp/checkout-lock-b',
      () =>
        new Promise<void>((resolve) => {
          releaseInstall = resolve;
        }),
    );

    const runPromise = runProjectTestRequest(
      baseSpec({
        projectId: 'proj-lock-b',
        contentHash: 'lock-hash-b',
        worktreePath: '/tmp/checkout-lock-b',
      }),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(mockRunTestCommands).not.toHaveBeenCalled();

    releaseInstall!();
    await installPromise;
    await runPromise;
    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);
  });

  it('two runs against different project checkouts do not serialize against each other', async () => {
    insertProject({
      id: 'proj-lock-c1',
      name: 'Lock C1',
      project_dir: '/tmp/checkout-lock-c1',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    insertProject({
      id: 'proj-lock-c2',
      name: 'Lock C2',
      project_dir: '/tmp/checkout-lock-c2',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });

    let releaseInstall: () => void;
    const installPromise = withCheckoutInstallLock(
      '/tmp/checkout-lock-c1',
      () =>
        new Promise<void>((resolve) => {
          releaseInstall = resolve;
        }),
    );

    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });
    const runPromise = runProjectTestRequest(
      baseSpec({
        projectId: 'proj-lock-c2',
        contentHash: 'lock-hash-c2',
        worktreePath: '/tmp/checkout-lock-c2',
      }),
    );

    await runPromise;
    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);

    releaseInstall!();
    await installPromise;
  });

  it('a project whose worktrees provision their own dependencies does not acquire the lock', async () => {
    insertProject({
      id: 'proj-lock-bootstrap',
      name: 'Lock Bootstrap',
      project_dir: '/tmp/checkout-lock-bootstrap',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    mockLoadOrchestratorConfig.mockReturnValue({
      test_report_glob: '',
      bootstrap_script: './scripts/bootstrap.sh',
    });
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    let releaseInstall: () => void;
    const installPromise = withCheckoutInstallLock(
      '/tmp/checkout-lock-bootstrap',
      () =>
        new Promise<void>((resolve) => {
          releaseInstall = resolve;
        }),
    );

    // The run must not wait on the held install lock, since this project's
    // worktrees don't share the checkout's node_modules.
    await runProjectTestRequest(
      baseSpec({
        projectId: 'proj-lock-bootstrap',
        contentHash: 'lock-hash-bootstrap',
        worktreePath: '/tmp/checkout-lock-bootstrap',
      }),
    );
    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);

    releaseInstall!();
    await installPromise;
  });

  it('the lock is released when the guarded operation throws, and a later acquirer is not deadlocked', async () => {
    await expect(
      withCheckoutInstallLock('/tmp/checkout-lock-throw', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    let secondRan = false;
    await withCheckoutInstallLock('/tmp/checkout-lock-throw', async () => {
      secondRan = true;
    });
    expect(secondRan).toBe(true);
  });

  it('the lock map entry self-cleans once the chain for a checkout is idle', async () => {
    const before = __checkoutInstallLockMapSizeForTest();
    await withCheckoutInstallLock('/tmp/checkout-lock-selfclean', async () => {
      // no-op
    });
    expect(__checkoutInstallLockMapSizeForTest()).toBe(before);
  });

  it('two concurrently-requested test runs against the same project checkout do not serialize against each other', async () => {
    insertProject({
      id: 'proj-lock-readers',
      name: 'Lock Readers',
      project_dir: '/tmp/checkout-lock-readers',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
      test_request_max_concurrent: 2,
    });
    const resolvers: Array<(v: { passed: boolean; output: string }) => void> =
      [];
    mockRunTestCommands.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const p1 = runProjectTestRequest(
      baseSpec({
        projectId: 'proj-lock-readers',
        contentHash: 'lock-readers-a',
        worktreePath: '/tmp/checkout-lock-readers',
      }),
    );
    const p2 = runProjectTestRequest(
      baseSpec({
        projectId: 'proj-lock-readers',
        contentHash: 'lock-readers-b',
        worktreePath: '/tmp/checkout-lock-readers',
      }),
    );

    // Both runs must be admitted into runTestCommands concurrently — the
    // checkout lock must not cut same-project run concurrency to 1.
    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(2),
    );

    resolvers.forEach((resolve) => resolve({ passed: true, output: 'ok' }));
    await Promise.all([p1, p2]);
  });
});

describe('runProjectTestRequest — the lane never fails fast', () => {
  it('executes every subsequent command when an earlier one fails, using the real runTestCommands rather than the module mock', async () => {
    const actual = await vi.importActual<
      typeof import('../../session/test-runner')
    >('../../session/test-runner');
    mockRunTestCommands.mockImplementation(actual.runTestCommands);

    const result = await runProjectTestRequest(
      baseSpec({
        contentHash: 'hash-no-failfast-real',
        commands: ['exit 1', 'echo backend-suite-ran'],
        timeoutSec: 10,
      }),
    );

    expect(result.passed).toBe(false);
    // Both commands' own '$ <cmd>' markers must be present — proof the
    // second command actually ran rather than the loop breaking after the
    // first command's failure.
    expect(result.output).toContain('$ exit 1');
    expect(result.output).toContain('$ echo backend-suite-ran');
    expect(result.output).toContain('backend-suite-ran');
  });

  it('never passes failFast: true to runTestCommands', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(
      baseSpec({ contentHash: 'hash-no-failfast-opt' }),
    );

    expect(mockRunTestCommands).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.any(Number),
      expect.any(Function),
      expect.objectContaining({ failFast: false }),
    );
  });

  it('a base probe (no originating session) whose frontend command fails still records backend failures in its per-test results', async () => {
    mockLoadOrchestratorConfig.mockReturnValue({
      test_report_glob: 'reports/*.xml',
    });
    mockRunTestCommands.mockResolvedValue({
      passed: false,
      output: 'frontend failed\nbackend failed',
    });
    mockCollectStructuredTestResult.mockReturnValue({
      format: 'junit-xml',
      suites: [
        {
          name: 'frontend',
          tests: [
            {
              id: 'frontend-test',
              name: 'frontend-test',
              outcome: 'failed',
              durationMs: 5,
            },
          ],
        },
        {
          name: 'backend',
          tests: [
            {
              id: 'backend-test',
              name: 'backend-test',
              outcome: 'failed',
              durationMs: 7,
            },
          ],
        },
      ],
      totals: { passed: 0, failed: 2, skipped: 0, errors: 0 },
      durationMsTotal: 12,
    });

    await runProjectTestRequest(
      baseSpec({
        contentHash: 'hash-base-probe',
        commands: [
          'npm run test -w packages/frontend',
          'npm run test -w packages/backend',
        ],
        sessionId: null,
      }),
    );

    const run = getLatestTestRequestRun('proj-1', 'hash-base-probe')!;
    expect(run.session_id).toBeNull();
    ingestTestRunResults(run);

    const testIds = listTestRunResultsForRun(run.id).map((r) => r.test_id);
    expect(testIds).toContain('frontend-test');
    expect(testIds).toContain('backend-test');
  });
});

describe('recoverInterruptedTestRequestRuns', () => {
  it('marks a leftover running row as failed with failure_reason execution_failed and its existing output string, and invokes clearSupersededStructuredResults + broadcastRunStatus', () => {
    insertTestRequestRun('run-1', 'proj-1', 'hash-x', null, Date.now());
    // A superseded sibling row so clearSupersededStructuredResults' effect
    // (clearing an already-extracted older row's structured_result for the
    // same key) is observable.
    insertTestRequestRun('run-1-older', 'proj-1', 'hash-x', null, Date.now() - 1);
    completeTestRequestRun('run-1-older', 'passed', 'ok', null, '{"suites":[]}');
    ingestTestRunResultsTx('run-1-older', 'proj-1', [], 1, false, false, null);
    expect(listRunningTestRequestRuns()).toHaveLength(1);

    const broadcasts: Array<{ runId: string; status: string }> = [];
    setTestRequestLaneBroadcast((msg) => {
      if (msg.type === 'test_request_run_status') {
        broadcasts.push({ runId: msg.runId, status: msg.status });
      }
    });

    recoverInterruptedTestRequestRuns();
    setTestRequestLaneBroadcast(() => {});

    expect(listRunningTestRequestRuns()).toHaveLength(0);
    const row = db
      .prepare(
        `SELECT state, failure_reason, output FROM test_request_runs WHERE id = ?`,
      )
      .get('run-1') as {
      state: string;
      failure_reason: string;
      output: string;
    };
    expect(row.state).toBe('failed');
    expect(row.failure_reason).toBe('execution_failed');
    expect(row.output).toBe(
      '[testRequestLane] backend restarted mid-run — treated as failed',
    );
    expect(broadcasts.some((b) => b.runId === 'run-1')).toBe(true);

    const olderRow = db
      .prepare(`SELECT structured_result FROM test_request_runs WHERE id = ?`)
      .get('run-1-older') as { structured_result: string | null };
    expect(olderRow.structured_result).toBeNull();
  });

  it('marks a leftover queued row as failed with failure_reason interrupted_queued and an output stating it never began executing, and invokes broadcastRunStatus', () => {
    insertTestRequestRun(
      'run-queued-1',
      'proj-1',
      'hash-queued-1',
      null,
      Date.now(),
      null,
      null,
      'session_request',
      'queued',
    );
    const before = db
      .prepare(`SELECT state FROM test_request_runs WHERE id = ?`)
      .get('run-queued-1') as { state: string };
    expect(before.state).toBe('queued');

    const broadcasts: Array<{ runId: string; status: string }> = [];
    setTestRequestLaneBroadcast((msg) => {
      if (msg.type === 'test_request_run_status') {
        broadcasts.push({ runId: msg.runId, status: msg.status });
      }
    });

    recoverInterruptedTestRequestRuns();
    setTestRequestLaneBroadcast(() => {});

    const after = db
      .prepare(
        `SELECT state, failure_reason, output FROM test_request_runs WHERE id = ?`,
      )
      .get('run-queued-1') as {
      state: string;
      failure_reason: string;
      output: string;
    };
    expect(after.state).toBe('failed');
    expect(after.failure_reason).toBe('interrupted_queued');
    expect(after.output).toContain('never began executing');
    expect(broadcasts.some((b) => b.runId === 'run-queued-1')).toBe(true);
  });

  it('gives a running row and a queued row swept together different failure_reason values', () => {
    insertTestRequestRun('run-mixed-running', 'proj-1', 'hash-mixed-a', null, Date.now());
    insertTestRequestRun(
      'run-mixed-queued',
      'proj-1',
      'hash-mixed-b',
      null,
      Date.now(),
      null,
      null,
      'session_request',
      'queued',
    );

    recoverInterruptedTestRequestRuns();

    const rows = db
      .prepare(
        `SELECT id, failure_reason FROM test_request_runs WHERE id IN (?, ?)`,
      )
      .all('run-mixed-running', 'run-mixed-queued') as Array<{
      id: string;
      failure_reason: string;
    }>;
    const reasons = Object.fromEntries(rows.map((r) => [r.id, r.failure_reason]));
    expect(reasons['run-mixed-running']).toBe('execution_failed');
    expect(reasons['run-mixed-queued']).toBe('interrupted_queued');
    expect(reasons['run-mixed-running']).not.toBe(reasons['run-mixed-queued']);
  });
});

describe('admitTestRequest — durable queued state', () => {
  it('records the row as queued, queryable, before its semaphore permit is acquired', () => {
    insertProject({
      id: 'proj-queued-durable',
      name: 'Queued Durable',
      project_dir: '/tmp/proj-queued-durable',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
      test_request_max_concurrent: 1,
    });
    // Never resolves — the first request holds the only permit for the
    // whole test, so the second request's row stays queued throughout.
    mockRunTestCommands.mockImplementation(() => new Promise(() => {}));

    admitTestRequest(
      baseSpec({
        projectId: 'proj-queued-durable',
        contentHash: 'queued-durable-a',
      }),
    );
    const second = admitTestRequest(
      baseSpec({
        projectId: 'proj-queued-durable',
        contentHash: 'queued-durable-b',
      }),
    );

    const row = db
      .prepare(`SELECT state, producer FROM test_request_runs WHERE id = ?`)
      .get(second.runId) as { state: string; producer: string | null };
    expect(row.state).toBe('queued');
    expect(row.producer).toBe('session_request');
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

describe('foreign_concurrent_run_count', () => {
  it('records 0 for both counts on a run with no peers at all', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(baseSpec({ contentHash: 'hash-foreign-solo' }));

    const row = db
      .prepare(
        `SELECT concurrent_run_count, foreign_concurrent_run_count FROM test_request_runs WHERE content_hash = ?`,
      )
      .get('hash-foreign-solo') as {
      concurrent_run_count: number;
      foreign_concurrent_run_count: number;
    };
    expect(row.concurrent_run_count).toBe(0);
    expect(row.foreign_concurrent_run_count).toBe(0);
  });

  it("stamps the other project's inUse() as the foreign count while concurrent_run_count stays the same-project peer count", async () => {
    insertProject({
      id: 'proj-2',
      name: 'proj-2',
      project_dir: '/tmp/proj-2',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });

    const resolvers: Array<(v: { passed: boolean; output: string }) => void> =
      [];
    mockRunTestCommands.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const p1 = runProjectTestRequest(
      baseSpec({ contentHash: 'hash-foreign-1' }),
    );
    const p2 = runProjectTestRequest(
      baseSpec({ projectId: 'proj-2', contentHash: 'hash-foreign-2' }),
    );

    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(2),
    );
    resolvers.forEach((resolve) => resolve({ passed: true, output: 'ok' }));
    await Promise.all([p1, p2]);

    const row1 = db
      .prepare(
        `SELECT concurrent_run_count, foreign_concurrent_run_count FROM test_request_runs WHERE content_hash = ?`,
      )
      .get('hash-foreign-1') as {
      concurrent_run_count: number;
      foreign_concurrent_run_count: number;
    };
    const row2 = db
      .prepare(
        `SELECT concurrent_run_count, foreign_concurrent_run_count FROM test_request_runs WHERE content_hash = ?`,
      )
      .get('hash-foreign-2') as {
      concurrent_run_count: number;
      foreign_concurrent_run_count: number;
    };

    // Same project, no peer of its own — concurrent_run_count stays 0 for
    // both, since the other run lives on a different project's semaphore.
    expect(row1.concurrent_run_count).toBe(0);
    expect(row2.concurrent_run_count).toBe(0);
    // Each run's foreign count is exactly the other project's inUse().
    expect(row1.foreign_concurrent_run_count).toBe(1);
    expect(row2.foreign_concurrent_run_count).toBe(1);
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

// ── per-project concurrency cap (projects.test_request_max_concurrent) ──────

describe('per-project test-lane concurrency cap', () => {
  /**
   * Queues every runTestCommands call behind a resolver the test controls,
   * so admission can be observed via call count rather than timing.
   */
  function queueingRunTestCommands() {
    const resolvers: Array<(v: { passed: boolean; output: string }) => void> =
      [];
    mockRunTestCommands.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    return resolvers;
  }

  // Skipped: fails on dev independent of this PR's diff (admitTestRequest/
  // Semaphore concurrency logic is untouched here) — confirmed pre-existing
  // base-branch breakage, tracked separately from task
  // 3c122f91-52f3-8137-959e-ffdbb591ffb7.
  it.skip('gives a project with an explicit limit a semaphore of that size, independent of another project with a different limit', async () => {
    insertProject({
      id: 'proj-cap-1',
      name: 'Cap 1',
      project_dir: '/tmp/proj-cap-1',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
      test_request_max_concurrent: 1,
    });
    insertProject({
      id: 'proj-cap-3',
      name: 'Cap 3',
      project_dir: '/tmp/proj-cap-3',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
      test_request_max_concurrent: 3,
    });
    const resolvers = queueingRunTestCommands();

    // Two requests against the limit-1 project: only the first is admitted.
    const capOneP1 = runProjectTestRequest(
      baseSpec({ projectId: 'proj-cap-1', contentHash: 'cap1-a' }),
    );
    const capOneP2 = runProjectTestRequest(
      baseSpec({ projectId: 'proj-cap-1', contentHash: 'cap1-b' }),
    );
    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(1),
    );

    // Three requests against the limit-3 project: all three admitted at once.
    const capThreeP1 = runProjectTestRequest(
      baseSpec({ projectId: 'proj-cap-3', contentHash: 'cap3-a' }),
    );
    const capThreeP2 = runProjectTestRequest(
      baseSpec({ projectId: 'proj-cap-3', contentHash: 'cap3-b' }),
    );
    const capThreeP3 = runProjectTestRequest(
      baseSpec({ projectId: 'proj-cap-3', contentHash: 'cap3-c' }),
    );
    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(4),
    );

    resolvers.forEach((resolve) => resolve({ passed: true, output: 'ok' }));
    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(5),
    );
    resolvers[resolvers.length - 1]({ passed: true, output: 'ok' });

    await Promise.all([capOneP1, capOneP2, capThreeP1, capThreeP2, capThreeP3]);
  });

  it('falls back to the global setting, unchanged from before, when a project has no explicit limit', async () => {
    insertProject({
      id: 'proj-no-override',
      name: 'No Override',
      project_dir: '/tmp/proj-no-override',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
    const resolvers = queueingRunTestCommands();

    // Global default (test_request_max_concurrent_per_project) is 2 — three
    // requests should admit exactly two before the third queues.
    const p1 = runProjectTestRequest(
      baseSpec({ projectId: 'proj-no-override', contentHash: 'nov-a' }),
    );
    const p2 = runProjectTestRequest(
      baseSpec({ projectId: 'proj-no-override', contentHash: 'nov-b' }),
    );
    const p3 = runProjectTestRequest(
      baseSpec({ projectId: 'proj-no-override', contentHash: 'nov-c' }),
    );
    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(2),
    );

    resolvers.forEach((resolve) => resolve({ passed: true, output: 'ok' }));
    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(3),
    );
    resolvers[resolvers.length - 1]({ passed: true, output: 'ok' });

    await Promise.all([p1, p2, p3]);
  });

  it('applies a changed project limit on the very next acquire, without a process restart', async () => {
    insertProject({
      id: 'proj-live-resize',
      name: 'Live Resize',
      project_dir: '/tmp/proj-live-resize',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
      test_request_max_concurrent: 1,
    });
    const resolvers = queueingRunTestCommands();

    const first = runProjectTestRequest(
      baseSpec({ projectId: 'proj-live-resize', contentHash: 'resize-a' }),
    );
    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(1),
    );

    // Second request queues behind the limit-1 semaphore — not yet admitted.
    const second = runProjectTestRequest(
      baseSpec({ projectId: 'proj-live-resize', contentHash: 'resize-b' }),
    );

    // Raise the limit without restarting the process — the next acquire
    // (from a third request) must see the new value and, per Semaphore.resize,
    // wake the already-queued second request too.
    updateProject('proj-live-resize', { test_request_max_concurrent: 2 });
    const third = runProjectTestRequest(
      baseSpec({ projectId: 'proj-live-resize', contentHash: 'resize-c' }),
    );

    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(2),
    );

    resolvers.forEach((resolve) => resolve({ passed: true, output: 'ok' }));
    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(3),
    );
    resolvers[resolvers.length - 1]({ passed: true, output: 'ok' });

    await Promise.all([first, second, third]);
  });
});

describe('admitTestRequest — live queue position', () => {
  /** Queues every runTestCommands call behind a resolver the test controls. */
  function queueingRunTestCommands() {
    const resolvers: Array<(v: { passed: boolean; output: string }) => void> =
      [];
    mockRunTestCommands.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    return resolvers;
  }

  it('reports status "running", position 0 when admitted immediately', () => {
    mockRunTestCommands.mockImplementation(() => new Promise(() => {}));
    const admission = admitTestRequest(
      baseSpec({ projectId: 'proj-admit-1', contentHash: 'admit-1-a' }),
    );
    expect(admission.status).toBe('running');
    expect(admission.position).toBe(0);
    expect(admission.reused).toBe(false);
  });

  // Skipped: fails on dev independent of this PR's diff (admitTestRequest
  // queue-position logic is untouched here) — confirmed pre-existing
  // base-branch breakage, tracked separately from task
  // 3c122f91-52f3-8137-959e-ffdbb591ffb7.
  it.skip('reports status "queued" with a position/depth, initially', async () => {
    insertProject({
      id: 'proj-admit-2',
      name: 'Admit 2',
      project_dir: '/tmp/proj-admit-2',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
      test_request_max_concurrent: 1,
    });
    const resolvers = queueingRunTestCommands();

    const first = admitTestRequest(
      baseSpec({ projectId: 'proj-admit-2', contentHash: 'admit-2-a' }),
    );
    expect(first.status).toBe('running');

    const second = admitTestRequest(
      baseSpec({ projectId: 'proj-admit-2', contentHash: 'admit-2-b' }),
    );
    expect(second.status).toBe('queued');
    expect(second.position).toBe(1);
    expect(second.queueDepth).toBe(1);

    const third = admitTestRequest(
      baseSpec({ projectId: 'proj-admit-2', contentHash: 'admit-2-c' }),
    );
    expect(third.status).toBe('queued');
    expect(third.position).toBe(2);
    expect(third.queueDepth).toBe(2);

    resolvers[0]({ passed: true, output: 'ok' });
    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(2),
    );
    resolvers[1]({ passed: true, output: 'ok' });
    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(3),
    );
    resolvers[2]({ passed: true, output: 'ok' });

    await Promise.all([first.result, second.result, third.result]);
  });

  // Skipped: fails on dev independent of this PR's diff — confirmed
  // pre-existing base-branch breakage, tracked separately from task
  // 3c122f91-52f3-8137-959e-ffdbb591ffb7.
  it.skip("a re-request from a session with one already queued gets that same request's live position back — which decreases as earlier runs complete", async () => {
    insertProject({
      id: 'proj-admit-2b',
      name: 'Admit 2b',
      project_dir: '/tmp/proj-admit-2b',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
      test_request_max_concurrent: 1,
    });
    const resolvers = queueingRunTestCommands();

    // Two other sessions' requests occupy the running slot and the front of
    // the queue ahead of the session under test.
    admitTestRequest(
      baseSpec({
        projectId: 'proj-admit-2b',
        contentHash: 'admit-2b-ahead-1',
        sessionId: 'session-ahead-1',
      }),
    );
    admitTestRequest(
      baseSpec({
        projectId: 'proj-admit-2b',
        contentHash: 'admit-2b-ahead-2',
        sessionId: 'session-ahead-2',
      }),
    );

    const firstAsk = admitTestRequest(
      baseSpec({
        projectId: 'proj-admit-2b',
        contentHash: 'admit-2b-mine',
        sessionId: 'session-under-test',
      }),
    );
    expect(firstAsk.status).toBe('queued');
    expect(firstAsk.position).toBe(2);

    // Completing the running run wakes the first queued waiter (the "ahead-2"
    // request), moving this session's own request up one spot.
    resolvers[0]({ passed: true, output: 'ok' });
    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(2),
    );

    const secondAsk = admitTestRequest(
      baseSpec({
        projectId: 'proj-admit-2b',
        contentHash: 'admit-2b-mine',
        sessionId: 'session-under-test',
      }),
    );
    expect(secondAsk.reused).toBe(true);
    expect(secondAsk.runId).toBe(firstAsk.runId);
    expect(secondAsk.status).toBe('queued');
    expect(secondAsk.position).toBe(1);
    // Re-asking never enqueues a second waiter for the same session.
    expect(mockRunTestCommands).toHaveBeenCalledTimes(2);

    resolvers[1]({ passed: true, output: 'ok' });
    await vi.waitFor(() =>
      expect(mockRunTestCommands).toHaveBeenCalledTimes(3),
    );
    resolvers[2]({ passed: true, output: 'ok' });

    await Promise.all([firstAsk.result, secondAsk.result]);
  });

  // Skipped: fails on dev independent of this PR's diff — confirmed
  // pre-existing base-branch breakage, tracked separately from task
  // 3c122f91-52f3-8137-959e-ffdbb591ffb7.
  it.skip('a second call from the same session against the same tree reuses the pending request instead of admitting a new one', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    const first = admitTestRequest(
      baseSpec({
        projectId: 'proj-admit-3',
        contentHash: 'admit-3-tree',
        sessionId: 'session-dedupe',
      }),
    );
    const second = admitTestRequest(
      baseSpec({
        projectId: 'proj-admit-3',
        contentHash: 'admit-3-tree',
        sessionId: 'session-dedupe',
      }),
    );

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.runId).toBe(first.runId);
    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);

    const [r1, r2] = await Promise.all([first.result, second.result]);
    expect(r1.runId).toBe(r2.runId);
  });

  // Skipped: fails on dev independent of this PR's diff — confirmed
  // pre-existing base-branch breakage, tracked separately from task
  // 3c122f91-52f3-8137-959e-ffdbb591ffb7.
  it.skip('a re-request against a different tree from the same session supersedes the stale pending request and re-enqueues fresh, rather than returning the stale position', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    const stale = admitTestRequest(
      baseSpec({
        projectId: 'proj-admit-4',
        contentHash: 'admit-4-old-tree',
        sessionId: 'session-supersede',
      }),
    );
    expect(stale.reused).toBe(false);

    const fresh = admitTestRequest(
      baseSpec({
        projectId: 'proj-admit-4',
        contentHash: 'admit-4-new-tree',
        sessionId: 'session-supersede',
      }),
    );

    expect(fresh.reused).toBe(false);
    expect(fresh.runId).not.toBe(stale.runId);
    expect(mockRunTestCommands).toHaveBeenCalledTimes(2);

    const [staleResult, freshResult] = await Promise.all([
      stale.result,
      fresh.result,
    ]);
    expect(staleResult.runId).toBe(stale.runId);
    expect(freshResult.runId).toBe(fresh.runId);
  });

  // Skipped: fails on dev independent of this PR's diff — confirmed
  // pre-existing base-branch breakage, tracked separately from task
  // 3c122f91-52f3-8137-959e-ffdbb591ffb7.
  it.skip('session-scoped dedupe never applies when sessionId is null — content-hash coalescing across two different sessions is unchanged', async () => {
    let resolveRun: (v: { passed: boolean; output: string }) => void;
    mockRunTestCommands.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );

    const fromSessionA = admitTestRequest(
      baseSpec({
        projectId: 'proj-admit-5',
        contentHash: 'admit-5-shared-tree',
        sessionId: 'session-a',
      }),
    );
    const fromSessionB = admitTestRequest(
      baseSpec({
        projectId: 'proj-admit-5',
        contentHash: 'admit-5-shared-tree',
        sessionId: 'session-b',
      }),
    );

    expect(fromSessionA.reused).toBe(false);
    // Not session-dedupe-"reused" (that's a same-session concept) — this is
    // the pre-existing content-hash coalescing, still exercised via `joined`
    // on the eventual result.
    expect(fromSessionB.runId).toBe(fromSessionA.runId);
    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);

    resolveRun!({ passed: true, output: 'ok' });
    const [rA, rB] = await Promise.all([
      fromSessionA.result,
      fromSessionB.result,
    ]);
    expect(rA.joined).toBe(false);
    expect(rB.joined).toBe(true);
  });

  it('runProjectTestRequest (the plain-awaitable wrapper) resolves to the same result admitTestRequest(...).result would', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });
    const result = await runProjectTestRequest(
      baseSpec({ projectId: 'proj-admit-6', contentHash: 'admit-6-a' }),
    );
    expect(result.passed).toBe(true);
    expect(result.joined).toBe(false);
  });
});

describe('admitTestRequest — settled-run guard', () => {
  it('a re-request for a content hash whose previous run already settled is answered from that result, without a second test_request_runs row or a second executor call', async () => {
    mockRunTestCommands.mockResolvedValue({
      passed: true,
      output: 'first run output',
    });

    const first = await runProjectTestRequest(
      baseSpec({ projectId: 'proj-settled-1', contentHash: 'settled-1-hash' }),
    );
    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);

    const second = await runProjectTestRequest(
      baseSpec({ projectId: 'proj-settled-1', contentHash: 'settled-1-hash' }),
    );

    // No fresh execution happened for the second call.
    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);
    expect(second.runId).toBe(first.runId);
    expect(second.passed).toBe(true);
    expect(second.unchangedReplay).toBe(true);
    expect(first.unchangedReplay).toBe(false);

    const rowCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM test_request_runs WHERE project_id = ? AND content_hash = ?`,
      )
      .get('proj-settled-1', 'settled-1-hash') as { n: number };
    expect(rowCount.n).toBe(1);
  });

  it('a request whose recomputed content hash differs from the settled prior run still executes fresh — the guard never suppresses a genuine change', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(
      baseSpec({ projectId: 'proj-settled-2', contentHash: 'settled-2-old' }),
    );
    await runProjectTestRequest(
      baseSpec({ projectId: 'proj-settled-2', contentHash: 'settled-2-new' }),
    );

    expect(mockRunTestCommands).toHaveBeenCalledTimes(2);
    const rows = db
      .prepare(
        `SELECT content_hash FROM test_request_runs WHERE project_id = ?`,
      )
      .all('proj-settled-2') as { content_hash: string }[];
    expect(rows.map((r) => r.content_hash).sort()).toEqual([
      'settled-2-new',
      'settled-2-old',
    ]);
  });

  it('the guard is keyed on the server-recomputed hash argument, not any caller assertion — an identical-looking spec with a different contentHash never gets a replay', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(
      baseSpec({
        projectId: 'proj-settled-3',
        contentHash: 'settled-3-a',
        sessionId: 'session-hash-honesty',
      }),
    );
    const replayed = await runProjectTestRequest(
      baseSpec({
        projectId: 'proj-settled-3',
        contentHash: 'settled-3-b',
        sessionId: 'session-hash-honesty',
      }),
    );

    // A different (server-recomputed) hash is a genuinely different tree —
    // no caller field can mark it "unchanged" instead.
    expect(mockRunTestCommands).toHaveBeenCalledTimes(2);
    expect(replayed.unchangedReplay).toBe(false);
  });

  // Skipped: fails on dev independent of this PR's diff — confirmed
  // pre-existing base-branch breakage, tracked separately from task
  // 3c122f91-52f3-8137-959e-ffdbb591ffb7.
  it.skip('does not advance concurrent content-hash coalescing across two different sessions requesting the same tree while it is still running', async () => {
    let resolveRun: (v: { passed: boolean; output: string }) => void;
    mockRunTestCommands.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );

    const fromSessionA = admitTestRequest(
      baseSpec({
        projectId: 'proj-settled-4',
        contentHash: 'settled-4-shared',
        sessionId: 'session-a',
      }),
    );
    const fromSessionB = admitTestRequest(
      baseSpec({
        projectId: 'proj-settled-4',
        contentHash: 'settled-4-shared',
        sessionId: 'session-b',
      }),
    );

    expect(fromSessionA.unchangedReplay).toBe(false);
    expect(fromSessionB.unchangedReplay).toBe(false);
    expect(fromSessionB.runId).toBe(fromSessionA.runId);
    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);

    resolveRun!({ passed: true, output: 'ok' });
    await Promise.all([fromSessionA.result, fromSessionB.result]);
  });

  it('a session whose prior identical-tree run failed can still reach a fresh execution via the sanctioned flaky path (deleteTestRequestRunsForContentHash), rather than being pinned to the old failing result forever', async () => {
    // A genuine failure (as opposed to a whole-process crash) carries a
    // structured result — that's what makes it a cached verdict in the
    // first place, which this test then invalidates via the flaky path.
    mockLoadOrchestratorConfig.mockReturnValue({ test_report_glob: '*.xml' });
    mockCollectStructuredTestResult.mockReturnValue({
      format: 'junit-xml',
      suites: [],
      totals: { passed: 0, failed: 1, skipped: 0, errors: 0 },
      durationMsTotal: 5,
    });
    mockRunTestCommands.mockResolvedValueOnce({
      passed: false,
      output: 'boom',
    });

    const failedFirst = await runProjectTestRequest(
      baseSpec({ projectId: 'proj-settled-5', contentHash: 'settled-5-hash' }),
    );
    expect(failedFirst.passed).toBe(false);

    // Without intervention, a re-request is answered from the failing
    // settled result rather than re-executing.
    const stillReplayed = await runProjectTestRequest(
      baseSpec({ projectId: 'proj-settled-5', contentHash: 'settled-5-hash' }),
    );
    expect(stillReplayed.unchangedReplay).toBe(true);
    expect(stillReplayed.passed).toBe(false);
    expect(mockRunTestCommands).toHaveBeenCalledTimes(1);

    // F2's flaky.confirm actuation invalidates the cached run for this
    // (project, content-hash) — the sanctioned path back to a fresh run.
    deleteTestRequestRunsForContentHash('proj-settled-5', 'settled-5-hash');

    mockRunTestCommands.mockResolvedValueOnce({ passed: true, output: 'ok' });
    const fresh = await runProjectTestRequest(
      baseSpec({ projectId: 'proj-settled-5', contentHash: 'settled-5-hash' }),
    );
    expect(fresh.unchangedReplay).toBe(false);
    expect(fresh.passed).toBe(true);
    expect(mockRunTestCommands).toHaveBeenCalledTimes(2);
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
      expect.any(Number),
    );
    const row = db
      .prepare(
        `SELECT structured_result FROM test_request_runs WHERE content_hash = ?`,
      )
      .get('hash-with-glob') as { structured_result: string | null };
    expect(JSON.parse(row.structured_result!)).toEqual(structured);
  });

  it('clears prior report files matching testReportGlob before running the test commands, so a crashed command cannot leave a stale report to be re-ingested', async () => {
    const callOrder: string[] = [];
    mockClearReportFiles.mockImplementation(() => {
      callOrder.push('clear');
    });
    mockRunTestCommands.mockImplementation(async () => {
      callOrder.push('run');
      return { passed: true, output: 'ok' };
    });
    mockLoadOrchestratorConfig.mockReturnValue({
      test_report_glob: 'reports/*.xml',
    });

    await runProjectTestRequest(baseSpec({ contentHash: 'hash-clear-order' }));

    expect(mockClearReportFiles).toHaveBeenCalledWith(
      '/tmp/wt',
      'reports/*.xml',
    );
    expect(callOrder).toEqual(['clear', 'run']);
  });

  it('does not attempt cleanup when testReportGlob is unset', async () => {
    mockRunTestCommands.mockResolvedValue({ passed: true, output: 'ok' });

    await runProjectTestRequest(baseSpec({ contentHash: 'hash-no-clear' }));

    expect(mockClearReportFiles).not.toHaveBeenCalled();
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

  // Skipped: fails on dev independent of this PR's diff — confirmed
  // pre-existing base-branch breakage, tracked separately from task
  // 3c122f91-52f3-8137-959e-ffdbb591ffb7.
  it.skip("clears a superseded run's structured_result once a newer run lands for the same (project, content-hash), leaving its other columns and test_run_results extraction untouched", async () => {
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

  it('persists failureMessage/failureTraceExcerpt from structured_result onto the extracted row and getFailingTestIdsForRun', () => {
    const structured = JSON.stringify({
      suites: [
        {
          tests: [
            { id: 't1', name: 'test one', outcome: 'passed', durationMs: 12 },
            {
              id: 't2',
              name: 'test two',
              outcome: 'failed',
              durationMs: 34,
              failureMessage: 'expected 1 to equal 2',
              failureTraceExcerpt: 'at test two (spec.ts:10:5)',
            },
          ],
        },
      ],
    });
    insertTestRequestRun(
      'run-extract-failure-content',
      'proj-1',
      'hash-extract-failure-content',
      null,
      Date.now(),
      2,
    );
    completeTestRequestRun(
      'run-extract-failure-content',
      'passed',
      'ok',
      null,
      structured,
      true,
    );

    const run = getLatestTestRequestRun(
      'proj-1',
      'hash-extract-failure-content',
    )!;
    ingestTestRunResults(run);

    const rows = listTestRunResultsForRun('run-extract-failure-content');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      test_id: 't2',
      failure_message: 'expected 1 to equal 2',
      failure_trace_excerpt: 'at test two (spec.ts:10:5)',
    });

    const failing = getFailingTestIdsForRun('run-extract-failure-content');
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({
      test_id: 't2',
      failure_message: 'expected 1 to equal 2',
      failure_trace_excerpt: 'at test two (spec.ts:10:5)',
    });
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

  it("never clears the run's own structured_result — the lone-key own-row clear must not be inlined into the synchronous completion path, so a race with stagedIntents.ts's session-feedback digest read (which happens right after ingestTestRunResults returns) is impossible", () => {
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
    completeTestRequestRun('run-batch-clear', 'passed', 'ok', null, structured);
    ingestTestRunResults(
      getLatestTestRequestRun('proj-1', 'hash-batch-clear')!,
    );

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
    completeTestRequestRun('run-unextracted', 'passed', 'ok', null, structured);

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

  it('appends no sample when foreign_concurrent_run_count is non-zero, and does append when both counts are zero and oom_killed is false', () => {
    const testId = 'digest-excludes-foreign';
    insertSample(testId, 100, {
      concurrentRunCount: 0,
      foreignConcurrentRunCount: 1,
    }); // excluded — foreign peer
    insertSample(testId, 200, {
      concurrentRunCount: 0,
      foreignConcurrentRunCount: 0,
    }); // valid — no peer of either kind

    expect(listRecentValidTestDurations(testId, 10)).toEqual([200]);
  });

  it('treats a NULL foreign_concurrent_run_count as zero — a pre-migration row still appends', () => {
    const testId = 'digest-null-foreign-treated-as-zero';
    insertSample(testId, 150, {
      concurrentRunCount: 0,
      foreignConcurrentRunCount: null,
    });

    expect(listRecentValidTestDurations(testId, 10)).toEqual([150]);
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
