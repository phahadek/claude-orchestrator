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
 * admitTestRequest (the entry point maybeAutoApproveTestRequest uses) makes
 * that Semaphore's waiter queue directly observable: a caller learns whether
 * it's running or queued — and at what position/depth — synchronously at
 * admission time, before the run itself starts, and a session that already
 * has one pending request against the same tree gets that request's
 * position back instead of enqueuing a second one.
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
  clearReportFiles,
  isTestIdTouchedByChangedFiles,
  type TestCommandResult,
} from '../session/test-runner';
import { hasTestRequestAdmission } from './memoryAdmission';
import { loadOrchestratorConfig } from '../session/orchestrator-config';
import {
  withCheckoutTestRunLock,
  sharesCheckoutNodeModules,
} from './checkoutInstallLock';
import { typedGetSetting } from '../config/settings';
import {
  insertTestRequestRun,
  markTestRequestRunRunning,
  completeTestRequestRun,
  clearSupersededStructuredResults,
  clearExtractedStructuredResultsBatch,
  STRUCTURED_RESULT_CLEAR_BATCH_CAP,
  listRunningTestRequestRuns,
  listQueuedTestRequestRuns,
  listTestRequestRunsNeedingExtraction,
  countTestRequestRunsNeedingExtraction,
  hasTestRunSummary,
  ingestTestRunResultsTx,
  listRecentValidTestDurations,
  upsertTestPerfBaseline,
  computeTestFlipRateFlag,
  computeTestFailureBreadthFlag,
  getFailingTestIdsForRun,
  getProjectRowById,
  getLatestTestRequestRun,
} from '../db/queries';
import type {
  TestRequestFailureReason,
  TestRequestRunRow,
  StructuredTestResult,
  NewTestRunResultRow,
  RunOrigin,
  TestRunProducer,
  TestRunKind,
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
  /** Originating session, persisted onto the run row for per-request attribution. */
  sessionId: string | null;
  /**
   * Explicit identity the caller states about the run it's originating —
   * 'base_health_probe' for baseHealthCheck.ts, 'pr_pipeline' for
   * PreReviewPipeline.ts/ReviewOrchestrator.ts, null for an ordinary
   * session-attributed test.request. Required so every call site states its
   * own identity rather than relying on sessionId's absence — sessionId is
   * null for both a base probe and a PR-branch run, and only run_origin
   * distinguishes them (see getLatestBaseHealthTestRequestRun in
   * db/queries.ts).
   */
  runOrigin: RunOrigin;
  /** Which lane call site is originating this run — set at insert time onto every row; see TestRunProducer in db/types.ts. */
  producer: TestRunProducer;
  /**
   * 'full' (the default when omitted) or 'scoped' — see TestRunKind in
   * db/types.ts. Distinguishes `commands` a project declares as its unscoped
   * `test:` set from a narrower `test_scoped:` set, so the two can never
   * coalesce or replay each other's settled result under the same
   * content_hash.
   */
  runKind?: TestRunKind;
  /**
   * Base commit sha `commands` was computed against, when runKind is
   * 'scoped' and the scoping mechanism is base-relative (e.g.
   * `vitest --changed <base_sha>`). Omitted/null for a 'full' run and for a
   * marker-exclusion scoped run that has no base dependency.
   */
  baseSha?: string | null;
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
  /**
   * True when this result was never freshly executed — it's the most recent
   * settled run for this exact (project, content-hash), handed back as-is
   * because the tree hasn't changed since it ran. Set by the settled-run
   * guard in admitTestRequest; see that function's doc comment. A session
   * that sees this on a failing result must not simply re-request — it
   * cannot get a different verdict that way — and should route through the
   * sanctioned flaky path (F2's flaky disposition / flaky.confirm) instead.
   */
  unchangedReplay: boolean;
}

/** A caller's live standing in the per-project lane: running now, or queued behind others. */
export type TestRequestAdmissionStatus = 'running' | 'queued';

/**
 * What admitTestRequest reports back the moment a request is admitted —
 * before the underlying test run has even started, let alone finished — so
 * a caller waiting on the eventual `result` can still learn its standing
 * immediately: running, or queued at `position` of `queueDepth` waiters.
 */
