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
 *  - Bounded concurrency: a single host-wide Semaphore (the same class
 *    tasks/deferralClassifier.ts uses to bound classify subprocesses) caps
 *    how many test runs can be in flight at once, across every project —
 *    there is no per-project cap, only one shared FIFO budget — and
 *    admission additionally folds in the host memory-headroom check
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
import { EventEmitter } from 'events';
import { Semaphore, LaneRunWithdrawnError } from '../tasks/deferralClassifier';
import { recordEvent } from '../audit/AuditLog';
import {
  runTestCommands,
  collectStructuredTestResultOffMainThread,
  clearReportFiles,
  isTestIdTouchedByChangedFiles,
  type TestCommandResult,
} from '../session/test-runner';
import { hasTestRequestAdmission } from './memoryAdmission';
import {
  loadOrchestratorConfig,
  type ToolVersionCheck,
} from '../session/orchestrator-config';
import {
  withCheckoutTestRunLock,
  sharesCheckoutNodeModules,
} from './checkoutInstallLock';
import { checkToolchainVersions, formatToolchainMismatch } from './gateEnv';
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
  runHasExtractedReport,
  getTestRunSummary,
  ingestTestRunResultsTx,
  upsertTestPerfBaseline,
  computeTestFlipRateFlag,
  computeTestFlipRateFlagFromOutcomes,
  computeTestFailureBreadthFlag,
  getFailingTestIdsForRun,
  getProjectRowById,
  getLatestTestRequestRun,
  listQueuedTestRequestRunsForWorktree,
  withdrawTestRequestRun,
  ingestTestRunResultsOffMainThread,
} from '../db/queries';
import { db } from '../db/db';
import type {
  TestRequestFailureReason,
  TestRequestRunRow,
  StructuredTestResult,
  NewTestRunResultRow,
  RunOrigin,
  TestRunProducer,
  TestRunKind,
} from '../db/types';
import type { TestPerfDigestSampleResult } from '../db/queries';
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

/**
 * In-process settle notifications, parallel to (never a replacement for) the
 * WS broadcast above — a same-process reader like PRMergeWatcher that wants
 * to react to a settle immediately can subscribe here instead of waiting for
 * its own poll tick to re-read test_request_runs. Emitted right alongside
 * every broadcastRunStatus call that reports a genuinely fresh settle
 * (passed/failed), never for 'running' or for the boot-time interrupted-run
 * recovery sweep, which settles rows nothing is live to react to.
 */
export interface TestRequestLaneSettledEvent {
  projectId: string;
  contentHash: string;
  runKind: TestRunKind;
  state: 'passed' | 'failed';
}

export const testRequestLaneEvents = new EventEmitter();

function emitSettled(event: TestRequestLaneSettledEvent): void {
  testRequestLaneEvents.emit('settled', event);
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
   * 'base_health_probe' is historical only (the now-deleted baseHealthCheck.ts
   * was its sole producer), 'pr_pipeline' for PreReviewPipeline.ts/
   * ReviewOrchestrator.ts, null for an ordinary session-attributed
   * test.request. Required so every call site states its own identity
   * rather than relying on sessionId's absence — sessionId is null for both
   * a historical base-probe row and a PR-branch run, and only run_origin
   * distinguishes them.
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
  /**
   * Stop running subsequent commands after the first failure — forwarded to
   * runTestCommands, which otherwise always runs every declared command
   * (see that function's own doc comment on why: a session/base-probe run
   * wants a complete per-command failing set). A verify run wants the
   * opposite — it fails fast, same as runVerifyAsGate did — so this
   * defaults to false, preserving every existing caller's behavior, and only
   * PreReviewPipeline's verify stage passes true.
   */
  failFast?: boolean;
  /**
   * Env to spawn each command with, instead of `process.env` — see
   * gateEnv.ts's buildScopedEnv. Omitted (default) = today's
   * inherited-environment behavior, unchanged.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Toolchain versions this run expects (see gateEnv.ts's
   * checkToolchainVersions) — checked once, before any command runs, right
   * after the semaphore permit is acquired. A mismatch completes the run as
   * `failed` with failure_reason 'tool_infra_failure' and no command is ever
   * spawned. Omitted/empty (default) skips the check entirely, unchanged
   * from today's behavior.
   */
  expectedToolVersions?: ToolVersionCheck[];
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
  /**
   * True when this run was withdrawn while still queued — never executed —
   * because a newer request superseded it: either a same-worktree request
   * with a different content_hash (see admitTestRequest's stale-run
   * withdrawal), or a PR-driven event (merge/close/new-head, see
   * withdrawQueuedRunsForWorktree). A caller must treat this as neither a
   * pass nor a genuine fail — see this module's doc comment on the reverse
   * of the "stale run keeps executing" decision.
   */
  superseded?: boolean;
  /** The newer run's id, or a PR-driven marker ('pr_merged' | 'pr_closed' | 'head_moved'). Present only when `superseded` is true. */
  supersededBy?: string;
}

