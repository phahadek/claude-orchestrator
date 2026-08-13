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
  type TestCommandResult,
} from '../session/test-runner';
import { hasTestRequestAdmission } from './memoryAdmission';
import { typedGetSetting } from '../config/settings';
import {
  insertTestRequestRun,
  completeTestRequestRun,
  listRunningTestRequestRuns,
  listTestRequestRunsNeedingExtraction,
  hasTestRunResults,
  insertTestRunResults,
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
    completeTestRequestRun(
      runId,
      result.passed ? 'passed' : 'failed',
      result.output,
      result.passed ? null : failureReasonFor(result),
      null,
      oomKilled,
    );
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
      structured_result: null,
      concurrent_run_count: concurrentRunCount,
      oom_killed: oomKilled ? 1 : 0,
    });
    return { ...result, runId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = `[testRequestLane] execution error: ${message}`;
    completeTestRequestRun(runId, 'failed', output, 'generic', null, false);
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

  const tests: NewTestRunResultRow[] = (parsed.suites ?? []).flatMap(
    (suite) =>
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
  }
}
