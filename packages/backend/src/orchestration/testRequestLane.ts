/**
 * The test.request governed lane: executes a project's configured `test:`
 * commands on behalf of a mechanically auto-granted test.request staged
 * intent (see maybeAutoApproveTestRequest in routes/stagedIntents.ts).
 *
 * Two properties this module owns, neither of which the staged-intent layer
 * itself can provide:
 *  - Coalescing: two concurrent requests for the same (project, content-hash)
 *    pair share one execution — the second waits on the first's promise
 *    rather than starting a duplicate run.
 *  - Bounded concurrency: a per-project Semaphore (the same class
 *    tasks/deferralClassifier.ts uses to bound classify subprocesses) caps
 *    how many test runs a single project can have in flight, and admission
 *    additionally folds in the host memory-headroom check
 *    (orchestration/memoryAdmission.ts) so a burst of test.request intents
 *    can't starve the host the way an unbounded session launch could.
 *
 * Every run is durably recorded in test_request_runs before it starts, so a
 * backend crash mid-run leaves a `running` row recoverInterruptedTestRequestRuns
 * (called once at boot — see bootSequence.ts) sweeps into `failed` rather than
 * leaving it silently stuck forever — the run is treated as failed/retryable,
 * never silently re-queued.
 */

import { randomUUID } from 'crypto';
import { Semaphore } from '../tasks/deferralClassifier';
import {
  runTestCommands,
  collectStructuredTestResult,
  isTestIdTouchedByChangedFiles,
  type TestCommandResult,
} from '../session/test-runner';
import { hasTestRequestAdmission } from './memoryAdmission';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import { typedGetSetting } from '../config/settings';
import {
  insertTestRequestRun,
  completeTestRequestRun,
  clearSupersededStructuredResults,
  clearStructuredResultIfSuperseded,
  listRunningTestRequestRuns,
  listTestRequestRunsNeedingExtraction,
  hasTestRunResults,
  insertTestRunResults,
  listRecentValidTestDurations,
  upsertTestPerfBaseline,
  computeTestFlipRateFlag,
  getFailingTestIdsForRun,
} from '../db/queries';
import type {
  TestRequestFailureReason,
  TestRequestRunRow,
  StructuredTestResult,
  NewTestRunResultRow,
} from '../db/types';
import { logger } from '../logger';
import type { ServerMessage, TestRequestRunStatusPayload } from '../ws/types';

// ── Broadcast infrastructure ─────────────────────────────────────────────────
// Mirrors stagedIntents.ts's staged_intent_changed wiring: WS only notifies
// clients that a lane run transitioned, REST (GET /test-request-runs) stays
// the fetch/apply source of truth.
let broadcastFn: ((msg: ServerMessage) => void) | null = null;

export function setTestRequestLaneBroadcast(
  fn: (msg: ServerMessage) => void,
): void {
  broadcastFn = fn;
}

function broadcastRunStatus(payload: TestRequestRunStatusPayload): void {
  broadcastFn?.({ type: 'test_request_run_status', ...payload });
}

export interface TestRequestRunSpec {
  projectId: string;
  contentHash: string;
  worktreePath: string;
  commands: string[];
  timeoutSec: number;
  maxRssMb: number;
  failFast: boolean;
  /** Originating session, persisted onto the run row for per-request attribution. */
  sessionId: string | null;
}

/**
 * runProjectTestRequest's result: the underlying TestCommandResult plus the
 * durable run's id and whether this particular call joined an already
 * in-flight run (coalesced) rather than originating it. Two concurrent
 * callers for the same (project, content-hash) key share one `runId` but
 * only one of them gets `joined: false`.
 */
export interface TestRequestRunResult extends TestCommandResult {
  runId: string;
  joined: boolean;
}

function failureReasonFor(result: TestCommandResult): TestRequestFailureReason {
  if (result.timedOut) return 'timeout';
  if (result.oomKilled) return 'oom_killed';
  return 'generic';
}

const projectSemaphores = new Map<string, Semaphore>();