/** A caller's live standing in the lane: running now, or queued behind others. */
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
  if (result.isToolInfraFailure) return 'tool_infra_failure';
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
 * The host-wide concurrency cap: runtimeSettings.test_request_max_concurrent.
 * Every project shares this single budget — there is no per-project override.
 */
function getGlobalTestRunLimit(): number {
  return typedGetSetting('test_request_max_concurrent');
}

let globalTestRunSemaphore: Semaphore | null = null;

/**
 * Returns the single module-level semaphore shared by every project,
 * resizing it in place whenever the configured global limit
 * (getGlobalTestRunLimit) has changed since it was created — so editing the
 * setting takes effect on the very next acquire, no backend restart needed.
 * FIFO ordering of this one semaphore's wait queue is what gives every
 * project a single, shared queue position rather than a per-project one.
 */
function getGlobalTestRunSemaphore(): Semaphore {
  const limit = getGlobalTestRunLimit();
  if (!globalTestRunSemaphore) {
    globalTestRunSemaphore = new Semaphore(limit);
  } else if (globalTestRunSemaphore.capacity() !== limit) {
    globalTestRunSemaphore.resize(limit);
  }
  return globalTestRunSemaphore;
}

/**
 * Count of in-flight (running) runs belonging to a project other than
 * `projectId`, computed from the lane's own inFlightRuns map rather than
 * from any per-project semaphore (there is only the one global semaphore
 * now). "In-flight" here means admitted and past the permit wait — a queued
 * run isn't occupying a slot yet, so isn't a foreign peer.
 */
function getForeignConcurrentRunCount(projectId: string): number {
  let total = 0;
  for (const entry of inFlightRuns.values()) {
    if (entry.projectId === projectId) continue;
    if (entry.admission().status === 'running') total++;
  }
  return total;
}

/**
 * Test-only: clears the cached global semaphore and the lane's in-flight
 * bookkeeping (inFlightRuns/pendingBySession). All three are deliberately
 * process-lifetime state in production (host-wide occupancy must persist
 * across runs), but that means a single test elsewhere in the suite that
 * intentionally never resolves its mocked run (to exercise queued/running
 * state) leaves a permanently nonzero inUse() and a dangling inFlightRuns
 * entry — the latter would otherwise silently poison every later test's
 * getForeignConcurrentRunCount, which sums across every entry regardless of
 * which test created it. Call from a suite's beforeEach to isolate tests
 * from each other.
 */
export function __resetProjectSemaphoresForTest(): void {
  globalTestRunSemaphore = null;
  inFlightRuns.clear();
  pendingBySession.clear();
}

/**
 * Withdraws one still-queued row: removes it from the global
 * Semaphore's wait queue (rejecting its parked executeTestRequestRun's
 * permitPromise with LaneRunWithdrawnError — caught there and resolved as a
 * `superseded: true` result, never a hard failure/reject the caller has to
 * handle), marks the durable row failed/superseded, broadcasts a
 * 'withdrawn' status, and records one test_run_withdrawn audit event.
 * Returns false (no-op) when the row is no longer queued (already running,
 * or already withdrawn by a race) — Semaphore.withdraw is the single source
 * of truth for that race, not a separate DB read.
 */
