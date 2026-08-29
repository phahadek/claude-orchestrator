import { spawn } from 'child_process';
import type { StructuredTestResult } from '../db/types';
import {
  clearReportFiles,
  collectStructuredTestResult,
} from '../session/test-runner';

export interface VerifyResult {
  passed: boolean;
  failedCommand?: string;
  truncatedOutput?: string;
  /**
   * The failing command's own report, parsed against `testReportGlob` when
   * one is configured — null when no glob is configured, the glob matched
   * nothing, or acquisition wasn't attempted (verify passed). Populated so
   * a caller (ReviewOrchestrator/PreReviewPipeline) can run
   * filterVerifyFailureByBaseHealth against it without re-invoking the
   * verify command itself.
   */
  structuredResult?: StructuredTestResult | null;
}

export const OUTPUT_TAIL_CHARS = 750;

/**
 * Truncates a log to its final `chars` characters — the end of a test log is
 * where the failure summary lives, not the startup banner at the head. Both
 * writers of the ci_failing pause detail (this module and PRMergeWatcher)
 * must agree on this semantic, or the same failure produces two different
 * "truncated" excerpts depending on which code path wrote it.
 */
export function tailOfLog(output: string, chars: number = OUTPUT_TAIL_CHARS): string {
  return output.length > chars ? output.slice(output.length - chars) : output;
}

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
  testReportGlob?: string,
): Promise<VerifyResult> {
  if (commands.length === 0) return { passed: true };

  const startedAt = testReportGlob ? Date.now() : undefined;
  if (testReportGlob) {
    clearReportFiles(worktreePath, testReportGlob);
  }

  for (const cmd of commands) {
    const { exitCode, output } = await runCommand(cmd, worktreePath);
    if (exitCode !== 0) {
      const truncated = tailOfLog(output);
      let structuredResult: StructuredTestResult | null = null;
      if (testReportGlob) {
        try {
          structuredResult = collectStructuredTestResult(
            worktreePath,
            testReportGlob,
            1,
            startedAt,
          );
        } catch {
          structuredResult = null;
        }
      }
      return {
        passed: false,
        failedCommand: cmd,
        truncatedOutput: truncated,
        structuredResult,
      };
    }
  }

  return { passed: true };
}