function getProjectSemaphore(projectId: string): Semaphore {
  let sem = projectSemaphores.get(projectId);
  if (!sem) {
    sem = new Semaphore(
      typedGetSetting('test_request_max_concurrent_per_project'),
    );
    projectSemaphores.set(projectId, sem);
  }
  return sem;
}

const inFlightRuns = new Map<
  string,
  Promise<TestCommandResult & { runId: string }>
>();

function coalesceKey(projectId: string, contentHash: string): string {
  return `${projectId}:${contentHash}`;
}

const ADMISSION_POLL_MS = 5_000;
const ADMISSION_MAX_WAIT_MS = 5 * 60_000;

async function waitForMemoryAdmission(
  projectId: string,
  perProjectLimit: number,
): Promise<void> {
  const deadline = Date.now() + ADMISSION_MAX_WAIT_MS;
  const semaphore = getProjectSemaphore(projectId);
  while (Date.now() < deadline) {
    if (hasTestRequestAdmission(semaphore.inUse(), perProjectLimit)) return;
    await new Promise((resolve) => setTimeout(resolve, ADMISSION_POLL_MS));
  }
  logger.warn(
    `[testRequestLane] memory admission wait exhausted for project ${projectId} — proceeding anyway`,
  );
}

/**
 * Runs (or joins an already-running) test.request execution for
 * (spec.projectId, spec.contentHash). Never throws — a runTestCommands
 * failure surfaces as a `passed: false` result, matching runTestCommands'
 * own contract; only a durable-write failure around it would throw, and even
 * that is caught so a caller awaiting a coalesced run never sees an
 * unhandled rejection.
 */
export function runProjectTestRequest(
  spec: TestRequestRunSpec,
): Promise<TestRequestRunResult> {
  const key = coalesceKey(spec.projectId, spec.contentHash);
  const existing = inFlightRuns.get(key);
  if (existing) {
    return existing.then((result) => ({ ...result, joined: true }));
  }

  const run = executeTestRequestRun(spec).finally(() => {
    if (inFlightRuns.get(key) === run) inFlightRuns.delete(key);
  });
  inFlightRuns.set(key, run);
  return run.then((result) => ({ ...result, joined: false }));
}

