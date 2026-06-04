import { spawn } from 'child_process';
import { platform } from 'process';

export interface TestCommandResult {
  passed: boolean;
  output: string;
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

function runCommandWithTimeout(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const spawnOpts =
      platform === 'win32'
        ? { shell: true, cwd }
        : { shell: true, cwd, detached: true };

    const proc = spawn(cmd, spawnOpts);
    const chunks: Buffer[] = [];
    let settled = false;
    let totalBytes = 0;

    function collect(d: Buffer) {
      if (totalBytes < OUTPUT_CAP_CHARS) {
        chunks.push(d);
        totalBytes += d.length;
      }
    }

    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (proc.pid != null) killProcessTree(proc.pid);
      resolve({
        exitCode: 1,
        output:
          Buffer.concat(chunks).toString('utf8') + '\n[test-runner] TIMEOUT',
        timedOut: true,
      });
    }, timeoutMs);

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        output: Buffer.concat(chunks).toString('utf8'),
        timedOut: false,
      });
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: 1, output: err.message, timedOut: false });
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
): Promise<TestCommandResult> {
  if (commands.length === 0) {
    return { passed: true, output: '' };
  }

  const timeoutMs = timeoutSec * 1000;
  const outputParts: string[] = [];
  let allPassed = true;

  for (const cmd of commands) {
    log(`[test-runner] running: ${cmd}\n`);
    const { exitCode, output, timedOut } = await runCommandWithTimeout(
      cmd,
      worktreePath,
      timeoutMs,
    );
    outputParts.push(`$ ${cmd}\n${output}`);

    if (timedOut) {
      log(`[test-runner] TIMEOUT after ${timeoutSec}s: ${cmd}\n`);
      allPassed = false;
    } else if (exitCode !== 0) {
      log(`[test-runner] FAILED (exit ${exitCode}): ${cmd}\n`);
      allPassed = false;
    } else {
      log(`[test-runner] passed: ${cmd}\n`);
    }
  }

  return { passed: allPassed, output: outputParts.join('\n') };
}
