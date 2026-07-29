import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import yaml from 'js-yaml';
import { isHardBanned } from '../github/PRFileValidator';
import { recordEvent } from '../audit/AuditLog';
import { logger } from '../logger';

interface OrchestratorYml {
  autofix?: string[];
}

export interface AutofixResult {
  success: boolean;
  commitSha?: string;
  /** HEAD SHA after the local branch was synced to origin via fetch + reset --hard. */
  syncedTo?: string;
  /** Files included in the autofix commit (from git diff --name-only HEAD~1 HEAD). */
  touchedFiles?: string[];
  summary: string;
  /**
   * Non-empty when autofix commands exited 1 and reported violations they could not
   * fix automatically (e.g. ruff E501). The gate passes, but this is routed back to
   * the implementing session so the coding agent can fix them.
   */
  unfixableViolations?: string;
  /** True when a git operation (add/commit/push) exited 128 — infrastructure failure, not a code defect. */
  isGitInfraFailure?: boolean;
  /** Combined stderr/stdout of the failing git command, surfaced distinctly from summary. */
  gitFailureReason?: string;
  /** True when an autofix tool itself could not execute (config-load abort, toolchain incompatibility) — host issue, not a code defect. */
  isToolInfraFailure?: boolean;
  /** Names the tool and the reason it could not run, for operator triage. */
  toolFailureReason?: string;
}

// Conservative: only patterns that unambiguously indicate the tool itself
// failed to start/execute, never a diff/lint finding. When in doubt, a
// pattern must NOT be added here — a false positive here silently
// suppresses a legitimate fix request.
const TOOL_INFRA_FAILURE_PATTERNS: RegExp[] = [
  // golangci-lint (and similar) aborting before running any linter, e.g. a
  // host toolchain older than the repo's `go` directive.
  /go\.mod requires go\s*>=?\s*[\d.]+\s*\(running go\s*[\d.]+\)/i,
  /error loading config( file)?[:\s]/i,
  /can'?t (read|load) config/i,
  /unsupported version of (the )?go\b/i,
  // The invoked binary doesn't exist / isn't on PATH at all.
  /command not found/i,
  /executable file not found in \$?PATH/i,
  /is not recognized as an internal or external command/i,
];

/**
 * Recognises output indicating the autofix tool itself could not execute
 * (config-load abort, toolchain incompatibility, missing binary) as
 * distinct from a genuine diff/lint finding. Returns a reason string naming
 * the failing command when detected, or null when the output is ambiguous
 * or looks like a normal finding — ambiguous output must fall through to
 * the normal finding path, not be classified as an infra failure.
 */
export function isToolInfraFailureOutput(
  rawCmd: string,
  output: string,
): string | null {
  for (const pattern of TOOL_INFRA_FAILURE_PATTERNS) {
    const match = output.match(pattern);
    if (match) {
      const line =
        output.split('\n').find((l) => pattern.test(l))?.trim() ||
        match[0].trim();
      return `${rawCmd}: ${line}`;
    }
  }
  return null;
}

export const ORCHESTRATOR_BOT_EMAIL = 'bot@claude-code.internal';

const BOT_GIT_ENV = {
  GIT_AUTHOR_NAME: 'claude-orchestrator',
  GIT_AUTHOR_EMAIL: ORCHESTRATOR_BOT_EMAIL,
  GIT_COMMITTER_NAME: 'claude-orchestrator',
  GIT_COMMITTER_EMAIL: ORCHESTRATOR_BOT_EMAIL,
};

export function loadAutofixCommands(projectDir: string): string[] {
  const ymlPath = path.join(projectDir, '.claude-orchestrator.yml');
  if (!fs.existsSync(ymlPath)) return [];
  try {
    const raw = fs.readFileSync(ymlPath, 'utf-8');
    const parsed = yaml.load(raw) as OrchestratorYml | null;
    if (!parsed || !Array.isArray(parsed.autofix)) return [];
    return parsed.autofix.filter(
      (cmd): cmd is string => typeof cmd === 'string',
    );
  } catch (err) {
    logger.warn(`[autofix-runner] failed to parse ${ymlPath}: ${err}`);
    return [];
  }
}

function spawnCmd(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.on('error', (err) => resolve({ exitCode: 1, stdout: String(err) }));
    proc.on('close', (code) => resolve({ exitCode: code ?? 1, stdout: out }));
  });
}

function spawnShell(
  cmd: string,
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
  log: (msg: string) => void,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, { shell: true, cwd: opts.cwd, env: opts.env });
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
      log(d.toString());
    });
    proc.stderr?.on('data', (d: Buffer) => {
      out += d.toString();
      log(d.toString());
    });
    proc.on('error', (err) => resolve({ exitCode: 1, output: String(err) }));
    proc.on('close', (code) => resolve({ exitCode: code ?? 1, output: out }));
  });
}

async function isWorktreeDirty(cwd: string): Promise<boolean> {
  const { stdout } = await spawnCmd('git', ['status', '--porcelain'], { cwd });
  return stdout.trim().length > 0;
}

