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
} from '../db/queries';
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

const inFlightRuns = new Map<string, Promise<TestCommandResult>>();

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
): Promise<TestCommandResult> {
  const key = coalesceKey(spec.projectId, spec.contentHash);
  const existing = inFlightRuns.get(key);
  if (existing) return existing;

  const run = executeTestRequestRun(spec).finally(() => {
    if (inFlightRuns.get(key) === run) inFlightRuns.delete(key);
  });
  inFlightRuns.set(key, run);
  return run;
}

async function executeTestRequestRun(
  spec: TestRequestRunSpec,
): Promise<TestCommandResult> {
  await waitForMemoryAdmission(
    spec.projectId,
    typedGetSetting('test_request_max_concurrent_per_project'),
  );

  const semaphore = getProjectSemaphore(spec.projectId);
  const release = await semaphore.acquire();
  const runId = randomUUID();
  const startedAt = Date.now();
  try {
    insertTestRequestRun(runId, spec.projectId, spec.contentHash);
    broadcastRunStatus({
      runId,
      projectId: spec.projectId,
      contentHash: spec.contentHash,
      status: 'running',
      startedAt,
    });
    const result = await runTestCommands(
      spec.worktreePath,
      spec.commands,
      spec.timeoutSec,
      (msg) => logger.info(`[testRequestLane] ${msg}`),
      { maxRssMb: spec.maxRssMb, failFast: spec.failFast },
    );
    completeTestRequestRun(
      runId,
      result.passed ? 'passed' : 'failed',
      result.output,
    );
    broadcastRunStatus({
      runId,
      projectId: spec.projectId,
      contentHash: spec.contentHash,
      status: result.passed ? 'passed' : 'failed-with-cause',
      output: result.passed ? undefined : result.output,
      startedAt,
      finishedAt: Date.now(),
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = `[testRequestLane] execution error: ${message}`;
    completeTestRequestRun(runId, 'failed', output);
    broadcastRunStatus({
      runId,
      projectId: spec.projectId,
      contentHash: spec.contentHash,
      status: 'failed-with-cause',
      output,
      startedAt,
      finishedAt: Date.now(),
    });
    return { passed: false, output };
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
      startedAt: run.started_at,
      finishedAt: Date.now(),
    });
  }
}
