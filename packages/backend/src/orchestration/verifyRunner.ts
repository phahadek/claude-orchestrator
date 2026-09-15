import { randomUUID } from 'crypto';
import type { StructuredTestResult } from '../db/types';
import {
  clearReportFiles,
  collectStructuredTestResult,
  runCommandWithTimeout,
} from '../session/test-runner';
import type { ToolVersionCheck } from '../session/orchestrator-config';
import {
  buildScopedEnv,
  checkToolchainVersions,
  formatToolchainMismatch,
} from './gateEnv';

export interface VerifyResult {
  passed: boolean;
  failedCommand?: string;
  truncatedOutput?: string;
  /** True when the failure is a host toolchain-version mismatch against a declared expected_tool_versions entry, not a code defect. */
  isToolInfraFailure?: boolean;
  /** Names the mismatched version_command and versions, for operator triage. */
  toolFailureReason?: string;
  /** True when the failure is a command that exceeded its timeout budget — a hung/wedged process, not a code defect. */
  isTimeoutInfraFailure?: boolean;
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

const OUTPUT_TAIL_CHARS = 750;

/**
 * Truncates a log to its final `chars` characters — the end of a test log is
 * where the failure summary lives, not the startup banner at the head. Both
 * writers of the ci_failing pause detail (this module and PRMergeWatcher)
 * must agree on this semantic, or the same failure produces two different
 * "truncated" excerpts depending on which code path wrote it.
 */
export function tailOfLog(
  output: string,
  chars: number = OUTPUT_TAIL_CHARS,
): string {
  return output.length > chars ? output.slice(output.length - chars) : output;
}

export interface RunVerifyAsGateOptions {
  /** Env var name -> path (relative to worktreePath) scoping a tool's cache to this worktree. See OrchestratorConfig.cache_env. */
  cacheEnv?: Record<string, string>;
  /** Toolchain versions this gate expects. See OrchestratorConfig.expected_tool_versions. */
  expectedToolVersions?: ToolVersionCheck[];
  /** Per-command timeout in seconds, mirroring the test: lane's OrchestratorConfig.test_timeout_sec. Default 300. */
  timeoutSec?: number;
  /** Max RSS in MB per verify subprocess, mirroring OrchestratorConfig.test_max_rss_mb. 0 = disabled. */
  maxRssMb?: number;
}

export async function runVerifyAsGate(
  worktreePath: string,
  commands: string[],
  testReportGlob?: string,
  options: RunVerifyAsGateOptions = {},
): Promise<VerifyResult> {
  if (commands.length === 0) return { passed: true };

  // Only awaits (and thus only yields a tick) when a project has actually
  // declared expected_tool_versions — the overwhelmingly common case is no
  // declaration, and staying fully synchronous up to the first spawn() call
  // in that case matches this function's pre-existing execution shape.
  if (options.expectedToolVersions && options.expectedToolVersions.length > 0) {
    const mismatch = await checkToolchainVersions(
      worktreePath,
      options.expectedToolVersions,
    );
    if (mismatch) {
      const reason = formatToolchainMismatch(mismatch);
      return {
        passed: false,
        isToolInfraFailure: true,
        toolFailureReason: reason,
        truncatedOutput: reason,
      };
    }
  }

  const env = buildScopedEnv(worktreePath, options.cacheEnv);

  const startedAt = testReportGlob ? Date.now() : undefined;
  if (testReportGlob) {
    clearReportFiles(worktreePath, testReportGlob);
  }

  const timeoutMs = (options.timeoutSec ?? 300) * 1000;
  const maxRssMb = options.maxRssMb ?? 0;
  const runId = randomUUID();

  for (const cmd of commands) {
    const { exitCode, output, timedOut } = await runCommandWithTimeout(
      cmd,
      worktreePath,
      timeoutMs,
      maxRssMb,
      runId,
      env,
    );
    if (exitCode !== 0) {
      const truncated = tailOfLog(
        timedOut ? `${output}\n[verify] TIMEOUT` : output,
      );
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
        ...(timedOut ? { isTimeoutInfraFailure: true } : {}),
      };
    }
  }

  return { passed: true };
}