export interface TestRequestAdmission {
  runId: string;
  status: TestRequestAdmissionStatus;
  /** 1-indexed position among queued waiters; 0 while running. */
  position: number;
  /** Count of requests currently waiting for a permit (not yet running). */
  queueDepth: number;
  /**
   * True when this call was folded into an already-pending request from the
   * same session against the same tree, rather than admitting a new one —
   * see the sessionId-keyed dedupe in admitTestRequest.
   */
  reused: boolean;
  /**
   * True when no execution happened at all — the most recent settled run
   * for this exact (project, content-hash) was handed back as-is because the
   * tree is unchanged since it last ran. Mutually exclusive with `reused`
   * (that's a pending-request fold; this is a settled-result replay) — see
   * the settled-run guard in admitTestRequest.
   */
  unchangedReplay: boolean;
  /** Resolves once the underlying test run (fresh, content-hash-coalesced, session-reused, or settled-replay) finishes. */
  result: Promise<TestRequestRunResult>;
}

function failureReasonFor(result: TestCommandResult): TestRequestFailureReason {
  if (result.spawnFailed) return 'execution_failed';
  // Checked ahead of timedOut/oomKilled: a surviving process means teardown
  // itself failed, which is the more actionable/alarming fact regardless of
  // what triggered the teardown attempt in the first place.
  if (result.teardownVerificationFailed) return 'teardown_failed';
  if (result.timedOut) return 'timeout';
  if (result.oomKilled) return 'oom_killed';
  return 'generic';
}

/**
 * The project's configured concurrency cap: its own
 * projects.test_request_max_concurrent when set, else the global
 * test_request_max_concurrent_per_project setting. A project with no
 * explicit override always resolves to the global — same behaviour as
 * before this per-project cap existed.
 */
function getEffectiveProjectLimit(projectId: string): number {
  return (
    getProjectRowById(projectId)?.test_request_max_concurrent ??
    typedGetSetting('test_request_max_concurrent_per_project')
  );
}

const projectSemaphores = new Map<string, Semaphore>();

/**
 * Returns the per-project semaphore, resizing it in place whenever the
 * project's configured limit (getEffectiveProjectLimit) has changed since it
 * was cached — so editing a project's limit (or the global default it falls
 * back to) takes effect on the very next acquire, no backend restart needed.
 */
function getProjectSemaphore(projectId: string): Semaphore {
  const limit = getEffectiveProjectLimit(projectId);
  let sem = projectSemaphores.get(projectId);
  if (!sem) {
    sem = new Semaphore(limit);
    projectSemaphores.set(projectId, sem);
  } else if (sem.capacity() !== limit) {
    sem.resize(limit);
  }
  return sem;
}

/**
 * Sum of every OTHER project's semaphore inUse() — the host-wide peer count
 * that projectSemaphores' per-project keying otherwise hides entirely (see
 * this module's doc comment). Unlike concurrentRunCount, no "- 1" here: this
 * run's own occupancy lives on its own project's semaphore, never on another
 * project's, so every entry counted here is a genuine foreign peer.
 */
function getForeignConcurrentRunCount(projectId: string): number {
  let total = 0;
  for (const [otherProjectId, sem] of projectSemaphores) {
    if (otherProjectId === projectId) continue;
    total += sem.inUse();
  }
  return total;
}

/**
 * Test-only: clears every cached per-project semaphore. projectSemaphores is
 * deliberately process-lifetime state in production (a project's occupancy
 * must persist across runs), but that means a single test elsewhere in the
 * suite that intentionally never resolves its mocked run (to exercise queued
 * state) leaves a permanently nonzero inUse() on that project's semaphore —
 * invisible to concurrent_run_count (which only ever reads its own project's
 * semaphore) but silently poisoning every later test's
 * getForeignConcurrentRunCount, which sums across all of them. Call from a
 * suite's beforeEach to isolate tests from each other.
 */
export function __resetProjectSemaphoresForTest(): void {
  projectSemaphores.clear();
}