async function executeTestRequestRun(
  spec: TestRequestRunSpec,
): Promise<TestCommandResult & { runId: string }> {
  const requestedAt = Date.now();
  await waitForMemoryAdmission(
    spec.projectId,
    typedGetSetting('test_request_max_concurrent_per_project'),
  );

  const semaphore = getProjectSemaphore(spec.projectId);
  const release = await semaphore.acquire();
  const runId = randomUUID();
  const startedAt = Date.now();
  // Occupancy right after acquiring — includes this run — captured now
  // rather than inferred later, per the concurrent_run_count validity signal.
  const concurrentRunCount = semaphore.inUse();
  try {
    insertTestRequestRun(
      runId,
      spec.projectId,
      spec.contentHash,
      spec.sessionId,
      requestedAt,
      concurrentRunCount,
    );
    broadcastRunStatus({
      runId,
      projectId: spec.projectId,
      contentHash: spec.contentHash,
      status: 'running',
      sessionId: spec.sessionId,
      requestedAt,
      startedAt,
    });
    const result = await runTestCommands(
      spec.worktreePath,
      spec.commands,
      spec.timeoutSec,
      (msg) => logger.info(`[testRequestLane] ${msg}`),
      { maxRssMb: spec.maxRssMb, failFast: spec.failFast },
    );
    const oomKilled = result.oomKilled ?? false;
    // Acquisition is attempted regardless of pass/fail — a failing test run
    // still writes its report file, and that's exactly the case structured
    // per-test detail matters most for. The glob is resolved here, from the
    // worktree's own config, rather than trusted from the caller — every
    // caller that runs against a project declaring test_report_glob gets
    // acquisition, with no call site able to silently opt out.
    const testReportGlob = loadOrchestratorConfig(
      spec.worktreePath,
    ).test_report_glob;
    const acquisitionAttempted = !!testReportGlob;
    let structuredResult: StructuredTestResult | null = null;
    if (testReportGlob) {
      try {
        structuredResult = collectStructuredTestResult(
          spec.worktreePath,
          testReportGlob,
          spec.commands.length,
        );
      } catch (err) {
        logger.warn(
          `[testRequestLane] structured_result acquisition failed for run ${runId}:`,
          err,
        );
      }
    }
    const structuredResultJson = structuredResult
      ? JSON.stringify(structuredResult)
      : null;
    completeTestRequestRun(
      runId,
      result.passed ? 'passed' : 'failed',
      result.output,
      result.passed ? null : failureReasonFor(result),
      structuredResultJson,
      oomKilled,
      acquisitionAttempted,
    );
    clearSupersededStructuredResults(spec.projectId, spec.contentHash, runId);
    broadcastRunStatus({
      runId,
      projectId: spec.projectId,
      contentHash: spec.contentHash,
      status: result.passed ? 'passed' : 'failed-with-cause',
      output: result.passed ? undefined : result.output,
      sessionId: spec.sessionId,
      requestedAt,
      startedAt,
      finishedAt: Date.now(),
    });
    ingestTestRunResults({
      id: runId,
      project_id: spec.projectId,
      content_hash: spec.contentHash,
      session_id: spec.sessionId,
      state: result.passed ? 'passed' : 'failed',
      output: result.output,
      requested_at: requestedAt,
      started_at: startedAt,
      finished_at: Date.now(),
      failure_reason: result.passed ? null : failureReasonFor(result),
      structured_result: structuredResultJson,
      concurrent_run_count: concurrentRunCount,
      oom_killed: oomKilled ? 1 : 0,
      test_report_acquisition_attempted: acquisitionAttempted ? 1 : 0,
    });
    return { ...result, runId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = `[testRequestLane] execution error: ${message}`;
    completeTestRequestRun(runId, 'failed', output, 'generic', null, false);
    clearSupersededStructuredResults(spec.projectId, spec.contentHash, runId);
    broadcastRunStatus({
      runId,
      projectId: spec.projectId,
      contentHash: spec.contentHash,
      status: 'failed-with-cause',
      output,
      sessionId: spec.sessionId,
      requestedAt,
      startedAt,
      finishedAt: Date.now(),
    });
    return { passed: false, output, runId };
  } finally {
    release();
  }
}

/**
 * Boot-time crash recovery: a `running` row left over from a prior process
 * (the backend was killed/crashed mid-run) can never resolve its own
 * coalescing promise again — that in-memory state died with the process — so
 * it is marked `failed` rather than left stuck. The request that started it
 * already spent its cycle-counter increment at stage time, so this does not
 * grant a free retry against the escalation budget.
 */
export function recoverInterruptedTestRequestRuns(): void {
  const running = listRunningTestRequestRuns();
  for (const run of running) {
    logger.warn(
      `[testRequestLane] recovering interrupted run ${run.id} (project ${run.project_id}) as failed`,
    );
    const output =
      '[testRequestLane] backend restarted mid-run — treated as failed';
    completeTestRequestRun(run.id, 'failed', output);
    clearSupersededStructuredResults(run.project_id, run.content_hash, run.id);
    broadcastRunStatus({
      runId: run.id,
      projectId: run.project_id,
      contentHash: run.content_hash,
      status: 'failed-with-cause',
      output,
      sessionId: run.session_id,
      requestedAt: run.requested_at ?? undefined,
      startedAt: run.started_at,
      finishedAt: Date.now(),
    });
  }
}

/**
 * Extracts a completed run's structured_result into one test_run_results row
 * per test, denormalizing the run's concurrent_run_count/oom_killed validity
 * signals onto each row. No-op if there's nothing to extract (no
 * structured_result, no tests, or already extracted) — safe to call
 * unconditionally after every run and again from the boot sweep below, which
 * is what makes extraction re-derivable/idempotent rather than a one-shot
 * step that data loss can slip past.
 */
export function ingestTestRunResults(run: TestRequestRunRow): void {
  if (!run.structured_result) return;
  if (hasTestRunResults(run.id)) return;

  let parsed: StructuredTestResult;
  try {
    parsed = JSON.parse(run.structured_result) as StructuredTestResult;
  } catch (err) {
    logger.warn(
      `[testRequestLane] failed to parse structured_result for run ${run.id}:`,
      err,
    );
    return;
  }

  const tests: NewTestRunResultRow[] = (parsed.suites ?? []).flatMap((suite) =>
    (suite.tests ?? []).map((test) => ({
      test_id: test.id,
      name: test.name,
      outcome: test.outcome,
      duration_ms: test.durationMs,
    })),
  );
  if (tests.length === 0) return;

  insertTestRunResults(
    run.id,
    tests,
    run.concurrent_run_count ?? null,
    !!run.oom_killed,
  );

  const touchedTestIds = tests.map((t) => t.test_id);
  for (const testId of new Set(touchedTestIds)) {
    computeTestPerfBaseline(testId);
  }
  recomputeFlipRateFlags(touchedTestIds);
}

/**
 * The lane-side f2-only auto-disposition eligibility check (see
 * PRMergeWatcher.tryF2LaneAutoDisposition, the sole caller): a failing F2 run
 * is only eligible for auto-recovery when EVERY one of its failing tests
 * (getFailingTestIdsForRun) clears both masking guards —
 *  1. flip-rate flagged, using only samples predating this PR's own runs
 *     (`beforeMs`, keyed off the PR's created_at)
 *  2. the PR's diff (`changedFiles`) does not touch the test's own file,
 *     confidently resolved (isTestIdTouchedByChangedFiles fails closed —
 *     an unmappable test_id blocks auto-disposition, same as a touched file)
 *
 * A run with no per-test detail (structured_result never ingested) is never
 * eligible — there's nothing to individually clear, so it must route through
 * the unmodified session pause+nudge path per the locked design.
 */
export function evaluateF2LaneFlakyDisposition(
  testRequestRunId: string,
  beforeMs: number,
  changedFiles: string[],
  flipRateWindowN: number,
  flipRateThresholdK: number,
): boolean {
  const failing = getFailingTestIdsForRun(testRequestRunId);
  if (failing.length === 0) return false;

  for (const test of failing) {
    const flag = computeTestFlipRateFlag(
      test.test_id,
      flipRateWindowN,
      flipRateThresholdK,
      beforeMs,
    );
    if (!flag.flagged) return false;

    const { touched, confident } = isTestIdTouchedByChangedFiles(
      test.test_id,
      test.name,
      changedFiles,
    );
    if (!confident || touched) return false;
  }

  return true;
}

// ─── per-test rolling median/MAD duration baseline ─────────────────────────
// Locked by the "Design per-test performance monitoring" design task: a
// rolling median + MAD baseline over the last N *valid* samples
// (concurrent_run_count = 0, oom_killed = false — see
// listRecentValidTestDurations), flagging a regression only once a minimum
// run of MIN_CONSECUTIVE_REGRESSED_SAMPLES consecutive valid samples all
// exceed median + REGRESSION_K * MAD. The consecutive-run guard is what
// keeps a single noisy sample from tripping a regression.

/** Size of the trailing valid-sample window the median/MAD baseline is computed over. */
const BASELINE_WINDOW_SAMPLES = 20;
/** How many of the most recent valid samples must all exceed the threshold to flag a regression. */
const MIN_CONSECUTIVE_REGRESSED_SAMPLES = 3;
/** Number of MADs above the median a sample must be to count as "high". */
const REGRESSION_K = 3;

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function medianAbsoluteDeviation(values: number[], center: number): number {
  const deviations = values
    .map((v) => Math.abs(v - center))
    .sort((a, b) => a - b);
  return median(deviations);
}

/**
 * Recomputes and persists the rolling baseline for a single test_id from its
 * most recent valid samples. Safe to call for any test_id with at least one
 * valid sample; a no-op (no write) if there are none. Called inline for
 * every test_id touched by a just-extracted run, per the locked design's
 * "updated per ingestion" language.
 */
export function computeTestPerfBaseline(testId: string): void {
  const samples = listRecentValidTestDurations(
    testId,
    BASELINE_WINDOW_SAMPLES + MIN_CONSECUTIVE_REGRESSED_SAMPLES,
  );
  if (samples.length === 0) return;

  const lastDuration = samples[0];

  if (samples.length <= MIN_CONSECUTIVE_REGRESSED_SAMPLES) {
    // Not enough history yet to separate a baseline window from a
    // consecutive-run check — persist the aggregate over what exists, never
    // flagged, so the summary is still queryable once pruning kicks in.
    const sorted = [...samples].sort((a, b) => a - b);
    const med = median(sorted);
    upsertTestPerfBaseline({
      test_id: testId,
      median_duration_ms: med,
      mad_duration_ms: medianAbsoluteDeviation(samples, med),
      sample_count: samples.length,
      last_duration_ms: lastDuration,
      is_regressed: false,
    });
    return;
  }

  const recent = samples.slice(0, MIN_CONSECUTIVE_REGRESSED_SAMPLES);
  const baselineSamples = samples.slice(MIN_CONSECUTIVE_REGRESSED_SAMPLES);
  const sortedBaseline = [...baselineSamples].sort((a, b) => a - b);
  const baselineMedian = median(sortedBaseline);
  const baselineMad = medianAbsoluteDeviation(baselineSamples, baselineMedian);
  const threshold = baselineMedian + REGRESSION_K * baselineMad;
  const isRegressed = recent.every((d) => d > threshold);

  upsertTestPerfBaseline({
    test_id: testId,
    median_duration_ms: baselineMedian,
    mad_duration_ms: baselineMad,
    sample_count: baselineSamples.length,
    last_duration_ms: lastDuration,
    is_regressed: isRegressed,
  });
}

/**
 * Re-evaluates the flip-rate flag for every test id touched by this
 * ingestion. The flag is never persisted (see computeTestFlipRateFlag) — this
 * just surfaces the freshly recomputed state to the log, since a fresh
 * ingestion is exactly the moment a test's window (and therefore its flag)
 * can change.
 */
function recomputeFlipRateFlags(testIds: string[]): void {
  const windowN = typedGetSetting('flip_rate_window_n');
  const thresholdK = typedGetSetting('flip_rate_threshold_k');
  const seen = new Set<string>();
  for (const testId of testIds) {
    if (seen.has(testId)) continue;
    seen.add(testId);
    const flag = computeTestFlipRateFlag(testId, windowN, thresholdK);
    if (flag.flagged) {
      logger.info(
        `[testRequestLane] test ${testId} flagged flaky: ${flag.transitionCount} transitions in last ${flag.sampleCount} valid samples`,
      );
    }
  }
}

/**
 * Boot-time re-derivation sweep: catches every run with a structured_result
 * but no extracted test_run_results rows — a crash mid-ingestion, or a run
 * completed before this extraction step existed — and ingests it. A delay,
 * never data loss, since extraction is fully re-derivable from the run row.
 */
export function sweepTestRunResultsExtraction(): void {
  const pending = listTestRequestRunsNeedingExtraction();
  for (const run of pending) {
    logger.info(
      `[testRequestLane] extracting test_run_results for run ${run.id} (project ${run.project_id})`,
    );
    ingestTestRunResults(run);
    // This run's extraction may have been deferred past a newer run
    // completing for the same key — clearSupersededStructuredResults skipped
    // it at that time to avoid racing this very sweep. Now that extraction
    // is done, retroactively clear it if it's no longer the latest.
    if (hasTestRunResults(run.id)) {
      clearStructuredResultIfSuperseded(
        run.id,
        run.project_id,
        run.content_hash,
      );
    }
  }
}