function withdrawQueuedRun(
  run: TestRequestRunRow,
  reason: 'same_worktree' | 'pr_merged' | 'pr_closed' | 'head_moved',
  supersededBy: string,
  prContext?: { prNumber: number; repo: string },
): boolean {
  const semaphore = getGlobalTestRunSemaphore();
  if (!semaphore.withdraw(run.id, supersededBy)) return false;
  withdrawTestRequestRun(run.id, supersededBy);
  broadcastRunStatus({
    runId: run.id,
    projectId: run.project_id,
    contentHash: run.content_hash,
    status: 'withdrawn',
    sessionId: run.session_id,
    requestedAt: run.requested_at ?? undefined,
    startedAt: run.started_at,
    finishedAt: Date.now(),
  });
  recordEvent({
    event_type: 'test_run_withdrawn',
    actor_type: 'system',
    project_id: run.project_id,
    payload: {
      runId: run.id,
      reason,
      supersededBy,
      ...(prContext
        ? { prNumber: prContext.prNumber, repo: prContext.repo }
        : {}),
    },
  });
  return true;
}

/**
 * Same-worktree supersession: withdraws every still-queued run for
 * (projectId, worktreePath) whose content_hash differs from the arriving
 * request's — those runs were staged against a tree that's since moved on
 * and would produce a verdict nobody reads. A queued run with the *same*
 * content_hash (a scoped run alongside a full run, e.g.) is left alone —
 * that's a distinct execution against the identical tree, not stale.
 * Applies regardless of session_id/producer: a session's own queued full
 * run and the pipeline's pr_gate request share this same worktree-scoped
 * check.
 */
function withdrawStaleSameWorktreeRuns(
  projectId: string,
  worktreePath: string,
  contentHash: string,
  newRunId: string,
): void {
  const queued = listQueuedTestRequestRunsForWorktree(projectId, worktreePath);
  for (const run of queued) {
    if (run.content_hash === contentHash) continue;
    withdrawQueuedRun(run, 'same_worktree', newRunId);
  }
}

/**
 * PR-driven withdrawal: withdraws every still-queued run for (projectId,
 * worktreePath) regardless of content_hash — called on pr_merged/pr_closed
 * (PRMergeWatcher's state-change path and AutoMerger's merge path) and on
 * push_detected with a new head (PRMergeWatcher.handlePushDetected), where
 * every queued run against that worktree is stale the moment the PR
 * terminalized or its head moved. Returns the count actually withdrawn, for
 * callers that want to log/short-circuit.
 */
export function withdrawQueuedRunsForWorktree(
  projectId: string,
  worktreePath: string,
  reason: 'pr_merged' | 'pr_closed' | 'head_moved',
  prContext?: { prNumber: number; repo: string },
): number {
  const queued = listQueuedTestRequestRunsForWorktree(projectId, worktreePath);
  let count = 0;
  for (const run of queued) {
    if (withdrawQueuedRun(run, reason, reason, prContext)) count++;
  }
  return count;
}

