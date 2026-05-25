import { spawn } from 'child_process';

export interface VerifyResult {
  passed: boolean;
  failedCommand?: string;
  truncatedOutput?: string;
}

const OUTPUT_TAIL_CHARS = 750;

function runCommand(
  cmd: string,
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn(cmd, { shell: true, cwd });
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => chunks.push(d));
    proc.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        output: Buffer.concat(chunks).toString('utf8'),
      });
    });
    proc.on('error', (err) => {
      resolve({ exitCode: 1, output: err.message });
    });
  });
}

export async function runVerifyAsGate(
  worktreePath: string,
  commands: string[],
): Promise<VerifyResult> {
  if (commands.length === 0) return { passed: true };

  for (const cmd of commands) {
    const { exitCode, output } = await runCommand(cmd, worktreePath);
    if (exitCode !== 0) {
      const truncated =
        output.length > OUTPUT_TAIL_CHARS
          ? output.slice(output.length - OUTPUT_TAIL_CHARS)
          : output;
      return { passed: false, failedCommand: cmd, truncatedOutput: truncated };
    }
  }

  return { passed: true };
}
