import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { platform } from 'process';

export interface TestCommandResult {
  passed: boolean;
  output: string;
}

export interface TestRunOptions {
  /** Max RSS in MB per subprocess; 0 (default) = no limit. Linux-only. */
  maxRssMb?: number;
  /** Stop running subsequent commands after the first failure. Default false. */
  failFast?: boolean;
}

const OUTPUT_CAP_CHARS = 50_000;

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

function getChildRssMb(pid: number): number {
  if (process.platform !== 'linux') return 0;
  try {
    const data = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = (data as string).match(/^VmRSS:\s+(\d+)\s+kB/m);
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
    const spawnOpts =
      platform === 'win32'
        ? { shell: true, cwd }
        : { shell: true, cwd, detached: true };

    const proc = spawn(cmd, spawnOpts);
    const chunks: Buffer[] = [];
    let settled = false;
    let totalBytes = 0;
    let rssPoller: ReturnType<typeof setInterval> | null = null;
    // Declared before settle so the closure can reference it; assigned after.
    let timer!: ReturnType<typeof setTimeout>;

    function collect(d: Buffer) {
      if (totalBytes < OUTPUT_CAP_CHARS) {
        chunks.push(d);
        totalBytes += d.length;
      }
    }

    function settle(result: {
      exitCode: number;
      output: string;
      timedOut: boolean;
      oomKilled: boolean;
    }) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (rssPoller !== null) clearInterval(rssPoller);
      resolve(result);
    }

    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);

    if (maxRssMb > 0) {
      rssPoller = setInterval(() => {
        if (proc.pid == null) return;
        const rss = getChildRssMb(proc.pid);
        if (rss > 0 && rss > maxRssMb) {
          killProcessTree(proc.pid);
          settle({
            exitCode: 1,
            output:
              Buffer.concat(chunks).toString('utf8') +
              `\n[test-runner] OOM_KILL: RSS ${rss.toFixed(0)} MB exceeded limit ${maxRssMb} MB`,
            timedOut: false,
            oomKilled: true,
          });
        }
      }, 2_000);
    }

    timer = setTimeout(() => {
      if (proc.pid != null) killProcessTree(proc.pid);
      settle({
        exitCode: 1,
        output:
          Buffer.concat(chunks).toString('utf8') + '\n[test-runner] TIMEOUT',
        timedOut: true,
        oomKilled: false,
      });
    }, timeoutMs);

    proc.on('close', (code) => {
      settle({
        exitCode: code ?? 1,
        output: Buffer.concat(chunks).toString('utf8'),
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
    } else if (timedOut) {
      log(`[test-runner] TIMEOUT after ${timeoutSec}s: ${cmd}\n`);
      allPassed = false;
    } else if (exitCode !== 0) {
      log(`[test-runner] FAILED (exit ${exitCode}): ${cmd}\n`);
      allPassed = false;
    } else {
      log(`[test-runner] passed: ${cmd}\n`);
    }

    if (!allPassed && failFast) break;
  }

  return { passed: allPassed, output: outputParts.join('\n') };
}