interface InFlightEntry {
  runId: string;
  projectId: string;
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
  globalLimit: number,
): Promise<void> {
  const deadline = Date.now() + ADMISSION_MAX_WAIT_MS;
  const semaphore = getGlobalTestRunSemaphore();
  while (Date.now() < deadline) {
    // inUse() includes the permit this call itself already holds — subtract
    // it so the check reflects peer occupancy (host-wide, across every
    // project), matching hasTestRequestAdmission's documented "before
    // admitting the caller's own request" contract (and how
    // concurrentRunCount is computed a few lines below in the caller).
    if (hasTestRequestAdmission(semaphore.inUse() - 1, globalLimit)) return;
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
        withdrawStaleSameWorktreeRuns(
          spec.projectId,
          spec.worktreePath,
          spec.contentHash,
          pending.runId,
        );
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
    withdrawStaleSameWorktreeRuns(
      spec.projectId,
      spec.worktreePath,
      spec.contentHash,
      existing.runId,
    );
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
  // tree at all — it must never be replayed as if it were one. Nor does a
  // settled 'passed' run whose structured_result never got extracted despite
  // a report glob being configured (test_report_acquisition_attempted = 1):
  // that's the same shape AgentSession's PR-open gate treats as
  // isVacuousResult(null) and refuses to open a PR against, so replaying it
  // forever would permanently block PR creation for this tree with no
  // escape path. getLatestTestRequestRun's own squat-guard SQL excludes both
  // shapes from the lookup below. Falling through here means admission
  // proceeds to a fresh execution, same as if no settled run existed.
  const settled = getLatestTestRequestRun(
    spec.projectId,
    spec.contentHash,
    runKind,
    baseSha,
  );
  if (
    settled &&
    settled.failure_reason !== 'execution_failed' &&
    settled.failure_reason !== 'superseded'
  ) {
    withdrawStaleSameWorktreeRuns(
      spec.projectId,
      spec.worktreePath,
      spec.contentHash,
      settled.id,
    );
    const replayResult: TestRequestRunResult = {
      passed: settled.state === 'passed',
      output: settled.output,
      timedOut: settled.failure_reason === 'timeout',
      oomKilled: !!settled.oom_killed,
      failedCommand: settled.failed_command ?? undefined,
      isToolInfraFailure: settled.failure_reason === 'tool_infra_failure',
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
    spec.worktreePath,
  );
  withdrawStaleSameWorktreeRuns(
    spec.projectId,
    spec.worktreePath,
    spec.contentHash,
    runId,
  );
  const semaphore = getGlobalTestRunSemaphore();
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
    projectId: spec.projectId,
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

/** A caller-facing snapshot of an in-flight lane entry — see findQueuedOrRunningTestRequest. */
export interface QueuedOrRunningTestRequest {
  runId: string;
  runKind: TestRunKind;
  status: TestRequestAdmissionStatus;
  /** 1-indexed position among queued waiters; 0 while running. */
  position: number;
  queueDepth: number;
}

/**
 * Read-only lookup of whether a run for (projectId, contentHash) is already
 * queued/running in this lane, without admitting a new request — for a
 * caller that wants to *tell* a session about an in-flight run rather than
 * join or start one (AgentSession's PR-open gate refusal message). Matches
 * any run_kind/base_sha for the pair, since the PR-open gate itself checks
 * both a full and a scoped run and just needs to know "something is already
 * in flight for this tree" to avoid telling a session to re-request one.
 */
export function findQueuedOrRunningTestRequest(
  projectId: string,
  contentHash: string,
): QueuedOrRunningTestRequest | undefined {
  const keyPrefix = `${projectId}:${contentHash}:`;
  for (const [key, entry] of inFlightRuns) {
    if (!key.startsWith(keyPrefix)) continue;
    return {
      runId: entry.runId,
      runKind: entry.runKind,
      ...entry.admission(),
    };
  }
  return undefined;
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
): Promise<
  TestCommandResult & {
    runId: string;
    superseded?: boolean;
    supersededBy?: string;
  }
> {
  let release: () => void;
  try {
    release = await permitPromise;
  } catch (err) {
    if (err instanceof LaneRunWithdrawnError) {
      // The durable row/broadcast/audit event were already written by
      // whichever withdrawStaleSameWorktreeRuns/withdrawQueuedRunsForWorktree
      // call withdrew this run from the semaphore's queue — nothing left to
      // record here, just resolve (never reject) so admitTestRequest's
      // `result` promise settles with a superseded verdict instead of an
      // unhandled rejection.
      return {
        passed: false,
        output: `[testRequestLane] withdrawn — superseded by ${err.supersededBy}`,
        runId,
        superseded: true,
        supersededBy: err.supersededBy,
      };
    }
    throw err;
  }
  await waitForMemoryAdmission(spec.projectId, getGlobalTestRunLimit());

  const semaphore = getGlobalTestRunSemaphore();
  const startedAt = Date.now();
  // Host-wide peer occupancy right after acquiring, excluding this run
  // itself, so 0 genuinely means "ran alone" — matching the
  // concurrent_run_count = 0 validity predicate consumers filter on
  // (listRecentValidTestDurations, computeTestFlipRateFlag). Now that the
  // semaphore is global, this already reflects every project's occupancy,
  // not just this run's own project.
  const concurrentRunCount = semaphore.inUse() - 1;
  // The other-project subset of that same host-wide occupancy — derived
  // from the lane's in-flight runs (there's only the one global semaphore
  // now, so it can't itself distinguish same- vs other-project peers).
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
    // Toolchain-version preflight, checked once before any command runs —
    // mirrors runVerifyAsGate's own pre-execution check. A mismatch reflects
    // the invoking host's toolchain, not the code under review, so it
    // completes the run without ever spawning a command.
    if (spec.expectedToolVersions && spec.expectedToolVersions.length > 0) {
      const mismatch = await checkToolchainVersions(
        spec.worktreePath,
        spec.expectedToolVersions,
      );
      if (mismatch) {
        const reason = formatToolchainMismatch(mismatch);
        completeTestRequestRun(runId, 'failed', reason, 'tool_infra_failure');
        clearSupersededStructuredResults(
          spec.projectId,
          spec.contentHash,
          runId,
        );
        broadcastRunStatus({
          runId,
          projectId: spec.projectId,
          contentHash: spec.contentHash,
          status: 'failed-with-cause',
          output: reason,
          sessionId: spec.sessionId,
          requestedAt,
          startedAt,
          finishedAt: Date.now(),
        });
        emitSettled({
          projectId: spec.projectId,
          contentHash: spec.contentHash,
          runKind: spec.runKind ?? 'full',
          state: 'failed',
        });
        return {
          passed: false,
          output: reason,
          runId,
          isToolInfraFailure: true,
          toolFailureReason: reason,
        };
      }
    }
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
    // Every ordinary test.request caller wants failFast: false — every
    // declared command runs regardless of an earlier one failing, so a base
    // probe or session run always yields a complete per-command failing set.
    // A verify run (spec.failFast) wants the opposite, matching
    // runVerifyAsGate's own fail-fast semantics. Each command is still
    // bounded independently — timeoutSec applies per loop iteration inside
    // runCommandWithTimeout — so this cannot push a run past its configured
    // timeout, only make a run with an early failure run longer.
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
        {
          maxRssMb: spec.maxRssMb,
          failFast: spec.failFast ?? false,
          runId,
          env: spec.env,
        },
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
        // Off the main thread — for a large suite, collectStructuredTestResult's
        // readFileSync + JUnit-XML regex parse is real synchronous I/O+CPU
        // work, and this handler is shared with every other request the
        // backend serves. Awaited (not fire-and-forget): structured_result
        // must be computed as one atomic step before completeTestRequestRun
        // writes it and the run is broadcast as settled, exactly as before
        // this moved off-thread — only the I/O itself no longer blocks the
        // event loop while in flight.
        structuredResult = await collectStructuredTestResultOffMainThread(
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
      result.passed ? null : (result.failedCommand ?? null),
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
    emitSettled({
      projectId: spec.projectId,
      contentHash: spec.contentHash,
      runKind: spec.runKind ?? 'full',
      state: result.passed ? 'passed' : 'failed',
    });
    // Fire-and-forget: dispatch is off the main thread (worker thread for a
    // file-backed db) and single-flighted per project — never awaited here,
    // so a large suite's extraction/baseline recompute never delays this
    // completion handler's return. Errors are logged, not thrown — an
    // ingestion failure never fails the run itself, and sweepTestRunResultsExtraction
    // picks up anything left unextracted.
    void ingestTestRunResults({
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
      worktree_path: spec.worktreePath,
      superseded_by: null,
      failed_command: result.passed ? null : (result.failedCommand ?? null),
    }).catch((err) => {
      logger.error(
        `[testRequestLane] ingestion dispatch failed for run ${runId}:`,
        err,
      );
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
    emitSettled({
      projectId: spec.projectId,
      contentHash: spec.contentHash,
      runKind: spec.runKind ?? 'full',
      state: 'failed',
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
 * A 'queued' row is exactly as stranded as a 'running' one: its waiter lived
 * only in the crashed process's in-memory Semaphore, so it can never acquire
 * a permit on its own — but it never dequeued, so its test commands never
 * started. It is marked `failed` with failure_reason 'interrupted_queued'
 * rather than 'execution_failed', so the durable record still distinguishes
 * "was executing when the backend restarted" from "was merely waiting for a
 * concurrency slot" — collapsing the two into one output/reason made the two
 * cases indistinguishable after the fact (started_at is populated on a
 * queued row too, so it can't stand in for "began executing" either).
 *
 * Deliberately boot-only: "every row still 'running'/'queued' is stale" is
 * only true immediately after the process starts, when nothing could have
 * legitimately begun executing (or still be waiting to) yet. Do not call
 * this from a periodic, mid-uptime sweep — a genuinely in-flight run's row
 * would get force-failed out from under its still-executing subprocess, and
 * a genuinely queued row out from under its still-live waiter. See
 * SessionManager.reapMainCgroupOrphans's doc comment for why the periodic
 * main/ orphan sweep does not call this.
 */
export function recoverInterruptedTestRequestRuns(): void {
  const sweeps: Array<{
    runs: TestRequestRunRow[];
    failureReason: TestRequestFailureReason;
    output: string;
  }> = [
    {
      runs: listRunningTestRequestRuns(),
      failureReason: 'execution_failed',
      output: '[testRequestLane] backend restarted mid-run — treated as failed',
    },
    {
      runs: listQueuedTestRequestRuns(),
      failureReason: 'interrupted_queued',
      output:
        '[testRequestLane] backend restarted while queued — run never began executing',
    },
  ];
  for (const { runs, failureReason, output } of sweeps) {
    for (const run of runs) {
      logger.warn(
        `[testRequestLane] recovering interrupted run ${run.id} (project ${run.project_id}) as failed (${failureReason})`,
      );
      completeTestRequestRun(run.id, 'failed', output, failureReason);
      clearSupersededStructuredResults(
        run.project_id,
        run.content_hash,
        run.id,
      );
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
}

/**
 * Per-project FIFO queue for ingestTestRunResults dispatches — two runs of
 * the same project settling within the same tick must not race two
 * worker-thread connections against the same on-disk file:
 * recordTestPerfDigestSample's read-modify-write of a test's digest would
 * last-writer-wins across connections otherwise (see
 * db/testRunIngestionWorker.ts's own doc comment). Unrelated projects
 * ingest independently — this is per-project, not global. A rejected task
 * is swallowed on the queue itself (so a failed dispatch never wedges every
 * later dispatch for the same project) but still surfaces to its own
 * caller, since `next` (the value returned to the caller) is the
 * unswallowed promise.
 */
const projectIngestionQueues = new Map<string, Promise<void>>();

function enqueueProjectIngestion(
  projectId: string,
  task: () => Promise<void>,
): Promise<void> {
  const prior = projectIngestionQueues.get(projectId) ?? Promise.resolve();
  const next = prior.then(task, task);
  projectIngestionQueues.set(
    projectId,
    next.catch(() => undefined),
  );
  return next;
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
 * step that data loss can slip past. runHasExtractedReport (not
 * hasTestRunResults) is the idempotency check — an all-passing run writes
 * zero test_run_results rows, so that table alone can no longer answer
 * "already extracted".
 *
 * The actual extraction/digest/baseline writes are dispatched off the main
 * thread via ingestTestRunResultsOffMainThread (db/queries.ts) — a large
 * suite's baseline recompute was measured blocking the main thread's event
 * loop for tens of seconds; see db/testRunIngestionWorker.ts. Dispatch is
 * serialized per project through enqueueProjectIngestion above. Falls back
 * to the synchronous in-process path (unchanged from before this worker
 * existed) for a `:memory:`/test-mode database, which has no on-disk file a
 * worker thread could open.
 */
export async function ingestTestRunResults(
  run: TestRequestRunRow,
): Promise<void> {
  if (!run.structured_result) return;

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
  // breakdown. See this module's own classifyFailedRun, below.
  const incomplete = !!parsed.incomplete;
  if (tests.length === 0 && !incomplete) return;

  await enqueueProjectIngestion(run.project_id, () =>
    dispatchIngestion(run, tests, incomplete),
  );
}

async function dispatchIngestion(
  run: TestRequestRunRow,
  tests: NewTestRunResultRow[],
  incomplete: boolean,
): Promise<void> {
  const windowN = typedGetSetting('flip_rate_window_n');
  const thresholdK = typedGetSetting('flip_rate_threshold_k');
  await ingestTestRunResultsOffMainThread(
    db.name,
    {
      testRequestRunId: run.id,
      projectId: run.project_id,
      tests,
      concurrentRunCount: run.concurrent_run_count ?? null,
      oomKilled: !!run.oom_killed,
      incomplete,
      foreignConcurrentRunCount: run.foreign_concurrent_run_count ?? null,
      contentHash: run.content_hash,
      flipRateWindowN: windowN,
      flipRateThresholdK: thresholdK,
    },
    // Synchronous in-process fallback for a `:memory:`/test-mode database —
    // ingestTestRunResultsTx's onDigestSample callback only fires for a
    // test whose sample recordTestPerfDigestSample actually recorded — a
    // non-solo run (a concurrent peer, an OOM kill, or a foreign concurrent
    // run) never updates its digests, so recomputing baselines/flip-rate
    // flags from those unchanged digests would just be wasted work reading/
    // writing what's already on disk. Skipping this loop entirely for those
    // runs is the fix: 284 of 297 runs ingested since deploy were non-solo.
    () => {
      if (runHasExtractedReport(run.id)) return;
      const sampledTests = new Map<string, TestPerfDigestSampleResult>();
      ingestTestRunResultsTx(
        run.id,
        run.project_id,
        tests,
        run.concurrent_run_count ?? null,
        !!run.oom_killed,
        incomplete,
        run.foreign_concurrent_run_count ?? null,
        run.content_hash,
        (testId, sample) => {
          sampledTests.set(testId, sample);
          computeTestPerfBaseline(testId, [...sample.durations].reverse());
        },
      );
      recomputeFlipRateFlags(sampledTests);
    },
  );
}

/**
 * A failed run has a per-test breakdown (`partial_fail`) only when one
 * exists for it AND that breakdown is complete — otherwise (no breakdown at
 * all, or a partial multi-command merge missing an expected suite's report
 * entirely, e.g. an OOM-kill before that report was written) it's
 * `total_fail`. Relocated from the deleted baseHealthCheck.ts (this was its
 * classifyFailedRun) — classifyTestRunOutcome (below) is its sole surviving
 * consumer.
 *
 * The durable source of the breakdown is test_run_summaries/test_run_results
 * (this module's own extraction output), not test_request_runs.structured_result
 * — that column is cleared once extraction has consumed it
 * (clearExtractedStructuredResultsBatch), so a null structured_result on an
 * already-extracted run means "already processed", never "crashed". The
 * extraction summary's own `incomplete` flag (mirroring
 * StructuredTestResult.incomplete, see db/schema.ts) is what survives that
 * clear and lets an incomplete merge still classify as total_fail
 * post-sweep. structured_result is only consulted as a fallback for a run
 * that hasn't been swept (or extracted) yet — gated by runHasExtractedReport,
 * the same durable-record predicate every other structured_result-null
 * reader now uses, rather than reading a null structured_result itself as
 * "no report".
 */
function classifyFailedRun(
  run: TestRequestRunRow,
): 'partial_fail' | 'total_fail' {
  if (runHasExtractedReport(run.id)) {
    const summary = getTestRunSummary(run.id)!;
    if (summary.incomplete) return 'total_fail';
    return summary.total_count > 0 ? 'partial_fail' : 'total_fail';
  }

  if (!run.structured_result) return 'total_fail';
  try {
    const parsed = JSON.parse(run.structured_result) as StructuredTestResult;
    // A merge missing one or more expected report files (e.g. a command
    // crashed/OOM-killed before writing its report) is never a mere partial
    // failure of the suites it did capture — an entire suite never ran, so
    // this must not look identical to an ordinary named-test failure.
    if (parsed.incomplete) return 'total_fail';
    const totalTests =
      (parsed.totals?.passed ?? 0) +
      (parsed.totals?.failed ?? 0) +
      (parsed.totals?.skipped ?? 0) +
      (parsed.totals?.errors ?? 0);
    if (totalTests > 0) return 'partial_fail';
  } catch {
    // Unparseable structured_result carries no usable per-test breakdown.
  }
  return 'total_fail';
}

/**
 * The Tests tab's run outcome taxonomy — reuses classifyFailedRun's
 * clean/partial/total split, splitting `total_fail` further via
 * failure_reason and oom_killed (both already recorded per run) into its
 * three distinct causes. Each outcome carries its own next-action string
 * for the tab to render alongside the run.
 *
 * `passed-scoped` is its own outcome, not `passed` — a scoped run (run_kind
 * = 'scoped', see TestRunKind) only ever exercised the tests its base-diff
 * scoping selected, so a clean result from it is not the same confirmation
 * a full-suite `passed` is. Collapsing the two would let a scoped pass read
 * as "the whole suite is green" when it never ran the whole suite.
 */
type TestRunOutcome =
  | 'passed'
  | 'passed-scoped'
  | 'failed-with-named-tests'
  | 'failed-with-no-report-acquired'
  | 'crashed-oom'
  | 'timed-out'
  | 'execution-failed'
  | 'running'
  | 'queued';

export interface TestRunOutcomeInfo {
  outcome: TestRunOutcome;
  nextAction: string;
}

const TEST_RUN_NEXT_ACTIONS: Record<TestRunOutcome, string> = {
  passed: 'No action needed — all tests passed.',
  'passed-scoped':
    'The tests scoped to this diff passed — this is not a full-suite confirmation.',
  'failed-with-named-tests':
    'Review the named failing tests below and fix them.',
  'failed-with-no-report-acquired':
    'No per-test report was produced — check the raw run output for a crash before any report was written.',
  'crashed-oom':
    'The test run was OOM-killed — reduce test memory usage/parallelism, or retry.',
  'timed-out':
    'The test run exceeded its time limit — investigate a hang or split the run.',
  'execution-failed':
    'The test runner could not be started (e.g. spawn failure) — no test ever ran. This is an infrastructure failure, not a test result; retry.',
  running: 'Run is still in progress — wait for it to finish.',
  queued: 'Run is queued — waiting for a lane concurrency slot to open.',
};

export function classifyTestRunOutcome(
  run: TestRequestRunRow,
): TestRunOutcomeInfo {
  let outcome: TestRunOutcome;
  if (run.state === 'queued') {
    outcome = 'queued';
  } else if (run.state === 'running') {
    outcome = 'running';
  } else if (run.state === 'passed') {
    outcome = run.run_kind === 'scoped' ? 'passed-scoped' : 'passed';
  } else if (
    run.failure_reason === 'execution_failed' ||
    run.failure_reason === 'interrupted_queued'
  ) {
    outcome = 'execution-failed';
  } else if (run.oom_killed || run.failure_reason === 'oom_killed') {
    outcome = 'crashed-oom';
  } else if (run.failure_reason === 'timeout') {
    outcome = 'timed-out';
  } else if (classifyFailedRun(run) === 'partial_fail') {
    outcome = 'failed-with-named-tests';
  } else {
    outcome = 'failed-with-no-report-acquired';
  }
  return { outcome, nextAction: TEST_RUN_NEXT_ACTIONS[outcome] };
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
 * Recomputes and persists the rolling baseline for a single test_id from a
 * caller-supplied newest-first window of its most recent valid durations
 * (see listRecentValidTestDurations's contract, which this used to read
 * directly — the ingestion path now passes the post-record digest state it
 * already has in memory instead, so this never touches the database itself
 * beyond the upsert). A no-op (no write) if `durations` is empty. Called
 * inline for every test_id a just-extracted run recorded a digest sample
 * for, per the locked design's "updated per ingestion" language.
 */
export function computeTestPerfBaseline(
  testId: string,
  durations: number[],
): void {
  const samples = durations.slice(
    0,
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
 * Re-evaluates the flip-rate flag for every test id that got a recorded
 * digest sample from this ingestion, from the post-push outcome ring
 * ingestTestRunResultsTx's onDigestSample callback already captured — never
 * a fresh recent_outcomes read, since the in-memory state is byte-identical
 * to what a re-read would return. The flag is never persisted (see
 * computeTestFlipRateFlag) — this just surfaces the freshly recomputed state
 * to the log, since a fresh ingestion is exactly the moment a test's window
 * (and therefore its flag) can change.
 */
function recomputeFlipRateFlags(
  sampledTests: Map<string, TestPerfDigestSampleResult>,
): void {
  const windowN = typedGetSetting('flip_rate_window_n');
  const thresholdK = typedGetSetting('flip_rate_threshold_k');
  for (const [testId, sample] of sampledTests) {
    const flag = computeTestFlipRateFlagFromOutcomes(
      testId,
      sample.outcomes,
      windowN,
      thresholdK,
    );
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
    await ingestTestRunResults(run);
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
