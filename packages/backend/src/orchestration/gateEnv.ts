import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { ToolVersionCheck } from '../session/orchestrator-config';

/**
 * Builds the env a verify/autofix/analyze command should be spawned with in
 * `worktreePath`. Each `cacheEnv` entry maps an env var name to a path
 * relative to the worktree; the directory is created if it doesn't exist yet
 * and the var is pointed at its absolute path, scoping that tool's cache to
 * this worktree instead of whatever the operator's global environment has it
 * pointing at. Because the resolved directory lives inside the worktree, it
 * is torn down along with it — no separate cleanup step is needed. A project
 * declaring no cache_env map (undefined/empty, the default) gets back
 * `process.env` unchanged, preserving today's inherited-environment
 * behavior exactly.
 */
export function buildScopedEnv(
  worktreePath: string,
  cacheEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  if (!cacheEnv || Object.keys(cacheEnv).length === 0) {
    return process.env;
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [varName, relativePath] of Object.entries(cacheEnv)) {
    const absolutePath = path.join(worktreePath, relativePath);
    fs.mkdirSync(absolutePath, { recursive: true });
    env[varName] = absolutePath;
  }
  return env;
}

function runVersionCommand(
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
    proc.on('error', (err) => resolve({ exitCode: 1, output: err.message }));
  });
}

export interface ToolchainMismatch {
  versionCommand: string;
  expected: string;
  actual: string;
}

/**
 * Runs each declared `expected_tool_versions` entry's `version_command` in
 * `worktreePath` and confirms its output contains the `expected` substring.
 * Returns the first mismatch found, or null when every declared check
 * matches — including when `checks` is empty/undefined, which skips the
 * check entirely rather than treating "no declaration" as a failure.
 *
 * A mismatch here reflects the invoking host's toolchain, not the code
 * under review — the caller must surface it as a configuration failure
 * distinct from a normal gate/code failure (see isToolInfraFailure on
 * VerifyResult/AutofixResult), so "your PR fails lint" is never printed
 * when the truth is "this host's linter isn't CI's linter".
 */
export async function checkToolchainVersions(
  worktreePath: string,
  checks: ToolVersionCheck[] | undefined,
): Promise<ToolchainMismatch | null> {
  if (!checks || checks.length === 0) return null;
  for (const check of checks) {
    const { output } = await runVersionCommand(
      check.version_command,
      worktreePath,
    );
    if (!output.includes(check.expected)) {
      return {
        versionCommand: check.version_command,
        expected: check.expected,
        actual: output.trim().slice(0, 200),
      };
    }
  }
  return null;
}

export function formatToolchainMismatch(mismatch: ToolchainMismatch): string {
  return (
    `toolchain version mismatch: '${mismatch.versionCommand}' expected output ` +
    `containing '${mismatch.expected}', got '${mismatch.actual}'`
  );
}