async function getHeadSha(cwd: string): Promise<string> {
  const { stdout } = await spawnCmd('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

async function getChangedFiles(
  worktreePath: string,
  baseBranch: string,
): Promise<string[]> {
  const { stdout } = await spawnCmd(
    'git',
    ['diff', '--name-only', `${baseBranch}...HEAD`],
    { cwd: worktreePath },
  );
  // A three-dot diff can list paths whose deletion is already committed in HEAD
  // (e.g. inherited from a merged/rebased dev where a sibling PR removed the
  // file). Such a path is absent from the worktree and has nothing to autofix
  // or stage; filtering here keeps both the {{changed_files}} expansion and the
  // `git add` staging step from ever seeing it.
  return stdout
    .split('\n')
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(worktreePath, f)));
}

/**
 * Expand {{changed_files}} in an autofix command string.
 * Returns null when the command should be skipped (placeholder present but no changed files).
 * Returns the command unchanged when no placeholder is present.
 */
export function expandAutofixCommand(
  cmd: string,
  changedFiles: string[],
): string | null {
  if (!cmd.includes('{{changed_files}}')) return cmd;
  if (changedFiles.length === 0) return null;
  const quoted = changedFiles
    .map((f) => `'${f.replace(/'/g, "'\\''")}'`)
    .join(' ');
  return cmd.replace(/\{\{changed_files\}\}/g, quoted);
}

