/**
 * The one self-contained result package a test runner returns per run, and
 * the validator for a package arriving from outside this process. Consumed by
 * executeTestRequestRun (testRequestLane.ts) in place of a local
 * runTestCommands() return value.
 */

import type { StructuredTestResult } from '../db/types';

export interface RunnerCommandResult {
  command: string;
  /** null when the runner did not observe this command's verdict (e.g. skipped after a fail-fast stop). */
  passed: boolean | null;
}

export interface RunnerResultPackage {
  passed: boolean;
  output: string;
  commandResults: RunnerCommandResult[];
  failedCommand?: string;
  oomKilled: boolean;
  timedOut?: boolean;
  spawnFailed?: boolean;
  teardownVerificationFailed?: boolean;
  startedAt: number;
  finishedAt: number;
  /**
   * The runner's own execution-time peer-occupancy snapshot (excluding this
   * run) — never inferred from the orchestrator's admission-side semaphore,
   * which can diverge once the runner self-gates admission or provisioning
   * delays the start.
   */
  runnerConcurrentRunCount: number;
  /** Already-normalized report parsed on the runner; null when acquisition failed or no report is configured. */
  structuredResult: StructuredTestResult | null;
}

export type RunnerResultExecutor = (ctx: {
  runId: string;
  worktreePath: string;
  commands: string[];
}) => Promise<RunnerResultPackage>;

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Returns a list of problems; empty means the package is valid. */
export function validateRunnerResultPackage(pkg: unknown): string[] {
  const errs: string[] = [];
  if (!pkg || typeof pkg !== 'object') return ['package is not an object'];
  const p = pkg as Record<string, unknown>;
  if (typeof p.passed !== 'boolean') errs.push('passed must be boolean');
  if (typeof p.output !== 'string') errs.push('output must be string');
  if (typeof p.oomKilled !== 'boolean') errs.push('oomKilled must be boolean');
  if (!isNonNegInt(p.startedAt)) errs.push('startedAt must be a timestamp');
  if (!isNonNegInt(p.finishedAt)) errs.push('finishedAt must be a timestamp');
  if (
    isNonNegInt(p.startedAt) &&
    isNonNegInt(p.finishedAt) &&
    p.finishedAt < p.startedAt
  ) {
    errs.push('finishedAt precedes startedAt');
  }
  if (!isNonNegInt(p.runnerConcurrentRunCount)) {
    errs.push('runnerConcurrentRunCount must be a non-negative integer');
  }
  if (
    !Array.isArray(p.commandResults) ||
    !p.commandResults.every(
      (c) =>
        c &&
        typeof c === 'object' &&
        typeof (c as RunnerCommandResult).command === 'string' &&
        ((c as RunnerCommandResult).passed === null ||
          typeof (c as RunnerCommandResult).passed === 'boolean'),
    )
  ) {
    errs.push('commandResults must be an array of {command, passed}');
  }
  if (p.failedCommand !== undefined && typeof p.failedCommand !== 'string') {
    errs.push('failedCommand must be string when present');
  }
  if (p.passed === true && p.failedCommand !== undefined) {
    errs.push('passed run must not carry failedCommand');
  }
  const sr = p.structuredResult;
  if (sr !== null) {
    if (
      !sr ||
      typeof sr !== 'object' ||
      (sr as StructuredTestResult).format !== 'junit-xml' ||
      !Array.isArray((sr as StructuredTestResult).suites)
    ) {
      errs.push('structuredResult must be null or a junit-xml result');
    }
  }
  return errs;
}
