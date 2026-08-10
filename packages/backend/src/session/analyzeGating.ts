import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { minimatch } from 'minimatch';
import { matchesPathDiff } from '../deploy/pathDiffPredicate';
import type { AnalyzeCommand } from './orchestrator-config';

export interface NormalizedAnalyzeCommand {
  command: string;
  trigger_paths?: string[];
  transient_output_patterns?: string[];
}

export function normalizeAnalyzeCommand(
  entry: AnalyzeCommand,
): NormalizedAnalyzeCommand {
  return typeof entry === 'string' ? { command: entry } : entry;
}

/** No trigger_paths configured = always run (plain-string backward-compat default). */
export function isAnalyzeCommandTriggered(
  entry: NormalizedAnalyzeCommand,
  diffPaths: string[],
): boolean {
  if (!entry.trigger_paths || entry.trigger_paths.length === 0) return true;
  return matchesPathDiff(entry.trigger_paths, diffPaths);
}

/**
 * Tests a failed analyze command's output against its config-supplied
 * `transient_output_patterns` (network/registry-failure regexes) — the
 * output-pattern counterpart to the timeout/OOM signals runTestCommands
 * already reports. Invalid regex patterns are skipped rather than throwing,
 * since a config typo shouldn't crash the analyze gate.
 */
export function matchesTransientOutputPattern(
  entry: NormalizedAnalyzeCommand,
  output: string,
): boolean {
  if (!entry.transient_output_patterns?.length) return false;
  return entry.transient_output_patterns.some((pattern) => {
    try {
      // eslint-disable-next-line security/detect-non-literal-regexp -- pattern comes from the project's own .claude-orchestrator.yml config, never external/user input.
      return new RegExp(pattern).test(output);
    } catch {
      return false;
    }
  });
}

function listWorktreeFiles(worktreePath: string): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['ls-files'], { cwd: worktreePath });
    const chunks: Buffer[] = [];
    proc.stdout?.on('data', (d) => chunks.push(d));
    proc.on('close', () => {
      resolve(
        Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean),
      );
    });
    proc.on('error', () => resolve([]));
  });
}

function hashFiles(worktreePath: string, files: string[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(path.join(worktreePath, file)));
    } catch {
      hash.update('MISSING');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Content hash over the current bytes of every worktree file matching
 * `triggerPaths`. Two PRs off the same base whose trigger-path files are
 * byte-identical (e.g. same package.json/lockfile) hash the same, letting
 * their analyze result be shared regardless of PR number or SHA. Returns
 * null when there are no trigger paths or no matching files — callers must
 * not cache on a null hash.
 */
export async function computeTriggerContentHash(
  worktreePath: string,
  triggerPaths: string[],
): Promise<string | null> {
  if (triggerPaths.length === 0) return null;
  const allFiles = await listWorktreeFiles(worktreePath);
  const matched = allFiles
    .filter((f) =>
      triggerPaths.some((glob) => minimatch(f, glob, { dot: true })),
    )
    .sort();
  if (matched.length === 0) return null;

  return hashFiles(worktreePath, matched);
}

/**
 * Whole-tree counterpart to computeTriggerContentHash: content hash over
 * every git-tracked file in the worktree, not just those matching a
 * trigger-path glob. This is F2's (the orchestrator-run test gate) cache
 * key — two PRs/pushes whose full tree content is byte-identical share one
 * test run via orchestrator_test_content_cache.
 */
export async function computeWorktreeContentHash(
  worktreePath: string,
): Promise<string> {
  const allFiles = await listWorktreeFiles(worktreePath);
  return hashFiles(worktreePath, [...allFiles].sort());
}
