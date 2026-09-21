import { spawn, execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import {
  readFileSync,
  unlinkSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { platform } from 'process';
import { Worker } from 'worker_threads';
import type { StructuredTestResult } from '../db/types';
import { logger } from '../logger';
import {
  spawnIntoTestRunCgroup,
  killTestRunCgroup,
  isTestRunCgroupEmpty,
  removeTestRunCgroup,
  testRunCgroupMemoryCurrentPath,
} from './sessionCgroup';
import {
  classnameFromTestId,
  isTestIdTouchedByChangedFiles,
  parseJUnitXml,
  clearReportFiles,
  collectStructuredTestResult,
} from './testReportCollector';

export {
  classnameFromTestId,
  isTestIdTouchedByChangedFiles,
  parseJUnitXml,
  clearReportFiles,
  collectStructuredTestResult,
};

export interface TestCommandResult {
  passed: boolean;
  output: string;
  timedOut?: boolean;
  oomKilled?: boolean;
  /**
   * True when at least one command's child process could not be spawned at
   * all (ENOENT, EAGAIN, fork failure) — an infrastructure failure, not a
   * test verdict: the command never ran, so `passed: false` here must not be
   * read as "the suite ran and failed".
   */
  spawnFailed?: boolean;
  /**
   * True when, after teardown (grace-period SIGINT, then SIGKILL/cgroup
   * kill), a process was still found alive in this run's cgroup — i.e. the
   * "no live subprocess" guarantee could not actually be confirmed. Distinct
   * from every other failure flag: those describe why the command was torn
   * down, this describes whether teardown actually finished the job. A
   * caller must not treat this run as safely settled.
   */
  teardownVerificationFailed?: boolean;
  /** First command (from the `commands` array) that failed — set once, on the first failure, regardless of failFast. Undefined when every command passed. */
  failedCommand?: string;
  /** True when a declared expected_tool_versions check failed before any command ran — a host toolchain mismatch, not a code defect. Set only by testRequestLane.ts's executeTestRequestRun. */
  isToolInfraFailure?: boolean;
  /** Names the mismatched version_command and versions, for operator triage. Set alongside isToolInfraFailure. */
  toolFailureReason?: string;
}

export interface TestRunOptions {
  /** Max RSS in MB per subprocess; 0 (default) = no limit. Linux-only. */
  maxRssMb?: number;
  /** Stop running subsequent commands after the first failure. Default false. */
  failFast?: boolean;
  /**
   * Identifies this run for cgroup-scoped teardown (see sessionCgroup.ts's
   * per-run tests/<runId>/ leaf) — callers that own a durable run id (e.g.
   * test_request_runs.id) should pass it so teardown diagnostics can be
   * traced back to that row. Defaults to a fresh id when omitted, so every
   * invocation still gets an isolated, verified-on-teardown cgroup.
   */
  runId?: string;
  /**
   * Env to spawn each command with, instead of `process.env` — used to
   * scope tool caches (see gateEnv.ts's buildScopedEnv) to the invoking
   * worktree. DB_PATH is still stripped regardless (see
   * runCommandWithTimeout). Omitted (default) = today's inherited-environment
   * behavior, unchanged.
   */
  env?: NodeJS.ProcessEnv;
}

const OUTPUT_CAP_CHARS = 50_000;

/** Collapse a run of the same non-newline char repeated this many times or more. */
const PROGRESS_RUN_THRESHOLD = 20;

/**
 * Time to wait after a graceful SIGINT before escalating to SIGKILL. Counted
 * as part of the overall run budget (timeoutMs + GRACE_PERIOD_MS), so a
 * command that ignores SIGINT still terminates within a bounded wall-clock
 * window rather than hanging indefinitely.
 */
export const GRACE_PERIOD_MS = 5_000;

/**
 * Test runners (pytest, vitest) print long runs of the same progress
 * character (dots, F's) before their diagnosis at the end. Collapsing those
 * runs frees up cap budget for the informative tail rather than burning it
 * on noise.
 */
export function collapseProgressRuns(text: string): string {
  return text.replace(
    new RegExp(`([^\\n])\\1{${PROGRESS_RUN_THRESHOLD - 1},}`, 'g'),
    (match, ch: string) =>
      `${ch}[...${match.length - 1} more '${ch}' elided...]`,
  );
}

/**
 * Retains the tail of `output` for delivery into a session's feedback
 * inbox — a test runner's failure diagnosis prints last, so keeping the
 * head (a naive slice(0, cap)) discards exactly the informative part.
 * Below the cap, returns `output` unchanged.
 */
export function truncateForDelivery(output: string, cap: number): string {
  return output.length > cap ? '[truncated]...\n' + output.slice(-cap) : output;
}

function killProcessTree(pid: number): void {
  try {
    if (platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { detached: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // best-effort
  }
}

/**
 * Ask the process group to terminate gracefully so runners like pytest and
 * vitest can reach their normal teardown (summary printing, report writes).
 * No graceful equivalent exists on Windows' taskkill path, so that platform
 * is left untouched.
 */
function interruptProcessTree(pid: number): void {
  try {
    process.kill(-pid, 'SIGINT');
  } catch {
    // best-effort
  }
}

export function getChildRssMb(
  pid: number,
  _platform: NodeJS.Platform = process.platform,
  readFn: (path: string) => string = (p) => readFileSync(p, 'utf8') as string,
): number {
  if (_platform !== 'linux') return 0;
  try {
    const data = readFn(`/proc/${pid}/status`);
    const match = data.match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (match) return parseInt(match[1], 10) / 1024;
  } catch {
    // process may have exited
  }
  return 0;
}

/**
 * Current memory footprint of the whole run, in MB. Prefers the run's own
 * cgroup-v2 leaf (tests/<runId>/memory.current) — inherited at fork, so it
 * captures the full process tree spawnIntoTestRunCgroup placed there,
 * including grandchildren that setsid() or get re-parented away from `pid`.
 * Falls back to `pid`'s own VmRSS (today's behavior — a single /proc read,
 * no subtree traversal) when no cgroup leaf exists, e.g. a host without the
 * delegated tests/ subtree set up. Non-Linux platforms return 0, same as
 * getChildRssMb, so the poller stays disabled there.
 */
export function getRunMemoryMb(
  runId: string,
  pid: number,
  _platform: NodeJS.Platform = process.platform,
  readFn: (path: string) => string = (p) => readFileSync(p, 'utf8') as string,
): number {
  if (_platform !== 'linux') return 0;
  const cgroupPath = testRunCgroupMemoryCurrentPath(runId);
  if (cgroupPath) {
    try {
      const raw = readFn(cgroupPath).trim();
      const bytes = parseInt(raw, 10);
      if (!Number.isNaN(bytes)) return bytes / (1024 * 1024);
    } catch {
      // leaf not yet created / already torn down — fall through
    }
  }
  return getChildRssMb(pid, _platform, readFn);
}

/** Bounded retries for verifyRunTeardown — a cgroup.kill signal needs a moment to actually reap before cgroup.procs reflects it as empty. */
const TEARDOWN_VERIFY_MAX_ATTEMPTS = 3;
export const TEARDOWN_VERIFY_RETRY_MS = 200;

/**
 * Confirms no process survives in this run's cgroup before settle()
 * resolves — the backstop for killProcessTree's process-group kill(-pid),
 * which a setsid() grandchild or a process re-parented to init after its
 * own parent exited both escape. cgroup-v2 membership is inherited at fork
 * and is orthogonal to process group/parent pid, so writing cgroup.kill
 * (via killTestRunCgroup) reaches those escapees regardless. Retries a
 * bounded number of times since a killed process needs a moment to actually
 * exit and be reaped before cgroup.procs reflects it as empty; if the
 * cgroup is still non-empty after all attempts, reports `survived: true`
 * rather than silently resolving. No-ops to `survived: false` on Windows,
 * which has no cgroups — that path is left on process-group teardown alone.
 */
function verifyRunTeardown(
  runId: string,
  onDone: (survived: boolean) => void,
  attempt = 0,
): void {
  if (platform === 'win32') {
    onDone(false);
    return;
  }
  if (isTestRunCgroupEmpty(runId)) {
    removeTestRunCgroup(runId);
    onDone(false);
    return;
  }
  killTestRunCgroup(runId);
  if (attempt + 1 >= TEARDOWN_VERIFY_MAX_ATTEMPTS) {
    onDone(!isTestRunCgroupEmpty(runId));
    return;
  }
  setTimeout(
    () => verifyRunTeardown(runId, onDone, attempt + 1),
    TEARDOWN_VERIFY_RETRY_MS,
  );
}

export interface BoundedCommandResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
  oomKilled: boolean;
  spawnFailed: boolean;
  teardownVerificationFailed: boolean;
  /** The per-run TMPDIR created for this command, if one could be created. Removed by the time this result resolves. */
  tmpDir?: string;
}

/**
 * Runs a single command through the bounded test-run machinery — per-run
 * cgroup placement (spawnIntoTestRunCgroup), a wall-clock timeout with
 * SIGINT-then-SIGKILL escalation, an optional RSS ceiling, and
 * teardown-verification (verifyRunTeardown) before resolving — so any caller
 * spawning a test/verify command inherits the same bound the test: lane gets,
 * rather than a bare unbounded spawn(). Exported for callers outside the
 * test: lane (see verifyRunner.ts's runVerifyAsGate) that need the identical
 * guarantee.
 */
export function runCommandWithTimeout(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  maxRssMb: number,
  runId: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<BoundedCommandResult> {
  return new Promise((resolve) => {
    // Strip production data-plane env before the child spawns. A test
    // command runs `vitest run` (or similar) in a worktree; DB_PATH pointing
    // at the live orchestrator database must never reach it, or a test that
    // reads DB_PATH before its own in-memory-DB guard runs (or a subprocess
    // it spawns) could open and write to production data. See
    // CliSessionRunner.ts's identical strip for the session-spawn path.
    const { DB_PATH: _productionDbPath, ...env } = baseEnv;

    // A per-run TMPDIR so this command's own mkdtemp calls (Node's
    // os.tmpdir(), Python's tempfile, bash mktemp) resolve here instead of
    // the shared host /tmp — a test file that forgets to clean up its own
    // temp dirs then leaks into this run-scoped directory, which is removed
    // on every settle path below, rather than accumulating in /tmp forever.
    let runTmp: string | null = null;
    try {
      runTmp = mkdtempSync(
        path.join(os.tmpdir(), `orchestrator-run-${runId}-`),
      );
      env.TMPDIR = runTmp;
      env.TMP = runTmp;
      env.TEMP = runTmp;
    } catch (err) {
      logger.warn(
        `[test-runner] failed to create per-run TMPDIR for ${runId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`,
      );
    }

    const spawnOpts =
      platform === 'win32'
        ? { shell: true, cwd, env }
        : { shell: true, cwd, env, detached: true };

    // Relocated into this run's own per-run tests/<runId>/ cgroup for the
    // duration of the spawn call so this subprocess (and any grandchild it
    // forks synchronously, e.g. a temp postgres cluster) is born under that
    // bounded, run-scoped leaf rather than main/ or a leaf shared with other
    // runs — see spawnIntoTestRunCgroup's doc comment for why post-spawn
    // placement can't close this race.
    const proc = spawnIntoTestRunCgroup(runId, () => spawn(cmd, spawnOpts));
    let chunks: Buffer[] = [];
    let headDroppedChars = 0;
    let settled = false;
    let rssPoller: ReturnType<typeof setInterval> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    // Set once escalation begins (timeout or OOM). Preserved so a graceful
    // exit during the grace period is still reported as timedOut/oomKilled
    // rather than misreported as a normal completion.
    let escalation: {
      timedOut: boolean;
      oomKilled: boolean;
      marker: string;
    } | null = null;

    // Retains the *tail* of the stream — a test runner's diagnosis (failure
    // summary, traceback) always prints last, after uninformative progress
    // output. Collapses progress-character runs first so the retained
    // window isn't wasted on noise, then trims to the last OUTPUT_CAP_CHARS
    // characters, recording how much was dropped from the head.
    function collect(d: Buffer) {
      chunks.push(d);
      let text = collapseProgressRuns(Buffer.concat(chunks).toString('utf8'));
      if (text.length > OUTPUT_CAP_CHARS) {
        const excess = text.length - OUTPUT_CAP_CHARS;
        headDroppedChars += excess;
        text = text.slice(excess);
      }
      chunks = [Buffer.from(text, 'utf8')];
    }

    function collectedOutput(): string {
      const text = Buffer.concat(chunks).toString('utf8');
      return headDroppedChars > 0
        ? `[test-runner] output truncated: ${headDroppedChars} char(s) elided from head\n${text}`
        : text;
    }

    function settle(result: {
      exitCode: number;
      output: string;
      timedOut: boolean;
      oomKilled: boolean;
      spawnFailed?: boolean;
    }) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (rssPoller !== null) clearInterval(rssPoller);
      if (graceTimer !== null) clearTimeout(graceTimer);
      // Never settle "finished" while a process could still be alive in
      // this run's cgroup — the run must not be recorded as torn down
      // unless that's actually true (see verifyRunTeardown's doc comment).
      verifyRunTeardown(runId, (survived) => {
        // Only remove the per-run TMPDIR once the process tree is confirmed
        // gone — removing it earlier could race a still-running grandchild
        // writing into it.
        if (runTmp) {
          try {
            rmSync(runTmp, { recursive: true, force: true });
          } catch (err) {
            logger.warn(
              `[test-runner] failed to remove per-run TMPDIR ${runTmp} for run ${runId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
        if (survived) {
          logger.error(
            `[test-runner] teardown verification failed for run ${runId.slice(0, 8)}: a process survived cgroup kill`,
          );
        }
        resolve({
          spawnFailed: false,
          teardownVerificationFailed: survived,
          tmpDir: runTmp ?? undefined,
          ...result,
        });
      });
    }

    // Escalate: SIGINT the process group so the runner can reach its normal
    // teardown (failure summary, report file), keep collecting output for a
    // bounded grace period, then SIGKILL if it hasn't exited by then. Settles
    // only once the process exits or the grace period elapses — never before.
    function escalate(timedOut: boolean, oomKilled: boolean, marker: string) {
      if (escalation !== null || settled) return;
      escalation = { timedOut, oomKilled, marker };

      if (proc.pid == null) {
        settle({
          exitCode: 1,
          output: collectedOutput() + marker,
          timedOut,
          oomKilled,
        });
        return;
      }

      if (platform === 'win32') {
        // No graceful equivalent to taskkill /F /T; keep prior behavior.
        killProcessTree(proc.pid);
        settle({
          exitCode: 1,
          output: collectedOutput() + marker,
          timedOut,
          oomKilled,
        });
        return;
      }

      interruptProcessTree(proc.pid);
      graceTimer = setTimeout(() => {
        if (proc.pid != null) killProcessTree(proc.pid);
        settle({
          exitCode: 1,
          output: collectedOutput() + marker,
          timedOut,
          oomKilled,
        });
      }, GRACE_PERIOD_MS);
    }

    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);

    if (maxRssMb > 0) {
      rssPoller = setInterval(() => {
        if (proc.pid == null) return;
        const rss = getRunMemoryMb(runId, proc.pid);
        if (rss > 0 && rss > maxRssMb) {
          escalate(
            false,
            true,
            `\n[test-runner] OOM_KILL: RSS ${rss.toFixed(0)} MB exceeded limit ${maxRssMb} MB`,
          );
        }
      }, 2_000);
    }

    timer = setTimeout(() => {
      escalate(true, false, '\n[test-runner] TIMEOUT');
    }, timeoutMs);

    proc.on('close', (code, signal) => {
      if (escalation !== null) {
        settle({
          exitCode: code ?? 1,
          output: collectedOutput() + escalation.marker,
          timedOut: escalation.timedOut,
          oomKilled: escalation.oomKilled,
        });
        return;
      }
      // A SIGKILL we did not initiate ourselves (no escalation in flight) is
      // the signature of the host/container OOM-killer reclaiming memory —
      // distinguishable from a normal nonzero exit purely via the `signal`
      // arg Node's close event provides, independent of whether the RSS
      // poller (maxRssMb > 0) is enabled for this run.
      const oomKilled = signal === 'SIGKILL';
      settle({
        exitCode: code ?? 1,
        output:
          collectedOutput() +
          (oomKilled
            ? `\n[test-runner] process terminated by signal ${signal} (likely OOM-kill)`
            : ''),
        timedOut: false,
        oomKilled,
      });
    });

    proc.on('error', (err) => {
      // The process could never be spawned at all (ENOENT, EAGAIN, fork
      // failure) — an infrastructure failure distinct from any test verdict:
      // no command ever ran, so this must not be mistaken for a test
      // failure downstream (see TestCommandResult.spawnFailed).
      settle({
        exitCode: 1,
        output: `[test-runner] spawn failed: ${err.message}`,
        timedOut: false,
        oomKilled: false,
        spawnFailed: true,
      });
    });
  });
}

/**
 * Run each test command in the given worktree directory with a per-command
 * timeout. Returns the combined pass/fail and captured output.
 * Empty commands array is a no-op that returns passed: true.
 */
export async function runTestCommands(
  worktreePath: string,
  commands: string[],
  timeoutSec: number,
  log: (msg: string) => void,
  opts: TestRunOptions = {},
): Promise<TestCommandResult> {
  if (commands.length === 0) {
    return { passed: true, output: '' };
  }

  const { maxRssMb = 0, failFast = false, runId = randomUUID(), env } = opts;
  const timeoutMs = timeoutSec * 1000;
  const outputParts: string[] = [];
  let allPassed = true;
  let anyTimedOut = false;
  let anyOomKilled = false;
  let anySpawnFailed = false;
  let anyTeardownVerificationFailed = false;
  let failedCommand: string | undefined;

  for (const cmd of commands) {
    log(`[test-runner] running: ${cmd}\n`);
    const {
      exitCode,
      output,
      timedOut,
      oomKilled,
      spawnFailed,
      teardownVerificationFailed,
    } = await runCommandWithTimeout(
      cmd,
      worktreePath,
      timeoutMs,
      maxRssMb,
      runId,
      env,
    );
    outputParts.push(`$ ${cmd}\n${output}`);

    const wasPassing = allPassed;
    if (spawnFailed) {
      log(`[test-runner] SPAWN FAILED: ${cmd}\n`);
      allPassed = false;
      anySpawnFailed = true;
    } else if (teardownVerificationFailed) {
      log(
        `[test-runner] TEARDOWN VERIFICATION FAILED (process survived cgroup kill): ${cmd}\n`,
      );
      allPassed = false;
      anyTeardownVerificationFailed = true;
    } else if (oomKilled) {
      log(
        `[test-runner] OOM_KILL after exceeding ${maxRssMb} MB RSS: ${cmd}\n`,
      );
      allPassed = false;
      anyOomKilled = true;
    } else if (timedOut) {
      log(`[test-runner] TIMEOUT after ${timeoutSec}s: ${cmd}\n`);
      allPassed = false;
      anyTimedOut = true;
    } else if (exitCode !== 0) {
      log(`[test-runner] FAILED (exit ${exitCode}): ${cmd}\n`);
      allPassed = false;
    } else {
      log(`[test-runner] passed: ${cmd}\n`);
    }

    if (wasPassing && !allPassed) failedCommand = cmd;
    if (!allPassed && failFast) break;
  }

  return {
    passed: allPassed,
    output: outputParts.join('\n'),
    timedOut: anyTimedOut,
    oomKilled: anyOomKilled,
    spawnFailed: anySpawnFailed,
    teardownVerificationFailed: anyTeardownVerificationFailed,
    failedCommand,
  };
}

// ─── JUnit-XML report acquisition ──────────────────────────────────────────
// The parse implementation (classnameFromTestId, isTestIdTouchedByChangedFiles,
// parseJUnitXml, clearReportFiles, collectStructuredTestResult) now lives in
// ./testReportCollector and is re-exported above for every existing caller
// (verifyRunner.ts, this file's own stash/revert check below, mcp tools) —
// see that module's doc comment for why it was split out.

/**
 * A test process (vitest, or anything with NODE_ENV=test) must never spawn a
 * real worker_threads Worker for report collection — under full-suite
 * concurrency, many test files each paying the ts-node/register startup cost
 * for a trivial fixture has been observed exceeding tens of seconds (see
 * flakyTestRollupOffMainThread.test.ts's matching comment) — and every
 * existing unit test already exercises collectStructuredTestResult
 * synchronously via a mock of this module. Mirrors db.ts's own isTestMode
 * check.
 */
const isTestMode =
  process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);

/**
 * Off-main-thread counterpart to collectStructuredTestResult, used only by
 * testRequestLane.ts's lane completion handler — every other caller
 * (verifyRunner.ts, the stash/revert check below) keeps calling the
 * synchronous version directly, since neither runs on the shared test-lane
 * hot path this exists to unblock.
 *
 * For a large suite, collectStructuredTestResult's readFileSync + regex
 * parse of the JUnit report is real synchronous work on the main thread —
 * this dispatches it to session/testReportCollectorWorker.ts on a worker
 * thread instead, mirroring db/flakyTestRollupWorker.ts's precedent. Falls
 * back to the synchronous in-process call under isTestMode, since every
 * existing unit test mocks collectStructuredTestResult (via this module) and
 * spawning a real worker per test would be both slow and unable to see that
 * mock (a worker thread is a separate JS realm — vi.mock has no effect
 * there).
 *
 * The caller (testRequestLane.ts's executeTestRequestRun) awaits this before
 * writing structured_result / broadcasting the run as settled — so
 * structured_result is always durably computed as one atomic step relative
 * to run completion, exactly as it was before this worker existed; only the
 * I/O-bound collection work inside that step moved off the main thread. A
 * process crash while this is in flight leaves the run in `running` state,
 * caught by the existing recoverInterruptedTestRequestRuns boot sweep — no
 * new crash-recovery path is needed, unlike extraction (which is safely
 * re-derivable from the durably-stored structured_result indefinitely later;
 * collection is not, since the worktree's report files are ephemeral and get
 * cleared before the next run).
 */
export async function collectStructuredTestResultOffMainThread(
  worktreePath: string,
  reportGlob: string,
  expectedReportCount = 1,
  startedAt?: number,
): Promise<StructuredTestResult | null> {
  if (isTestMode) {
    return collectStructuredTestResult(
      worktreePath,
      reportGlob,
      expectedReportCount,
      startedAt,
    );
  }
  return new Promise((resolve, reject) => {
    const isTsNode = __filename.endsWith('.ts');
    const workerPath = path.join(
      __dirname,
      isTsNode
        ? 'testReportCollectorWorker.ts'
        : 'testReportCollectorWorker.js',
    );
    const worker = new Worker(workerPath, {
      workerData: {
        worktreePath,
        reportGlob,
        expectedReportCount,
        startedAt,
      },
      execArgv: isTsNode ? ['-r', 'ts-node/register/transpile-only'] : [],
    });
    let settled = false;
    worker.once(
      'message',
      (
        msg:
          | { ok: true; result: StructuredTestResult | null }
          | { ok: false; error: string },
      ) => {
        settled = true;
        if (msg.ok) {
          resolve(msg.result);
        } else {
          reject(
            new Error(`[test_report_collection] worker failed: ${msg.error}`),
          );
        }
        void worker.terminate();
      },
    );
    worker.once('error', (err) => {
      settled = true;
      reject(err);
    });
    worker.once('exit', (code) => {
      if (!settled) {
        reject(
          new Error(
            `[test_report_collection] worker exited with code ${code} before reporting a result`,
          ),
        );
      }
    });
  });
}

// ─── Mechanical stash/revert check ─────────────────────────────────────────
// A PR reviewer's "this test is non-vacuous" claim (see PRReviewService's
// evidence-bar rubric) is self-reported. This section independently proves
// it: revert the diff's implementation files (keeping the new/modified test
// file as-is), confirm the test suite fails, restore the implementation
// files, and confirm it passes — plus flags a "pass" that never actually
// executed an assertion (0 collected, or fully skipped).

/** Matches common test-file naming conventions (vitest/jest .test./.spec., __tests__ dirs, pytest test_*.py/*_test.py). */
const TEST_FILE_RE =
  /(^|\/)(__tests__\/.+|[^/]*\.(test|spec)\.[jt]sx?|test_[^/]+\.py|[^/]+_test\.py)$/;

/** Exported for unit testing and reuse by callers that need to pre-filter a diff's changed files. */
export function isLikelyTestFile(relPath: string): boolean {
  return TEST_FILE_RE.test(relPath);
}

export interface StashRevertCheckOptions {
  worktreePath: string;
  /** Files changed by the diff under check, relative to worktreePath (e.g. from `git diff --name-only`). */
  changedFiles: string[];
  /** Git ref the diff is relative to — the "before" state implementation files are reverted to. */
  baseRef: string;
  testCommands: string[];
  reportGlob: string;
  timeoutSec?: number;
  maxRssMb?: number;
}

export type StashRevertCheckVerdict =
  | 'confirmed'
  | 'no_test_files_changed'
  | 'no_implementation_files_changed'
  | 'test_did_not_fail_without_diff'
  | 'test_did_not_pass_with_diff'
  | 'vacuous_result'
  | 'error';

export interface StashRevertRunOutcome {
  passed: boolean;
  structuredResult: StructuredTestResult | null;
}

export interface StashRevertCheckResult {
  verdict: StashRevertCheckVerdict;
  detail: string;
  withoutDiff?: StashRevertRunOutcome;
  withDiff?: StashRevertRunOutcome;
}

/**
 * True when a structured result exists but executed zero assertions overall
 * (nothing ran, or every collected test was skipped) — a "pass" that proves
 * nothing, the failure mode the design doc's Open Question 2 calls out
 * (0 executed assertions / all-skipped). A null result (no report collected
 * at all) is treated as vacuous too, since there's then no evidence the
 * suite ran.
 */
export function isVacuousResult(result: StructuredTestResult | null): boolean {
  if (!result) return true;
  const executed =
    result.totals.passed + result.totals.failed + result.totals.errors;
  return executed === 0;
}

interface ImplementationFileSnapshot {
  relPath: string;
  absPath: string;
  /** Working-tree bytes before the revert; null when the file has no on-disk content (e.g. already deleted). */
  currentContent: Buffer | null;
}

/** Reads `relPath`'s content as of `ref` via `git show`, or null when the file doesn't exist at that ref. */
function readFileAtRef(
  worktreePath: string,
  ref: string,
  relPath: string,
): Buffer | null {
  try {
    return execFileSync('git', ['show', `${ref}:${relPath}`], {
      cwd: worktreePath,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function writeOrDelete(absPath: string, content: Buffer | null): void {
  if (content === null) {
    try {
      unlinkSync(absPath);
    } catch {
      // already absent
    }
  } else {
    writeFileSync(absPath, content);
  }
}

async function runOnce(
  worktreePath: string,
  testCommands: string[],
  reportGlob: string,
  timeoutSec: number,
  maxRssMb: number,
): Promise<StashRevertRunOutcome> {
  clearReportFiles(worktreePath, reportGlob);
  const startedAt = Date.now();
  const result = await runTestCommands(
    worktreePath,
    testCommands,
    timeoutSec,
    () => {},
    { maxRssMb, failFast: false, runId: randomUUID() },
  );
  const structuredResult = collectStructuredTestResult(
    worktreePath,
    reportGlob,
    testCommands.length,
    startedAt,
  );
  return { passed: result.passed, structuredResult };
}

/**
 * Independently verifies a PR's non-vacuous-test claim by mechanically
 * stashing the diff's implementation files (snapshotting their current
 * on-disk bytes, then overwriting each with its `baseRef` content — deleted
 * entirely when the file didn't exist at `baseRef`), confirming the
 * retained test file(s) then fail, restoring the snapshotted bytes, and
 * confirming they pass. Restoring from an in-memory snapshot rather than
 * `git checkout HEAD` matters because the diff under check may still be
 * uncommitted working-tree state — a `git checkout` restore would silently
 * discard it instead of bringing it back. Always restores the snapshot
 * before returning, including on infrastructure failure, so a caller's
 * worktree is never left mid-revert.
 *
 * Returns `no_test_files_changed`/`no_implementation_files_changed` rather
 * than attempting a check that couldn't be meaningful (no test to run
 * against a reverted implementation, or nothing to revert).
 */
export async function runStashRevertCheck(
  opts: StashRevertCheckOptions,
): Promise<StashRevertCheckResult> {
  const {
    worktreePath,
    changedFiles,
    baseRef,
    testCommands,
    reportGlob,
    timeoutSec = 300,
    maxRssMb = 0,
  } = opts;

  const testFiles = changedFiles.filter(isLikelyTestFile);
  const implementationFiles = changedFiles.filter((f) => !isLikelyTestFile(f));

  if (testFiles.length === 0) {
    return {
      verdict: 'no_test_files_changed',
      detail: 'diff contains no test files to mechanically verify',
    };
  }
  if (implementationFiles.length === 0) {
    return {
      verdict: 'no_implementation_files_changed',
      detail: 'diff contains only test files; nothing to revert against',
    };
  }

  const snapshots: ImplementationFileSnapshot[] = implementationFiles.map(
    (relPath) => {
      const absPath = path.join(worktreePath, relPath);
      let currentContent: Buffer | null;
      try {
        currentContent = readFileSync(absPath);
      } catch {
        currentContent = null;
      }
      return { relPath, absPath, currentContent };
    },
  );

  try {
    for (const s of snapshots) {
      writeOrDelete(s.absPath, readFileAtRef(worktreePath, baseRef, s.relPath));
    }
  } catch (e) {
    // A mid-loop failure (e.g. disk full, permission error) must not leave
    // the files already reverted stuck in their baseRef content — restore
    // every snapshot (including ones never touched, which is a harmless
    // no-op rewrite) before surfacing the error.
    for (const s of snapshots) {
      writeOrDelete(s.absPath, s.currentContent);
    }
    return {
      verdict: 'error',
      detail: `failed to revert implementation files to ${baseRef}: ${(e as Error).message}`,
    };
  }

  let withoutDiff: StashRevertRunOutcome;
  try {
    withoutDiff = await runOnce(
      worktreePath,
      testCommands,
      reportGlob,
      timeoutSec,
      maxRssMb,
    );
  } finally {
    for (const s of snapshots) {
      writeOrDelete(s.absPath, s.currentContent);
    }
  }

  const withDiff = await runOnce(
    worktreePath,
    testCommands,
    reportGlob,
    timeoutSec,
    maxRssMb,
  );

  if (isVacuousResult(withDiff.structuredResult)) {
    return {
      verdict: 'vacuous_result',
      detail:
        'the test run with the diff restored executed zero assertions (nothing collected, or fully skipped) — cannot confirm it is non-vacuous',
      withoutDiff,
      withDiff,
    };
  }
  if (withoutDiff.passed) {
    return {
      verdict: 'test_did_not_fail_without_diff',
      detail:
        'the test suite still passed with the implementation files reverted — the new/modified test does not depend on this diff',
      withoutDiff,
      withDiff,
    };
  }
  if (!withDiff.passed) {
    return {
      verdict: 'test_did_not_pass_with_diff',
      detail:
        'the test suite failed with the implementation files restored — the diff does not make the new/modified test pass',
      withoutDiff,
      withDiff,
    };
  }
  return {
    verdict: 'confirmed',
    detail:
      'the new/modified test fails with the implementation diff reverted and passes with it restored',
    withoutDiff,
    withDiff,
  };
}