interface InFlightEntry {
  runId: string;
  contentHash: string;
  runKind: TestRunKind;
  baseSha: string | null;
  /** Live admission status, re-derived from the semaphore on every call — never a fixed snapshot. */
  admission: () => {
    status: TestRequestAdmissionStatus;
    position: number;
    queueDepth: number;
  };
  promise: Promise<TestCommandResult & { runId: string }>;
}

const inFlightRuns = new Map<string, InFlightEntry>();
const pendingBySession = new Map<string, InFlightEntry>();

/**
 * Includes runKind/baseSha alongside (project, content-hash) so a scoped run
 * and a full run against the identical tree never coalesce into one
 * execution, and so a base-relative scoped run against a since-superseded
 * base is never folded into one still running against the current base.
 */
function coalesceKey(
  projectId: string,
  contentHash: string,
  runKind: TestRunKind,
  baseSha: string | null,
): string {
  return `${projectId}:${contentHash}:${runKind}:${baseSha ?? ''}`;
}

function sessionKey(projectId: string, sessionId: string): string {
  return `${projectId}:${sessionId}`;
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
 * Admits a test.request into the lane, synchronously — before the run has
 * even started, let alone finished — reporting whether it's running or
 * queued (and at what position/depth), rather than making a caller find out
 * only once the (possibly much later) result promise settles. This is what
 * lets a session's test_request tool call return a live queue position
 * instead of a bare "queued" the caller has to take on faith (the observed
 * gap this closes: see the module-level task history).
 *
 * Three layers, checked in this order:
 *  1. Session-scoped dedupe (sessionId given, matching contentHash): a
 *     session that already has one pending request against the *same* tree
 *     gets that request's identity/position back — `reused: true` — rather
 *     than admitting a second one. A pending request whose tree has since
 *     changed (different contentHash) is treated as stale and superseded:
 *     this call proceeds to admit fresh rather than handing back a position
 *     that would resolve to a stale result. Never applies when sessionId is
 *     null (every non-staged-intent caller — PreReviewPipeline,
 *     ReviewOrchestrator, baseHealthCheck — always passes null here).
 *  2. Content-hash coalescing (unchanged from before this function existed):
 *     two callers for the same (project, content-hash) — regardless of
 *     session — share one execution, for the duration that execution is
 *     in flight.
 *  3. Settled-run guard: once nothing is pending or in-flight, a prior
 *     *finished* run for the same (project, content-hash) — found via
 *     getLatestTestRequestRun, no time bound — is handed back as-is
 *     (`unchangedReplay: true`, no new test_request_runs row, no fresh
 *     execution) rather than re-running an unchanged tree. Layers 1 and 2
 *     only cover concurrent requests; this is what covers a request that
 *     arrives after its own identical predecessor has already settled.
 *
 * Never throws — a runTestCommands failure surfaces as a `passed: false`
 * result on the returned `result` promise, matching runTestCommands' own
 * contract; only a durable-write failure around it would throw, and even
 * that is caught so a caller awaiting a coalesced run never sees an
 * unhandled rejection.
 */
export function admitTestRequest(
  spec: TestRequestRunSpec,
): TestRequestAdmission {
  const runKind: TestRunKind = spec.runKind ?? 'full';
  const baseSha = spec.baseSha ?? null;
  const sKey = spec.sessionId
    ? sessionKey(spec.projectId, spec.sessionId)
    : null;

  if (sKey) {
    const pending = pendingBySession.get(sKey);
    if (pending) {
      if (
        pending.contentHash === spec.contentHash &&
        pending.runKind === runKind &&
        pending.baseSha === baseSha
      ) {
        return {
          runId: pending.runId,
          reused: true,
          unchangedReplay: false,
          result: pending.promise.then((r) => ({
            ...r,
            joined: true,
            unchangedReplay: false,
          })),
          ...pending.admission(),
        };
      }
      // Stale: this session's pending request was staged against a tree
      // that's since moved on. Per the locked design, a stale pending entry
      // never gets handed back as if current — drop it and fall through to
      // admit fresh. The stale run itself keeps executing to completion in
      // the background; it simply stops being this session's "pending" one.
      pendingBySession.delete(sKey);
    }
  }

  const key = coalesceKey(spec.projectId, spec.contentHash, runKind, baseSha);
  const existing = inFlightRuns.get(key);
  if (existing) {
    const result = existing.promise.then((r) => ({
      ...r,
      joined: true,
      unchangedReplay: false,
    }));
    if (sKey) pendingBySession.set(sKey, existing);
    return {
      runId: existing.runId,
      reused: false,
      unchangedReplay: false,
      result,
      ...existing.admission(),
    };
  }

  // Settled-run guard: nothing is pending or in-flight for this tree, but a
  // prior run for this exact (project, content-hash) may have already
  // finished. Re-executing an identical tree can't produce a different
  // verdict except through flakiness — which has its own path (F2's flaky
  // disposition / flaky.confirm, which invalidates this cache via
  // deleteTestRequestRunsForContentHash before re-requesting) — so hand back
  // that settled result instead of scheduling a fresh run. No time bound: an
  // unchanged tree's result doesn't become valid again with age. Keyed on
  // spec.contentHash, which every caller derives server-side from the live
  // worktree (computeWholeTreeContentHash) — a caller has no way to assert
  // "unchanged" independent of what the server itself recomputed.
  // A settled run that never actually executed (failure_reason ===
  // 'execution_failed', e.g. spawn ENOENT) carries no verdict about this
  // tree at all — it must never be replayed as if it were one. Falling
  // through here means admission proceeds to a fresh execution below, same
  // as if no settled run existed.
  const settled = getLatestTestRequestRun(
    spec.projectId,
    spec.contentHash,
    runKind,
    baseSha,
  );
  if (settled && settled.failure_reason !== 'execution_failed') {
    const replayResult: TestRequestRunResult = {
      passed: settled.state === 'passed',
      output: settled.output,
      timedOut: settled.failure_reason === 'timeout',
      oomKilled: !!settled.oom_killed,
      runId: settled.id,
      joined: false,
      unchangedReplay: true,
    };
    return {
      runId: settled.id,
      status: 'running',
      position: 0,
      queueDepth: 0,
      reused: false,
      unchangedReplay: true,
      result: Promise.resolve(replayResult),
    };
  }

  const requestedAt = Date.now();
  const runId = randomUUID();
  // Durably recorded as 'queued' before the semaphore permit is even
  // requested — a caller can query this row (and a boot-time crash mid-queue
  // is recoverable) from the moment of admission, not just from the moment
  // execution actually starts. See markTestRequestRunRunning below for the
  // transition once the permit is acquired.
  insertTestRequestRun(
    runId,
    spec.projectId,
    spec.contentHash,
    spec.sessionId,
    requestedAt,
    null,
    spec.runOrigin,
    spec.producer,
    'queued',
    runKind,
    baseSha,
  );
  const semaphore = getProjectSemaphore(spec.projectId);
  const permitPromise = semaphore.acquire(runId);
  const admission = () => {
    const queuedPosition = semaphore.positionOf(runId);
    return queuedPosition == null
      ? {
          status: 'running' as const,
          position: 0,
          queueDepth: semaphore.queueDepth(),
        }
      : {
          status: 'queued' as const,
          position: queuedPosition,
          queueDepth: semaphore.queueDepth(),
        };
  };
  const initialAdmission = admission();

  const promise = executeTestRequestRun(
    spec,
    runId,
    requestedAt,
    permitPromise,
  ).finally(() => {
    if (inFlightRuns.get(key)?.runId === runId) inFlightRuns.delete(key);
    if (sKey && pendingBySession.get(sKey)?.runId === runId)
      pendingBySession.delete(sKey);
  });

  const entry: InFlightEntry = {
    runId,
    contentHash: spec.contentHash,
    runKind,
    baseSha,
    admission,
    promise,
  };
  inFlightRuns.set(key, entry);
  if (sKey) pendingBySession.set(sKey, entry);

  return {
    runId,
    reused: false,
    unchangedReplay: false,
    result: promise.then((r) => ({
      ...r,
      joined: false,
      unchangedReplay: false,
    })),
    ...initialAdmission,
  };
}

/**
 * Runs (or joins an already-running/queued) test.request execution for
 * (spec.projectId, spec.contentHash) and resolves once it finishes — the
 * plain awaitable most callers want. A thin wrapper over admitTestRequest
 * for callers that only care about the eventual result, not the live
 * admission status (see admitTestRequest's doc comment for that).
 */
export function runProjectTestRequest(
  spec: TestRequestRunSpec,
): Promise<TestRequestRunResult> {
  return admitTestRequest(spec).result;
}

async function executeTestRequestRun(
  spec: TestRequestRunSpec,
  runId: string,
  requestedAt: number,
  permitPromise: Promise<() => void>,
): Promise<TestCommandResult & { runId: string }> {
  const release = await permitPromise;
  await waitForMemoryAdmission(
    spec.projectId,
    getEffectiveProjectLimit(spec.projectId),
  );

  const semaphore = getProjectSemaphore(spec.projectId);
  const startedAt = Date.now();
  // Peer occupancy right after acquiring, excluding this run itself, so 0
  // genuinely means "ran alone" — matching the concurrent_run_count = 0
  // validity predicate consumers filter on (listRecentValidTestDurations,
  // computeTestFlipRateFlag).
  const concurrentRunCount = semaphore.inUse() - 1;
  // Host-wide peer occupancy: every OTHER project's semaphore, at the same
  // instant — a same-project count of 0 can still mean the host was busy
  // running a different project's suite, which is exactly the contention
  // concurrent_run_count cannot see (projectSemaphores is keyed per project).
  const foreignConcurrentRunCount = getForeignConcurrentRunCount(
    spec.projectId,
  );
  try {
    markTestRequestRunRunning(
      runId,
      startedAt,
      concurrentRunCount,
      foreignConcurrentRunCount,
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
    // Delete any report file left over from a previous run before this run's
    // commands execute — otherwise a command that fails/crashes before its
    // runner's teardown leaves a stale report on disk that would otherwise
    // be indistinguishable from one this run actually wrote.
    if (testReportGlob) {
      clearReportFiles(spec.worktreePath, testReportGlob);
    }
    // The test.request lane never fails fast: every declared command runs
    // regardless of an earlier one failing, so a base probe or session run
    // always yields a complete per-command failing set. Each command is
    // still bounded independently — timeoutSec applies per loop iteration
    // inside runCommandWithTimeout — so this cannot push a run past its
    // configured timeout, only make a run with an early failure run longer.
    const runCommands = () =>
      runTestCommands(
        spec.worktreePath,
        spec.commands,
        spec.timeoutSec,
        (msg) => logger.info(`[testRequestLane] ${msg}`),
        // runId keys the per-run cgroup leaf teardown is verified against
        // (see sessionCgroup.ts's spawnIntoTestRunCgroup) — reusing this
        // run's own durable id means a surviving process is traceable back
        // to this exact test_request_runs row.
        { maxRssMb: spec.maxRssMb, failFast: false, runId },
      );
    // A worktree with no bootstrap_script has no node_modules of its own —
    // it resolves modules through the project checkout's, the same tree a
    // concurrent deploy's install-deps step (npm ci) rewrites wholesale.
    // Serialize against that step; a project whose worktrees provision
    // their own dependencies shares nothing with the checkout and must not
    // pay this lock. See checkoutInstallLock.ts.
    const checkoutDir = getProjectRowById(spec.projectId)?.project_dir;
    const result =
      checkoutDir && sharesCheckoutNodeModules(spec.worktreePath)
        ? await withCheckoutTestRunLock(checkoutDir, runCommands)
        : await runCommands();
    const oomKilled = result.oomKilled ?? false;
    let structuredResult: StructuredTestResult | null = null;
    if (testReportGlob) {
      try {
        structuredResult = collectStructuredTestResult(
          spec.worktreePath,
          testReportGlob,
          spec.commands.length,
          startedAt,
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
      run_origin: spec.runOrigin,
      producer: spec.producer,
      run_kind: spec.runKind ?? 'full',
      base_sha: spec.baseSha ?? null,
      foreign_concurrent_run_count: foreignConcurrentRunCount,
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
 * coalescing promise again — that in-memory state died with the process —
 * so it is marked `failed` (failure_reason 'execution_failed') rather than
 * left stuck. The request that started it already spent its cycle-counter
 * increment at stage time, so this does not grant a free retry against the
 * escalation budget.
 *
 * Deliberately boot-only: "every row still 'running' is stale" is only
 * true immediately after the process starts, when nothing could have
 * legitimately begun executing yet. Do not call this from a periodic,
 * mid-uptime sweep — a genuinely in-flight run's row would get force-failed
 * out from under its still-executing subprocess. See
 * SessionManager.reapMainCgroupOrphans's doc comment for why the periodic
 * main/ orphan sweep does not call this.
 */
export function recoverInterruptedTestRequestRuns(): void {
  // A 'queued' row is exactly as stranded as a 'running' one: its waiter
  // lived only in the crashed process's in-memory Semaphore, so it can never
  // acquire a permit on its own — mark it failed rather than leaving it
  // silently queued forever.
  const stranded = [
    ...listRunningTestRequestRuns(),
    ...listQueuedTestRequestRuns(),
  ];
  for (const run of stranded) {
    logger.warn(
      `[testRequestLane] recovering interrupted run ${run.id} (project ${run.project_id}) as failed`,
    );
    const output =
      '[testRequestLane] backend restarted mid-run — treated as failed';
    completeTestRequestRun(run.id, 'failed', output, 'execution_failed');
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
 * Extracts a completed run's structured_result into a test_run_summaries row
 * (outcome counts), a test_run_results row per *non-passing* test, and a
 * test_perf_baselines digest sample per test (passing included) —
 * denormalizing the run's concurrent_run_count/oom_killed validity signals
 * onto every write. No-op if there's nothing to extract (no
 * structured_result, no tests, or already extracted) — safe to call
 * unconditionally after every run and again from the boot sweep below, which
 * is what makes extraction re-derivable/idempotent rather than a one-shot
 * step that data loss can slip past. hasTestRunSummary (not hasTestRunResults)
 * is the idempotency check — an all-passing run writes zero test_run_results
 * rows, so that table alone can no longer answer "already extracted".
 */
export function ingestTestRunResults(run: TestRequestRunRow): void {
  if (!run.structured_result) return;
  if (hasTestRunSummary(run.id)) return;

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
      failureMessage: test.failureMessage,
      failureTraceExcerpt: test.failureTraceExcerpt,
      markers: test.markers,
    })),
  );
  // An incomplete merge (missing an expected report file) must still write
  // a test_run_summaries row even with zero extracted tests — otherwise the
  // incomplete signal is lost the moment structured_result is nulled, with
  // nothing durable left to distinguish it from a genuine per-test
  // breakdown. See baseHealthCheck.ts's classifyFailedRun.
  if (tests.length === 0 && !parsed.incomplete) return;

  ingestTestRunResultsTx(
    run.id,
    run.project_id,
    tests,
    run.concurrent_run_count ?? null,
    !!run.oom_killed,
    !!parsed.incomplete,
    run.foreign_concurrent_run_count ?? null,
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
 *  1. flagged as unrelated-to-this-diff by either signal, using only samples
 *     predating this PR's own runs (`beforeMs`, keyed off the PR's
 *     created_at):
 *       - flip-rate flagged (pass<->fail alternation), or
 *       - breadth flagged (failed across `breadthN`+ distinct content
 *         hashes within the lookback window) — a deterministically-failing
 *         test never alternates, so this is what makes it reachable at all
 *     Purely additive: either signal alone is sufficient, so nothing that
 *     already cleared guard 1 via flip-rate stops doing so.
 *  2. the PR's diff (`changedFiles`) does not touch the test's own file,
 *     confidently resolved (isTestIdTouchedByChangedFiles fails closed —
 *     an unmappable test_id blocks auto-disposition, same as a touched file)
 *
 * A run with no per-test detail (structured_result never ingested) is never
 * eligible — there's nothing to individually clear, so it must route through
 * the unmodified session pause+nudge path per the locked design.
 *
 * `baseExcusedTestIds` (default empty) is the set of test ids the gate-level
 * baseAttributableFilter (see orchestration/baseAttributableFilter.ts's
 * applyF2GateMaskingGuards) already excused for this same run — the two
 * filters are independent per-test checks over the same failing-test set, so
 * a test in this set is skipped here entirely rather than re-evaluated: it's
 * already excused, and this function must not veto it just because it
 * doesn't separately clear the flip-rate/breadth signal.
 */
export function evaluateF2LaneFlakyDisposition(
  testRequestRunId: string,
  beforeMs: number,
  changedFiles: string[],
  flipRateWindowN: number,
  flipRateThresholdK: number,
  breadthN: number,
  breadthWindowHours: number,
  baseExcusedTestIds: ReadonlySet<string> = new Set(),
): boolean {
  const failing = getFailingTestIdsForRun(testRequestRunId).filter(
    (t) => !baseExcusedTestIds.has(t.test_id),
  );
  if (failing.length === 0) return baseExcusedTestIds.size > 0;

  for (const test of failing) {
    const flipFlag = computeTestFlipRateFlag(
      test.test_id,
      flipRateWindowN,
      flipRateThresholdK,
      beforeMs,
    );
    const breadthFlag = computeTestFailureBreadthFlag(
      test.test_id,
      breadthWindowHours,
      breadthN,
      beforeMs,
    );
    if (!flipFlag.flagged && !breadthFlag.flagged) return false;

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

/** Default per-call cap for sweepTestRunResultsExtraction — see its doc comment. */
export const EXTRACTION_SWEEP_DEFAULT_CAP = 50;

export interface ExtractionSweepResult {
  /** Number of runs this call actually extracted. */
  processed: number;
  /** True total still needing extraction after this call, across the whole table. */
  remaining: number;
}

/**
 * Re-derivation sweep: catches runs with a structured_result but no
 * extracted test_run_results rows — a crash mid-ingestion, or a run
 * completed before this extraction step existed — and ingests them. A
 * delay, never data loss, since extraction is fully re-derivable from the
 * run row.
 *
 * Bounded per call by `cap` (default EXTRACTION_SWEEP_DEFAULT_CAP) rather
 * than draining the whole work list inline — the boot chain calls this once
 * with the boot cap, and a Scheduler job (see server.ts's
 * test_run_results_extraction_drain registration) drains whatever the boot
 * pass left behind over subsequent ticks. Yields to the event loop between
 * each unit of work (`setImmediate`) so a synchronous, potentially
 * long-running sweep never blocks the accept queue the way the prior
 * unbounded inline loop did.
 *
 * Also realizes the lone-key own-row structured_result clear: a run whose
 * (project_id, content_hash) key has no other row is never touched by
 * clearSupersededStructuredResults (the synchronous completion path's own
 * clear, which only ever clears an *other* row), so without this pass its
 * blob would be retained forever once extracted. This must stay a
 * boot/scheduler-tick concern — clearing it inline right after
 * ingestTestRunResults in the synchronous completion path would race
 * stagedIntents.ts's session-feedback digest read of that same row. The
 * clearing phase below scans for *every* already-extracted-but-uncleared row
 * (not just the ones this call happened to extract), so it also catches rows
 * extracted synchronously by the hot completion path itself.
 */
export async function sweepTestRunResultsExtraction(
  opts: { cap?: number; onProgress?: (remaining: number) => void } = {},
): Promise<ExtractionSweepResult> {
  const cap = opts.cap ?? EXTRACTION_SWEEP_DEFAULT_CAP;
  const pending = listTestRequestRunsNeedingExtraction(cap);
  let processed = 0;
  for (const run of pending) {
    logger.info(
      `[testRequestLane] extracting test_run_results for run ${run.id} (project ${run.project_id})`,
    );
    ingestTestRunResults(run);
    processed++;
    opts.onProgress?.(pending.length - processed);
    // Yield between units — this is a boot/scheduler-tick step, not a route
    // handler, but it still shares the event loop with anything the server
    // is doing while it runs (accept(), health checks, other jobs).
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const remaining = countTestRequestRunsNeedingExtraction();

  let clearedInBatch: number;
  do {
    clearedInBatch = clearExtractedStructuredResultsBatch(
      STRUCTURED_RESULT_CLEAR_BATCH_CAP,
    );
    if (clearedInBatch > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } while (clearedInBatch === STRUCTURED_RESULT_CLEAR_BATCH_CAP);

  return { processed, remaining };
}
