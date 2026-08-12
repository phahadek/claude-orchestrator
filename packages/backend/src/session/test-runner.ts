import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { platform } from 'process';

export interface TestCommandResult {
  passed: boolean;
  output: string;
  timedOut?: boolean;
  oomKilled?: boolean;
}

export interface TestRunOptions {
  /** Max RSS in MB per subprocess; 0 (default) = no limit. Linux-only. */
  maxRssMb?: number;
  /** Stop running subsequent commands after the first failure. Default false. */
  failFast?: boolean;
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
const GRACE_PERIOD_MS = 5_000;

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

function runCommandWithTimeout(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  maxRssMb: number,
): Promise<{
  exitCode: number;
  output: string;
  timedOut: boolean;
  oomKilled: boolean;
}> {
  return new Promise((resolve) => {
    // Strip production data-plane env before the child spawns. A test
    // command runs `vitest run` (or similar) in a worktree; DB_PATH pointing
    // at the live orchestrator database must never reach it, or a test that
    // reads DB_PATH before its own in-memory-DB guard runs (or a subprocess
    // it spawns) could open and write to production data. See
    // CliSessionRunner.ts's identical strip for the session-spawn path.
    const { DB_PATH: _productionDbPath, ...env } = process.env;
    const spawnOpts =
      platform === 'win32'
        ? { shell: true, cwd, env }
        : { shell: true, cwd, env, detached: true };

    const proc = spawn(cmd, spawnOpts);
    let chunks: Buffer[] = [];
    let headDroppedChars = 0;
    let settled = false;
    let rssPoller: ReturnType<typeof setInterval> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    // Set once escalation begins (timeout or OOM). Preserved so a graceful
    // exit during the grace period is still reported as timedOut/oomKilled
    // rather than misreported as a normal completion.
    let escalation: { timedOut: boolean; oomKilled: boolean; marker: string } | null =
      null;

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
    }) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (rssPoller !== null) clearInterval(rssPoller);
      if (graceTimer !== null) clearTimeout(graceTimer);
      resolve(result);
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
        const rss = getChildRssMb(proc.pid);
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

    proc.on('close', (code) => {
      if (escalation !== null) {
        settle({
          exitCode: code ?? 1,
          output: collectedOutput() + escalation.marker,
          timedOut: escalation.timedOut,
          oomKilled: escalation.oomKilled,
        });
        return;
      }
      settle({
        exitCode: code ?? 1,
        output: collectedOutput(),
        timedOut: false,
        oomKilled: false,
      });
    });

    proc.on('error', (err) => {
      settle({
        exitCode: 1,
        output: err.message,
        timedOut: false,
        oomKilled: false,
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

  const { maxRssMb = 0, failFast = false } = opts;
  const timeoutMs = timeoutSec * 1000;
  const outputParts: string[] = [];
  let allPassed = true;
  let anyTimedOut = false;
  let anyOomKilled = false;

  for (const cmd of commands) {
    log(`[test-runner] running: ${cmd}\n`);
    const { exitCode, output, timedOut, oomKilled } =
      await runCommandWithTimeout(cmd, worktreePath, timeoutMs, maxRssMb);
    outputParts.push(`$ ${cmd}\n${output}`);

    if (oomKilled) {
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

    if (!allPassed && failFast) break;
  }

  return {
    passed: allPassed,
    output: outputParts.join('\n'),
    timedOut: anyTimedOut,
    oomKilled: anyOomKilled,
  };
}