export async function runAutofix(
  worktreePath: string,
  _projectDir: string,
  commands: string[],
  log: (msg: string) => void,
  baseBranch = 'dev',
  skipCi = true,
): Promise<AutofixResult> {
  if (commands.length === 0) {
    return { success: true, summary: 'no autofix commands configured' };
  }

  if (!fs.existsSync(worktreePath)) {
    log(
      `[autofix] worktree path no longer exists, skipping: ${worktreePath}\n`,
    );
    return {
      success: true,
      summary: 'autofix skipped: worktree path no longer exists',
    };
  }

  // Resolve the PR's changed files upfront: used both to expand {{changed_files}}
  // placeholders and to scope what the autofix commit is allowed to stage, so a
  // whole-repo formatter can't sweep unrelated pre-existing debt into the commit.
  const changedFiles = await getChangedFiles(worktreePath, baseBranch);

  const failures: string[] = [];
  // exit-1 output from linting tools that fixed what they could but left violations behind
  const violationChunks: string[] = [];

  for (const rawCmd of commands) {
    const cmd = expandAutofixCommand(rawCmd, changedFiles);
    if (cmd === null) {
      log(`[autofix] skipping (no changed files): ${rawCmd}\n`);
      continue;
    }
    log(`[autofix] running: ${cmd}\n`);
    const { exitCode, output } = await spawnShell(
      cmd,
      { cwd: worktreePath },
      log,
    );
    if (exitCode !== 0) {
      const toolFailureReason = isToolInfraFailureOutput(rawCmd, output);
      if (toolFailureReason) {
        log(`[autofix] ERROR: tool infra failure: ${toolFailureReason}\n`);
        return {
          success: false,
          isToolInfraFailure: true,
          toolFailureReason,
          summary: toolFailureReason,
        };
      }
      const msg = `command exited with code ${exitCode}: ${rawCmd}`;
      log(`[autofix] WARN: ${msg}\n`);
      if (exitCode === 1 && output.trim()) {
        // Treat exit 1 with output as unfixable violations (e.g. ruff E501)
        violationChunks.push(output.trim());
      } else {
        failures.push(msg);
      }
    }
  }

  const dirty = await isWorktreeDirty(worktreePath);
  const unfixableViolations =
    violationChunks.length > 0 ? violationChunks.join('\n---\n') : undefined;
  if (!dirty) {
    if (failures.length > 0) {
      return {
        success: false,
        summary: `autofix commands ran but produced no diff (failures: ${failures.join('; ')})`,
      };
    }
    return {
      success: true,
      summary: 'autofix commands produced no diff',
      unfixableViolations,
    };
  }

  // Commit the diff with bot identity
  const env = { ...process.env, ...BOT_GIT_ENV };

  // Stage only the PR's own changed files (not `git add -A`) so a whole-repo
  // formatter can't sweep unrelated, pre-existing formatting debt into the
  // autofix commit. `git add --` handles modified/added/deleted paths alike;
  // paths the formatter didn't touch are simply no-ops.
  if (changedFiles.length > 0) {
    const addResult = await spawnCmd('git', ['add', '--', ...changedFiles], {
      cwd: worktreePath,
      env,
    });
    if (addResult.exitCode !== 0) {
      const gitReason = addResult.stdout.trim();
      const msg = `git add failed (exit ${addResult.exitCode})`;
      log(`[autofix] ERROR: ${msg}\n`);
      if (addResult.exitCode === 128) {
        return {
          success: false,
          isGitInfraFailure: true,
          gitFailureReason: gitReason,
          summary: gitReason ? `${msg}: ${gitReason}` : msg,
        };
      }
      failures.push(msg);
    }
  }

  // Proactively un-stage hard-banned files so they never appear in the commit.
  const stagedListResult = await spawnCmd(
    'git',
    ['diff', '--cached', '--name-only'],
    { cwd: worktreePath },
  );
  const stagedFiles = stagedListResult.stdout.split('\n').filter(Boolean);
  for (const stagedFile of stagedFiles) {
    if (isHardBanned(stagedFile)) {
      log(`[autofix] un-staging banned file: ${stagedFile}\n`);
      await spawnCmd('git', ['restore', '--staged', '--', stagedFile], {
        cwd: worktreePath,
        env,
      });
      recordEvent({
        event_type: 'autofix_banned_file_unstaged',
        actor_type: 'system',
        actor_id: null,
        project_id: null,
        task_id: null,
        payload: { file: stagedFile, worktree_path: worktreePath },
      });
    }
  }

  // Nothing staged either because the only changes were to out-of-scope files
  // (formatter touched files outside the PR diff) or because un-staging banned
  // files left nothing behind. Either way, skip the commit entirely.
  const remainingResult = await spawnCmd(
    'git',
    ['diff', '--cached', '--name-only'],
    { cwd: worktreePath },
  );
  if (!remainingResult.stdout.trim()) {
    if (failures.length > 0) {
      return {
        success: false,
        summary: `autofix: no in-scope changes staged; skipped commit (failures: ${failures.join('; ')})`,
      };
    }
    return {
      success: true,
      summary: 'autofix: no in-scope changes staged; skipped commit',
      unfixableViolations,
    };
  }

  // Use --no-verify so the target repo's own pre-commit hooks do not re-run
  // on the orchestrator's internal autofix commit. The orchestrator runs its own
  // verify/analyze gate — redundant hook invocations here only cause spurious
  // exit-1 failures (e.g. polimarket E501).
  const commitMsg =
    'chore: apply autofix [orchestrator]' + (skipCi ? ' [skip ci]' : '');
  const commitResult = await spawnCmd(
    'git',
    ['commit', '--no-verify', '-m', commitMsg],
    { cwd: worktreePath, env },
  );
  if (commitResult.exitCode !== 0) {
    const gitReason = commitResult.stdout.trim();
    const msg = `git commit failed (exit ${commitResult.exitCode})`;
    log(`[autofix] ERROR: ${msg}\n`);
    if (commitResult.exitCode === 128) {
      return {
        success: false,
        isGitInfraFailure: true,
        gitFailureReason: gitReason,
        summary: gitReason ? `${msg}: ${gitReason}` : msg,
      };
    }
    return {
      success: false,
      summary: [...failures, msg].join('; '),
    };
  }

  const sha = await getHeadSha(worktreePath);
  log(`[autofix] committed ${sha}\n`);

  // Collect the files included in the commit so callers can populate _revertLock
  let touchedFiles: string[] | undefined;
  try {
    const diffResult = await spawnCmd(
      'git',
      ['diff', '--name-only', 'HEAD~1', 'HEAD'],
      { cwd: worktreePath },
    );
    touchedFiles = diffResult.stdout.split('\n').filter(Boolean);
  } catch {
    // best-effort
  }

  // Capture current branch before pushing so we can sync to it afterward
  const { stdout: branchRaw } = await spawnCmd(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: worktreePath },
  );
  const branch = branchRaw.trim();

  const pushResult = await spawnCmd('git', ['push', 'origin', 'HEAD'], {
    cwd: worktreePath,
    env,
  });
  if (pushResult.exitCode !== 0) {
    const gitReason = pushResult.stdout.trim();
    const msg = `git push failed (exit ${pushResult.exitCode})`;
    log(`[autofix] ERROR: ${msg}\n`);
    if (pushResult.exitCode === 128) {
      return {
        success: false,
        isGitInfraFailure: true,
        gitFailureReason: gitReason,
        commitSha: sha,
        touchedFiles,
        summary: gitReason
          ? `autofix committed ${sha} but ${msg}: ${gitReason}`
          : `autofix committed ${sha} but ${msg}`,
      };
    }
    failures.push(msg);
  }

  // Sync local branch to origin after push so subsequent git operations see
  // a consistent state (no local/origin divergence).
  let syncedTo: string | undefined;
  if (failures.length === 0 && branch && branch !== 'HEAD') {
    const fetchResult = await spawnCmd('git', ['fetch', 'origin', branch], {
      cwd: worktreePath,
    });
    if (fetchResult.exitCode === 0) {
      const resetResult = await spawnCmd(
        'git',
        ['reset', '--hard', `origin/${branch}`],
        { cwd: worktreePath },
      );
      if (resetResult.exitCode === 0) {
        const headResult = await spawnCmd('git', ['rev-parse', 'HEAD'], {
          cwd: worktreePath,
        });
        syncedTo = headResult.stdout.trim() || undefined;
        log(`[autofix] synced to origin/${branch} at ${syncedTo}\n`);
      }
    }
  }

  const success = failures.length === 0;
  const summary = success
    ? `autofix committed ${sha}`
    : `autofix committed ${sha} with failures: ${failures.join('; ')}`;

  return {
    success,
    commitSha: sha,
    syncedTo,
    touchedFiles,
    summary,
    unfixableViolations: success ? unfixableViolations : undefined,
  };
}
