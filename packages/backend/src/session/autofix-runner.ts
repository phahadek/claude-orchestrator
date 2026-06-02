import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import yaml from 'js-yaml';
import { isHardBanned } from '../github/PRFileValidator';
import { recordEvent } from '../audit/AuditLog';

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
    console.warn(`[autofix-runner] failed to parse ${ymlPath}: ${err}`);
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
    proc.on('close', (code) => resolve({ exitCode: code ?? 1, stdout: out }));
  });
}

function spawnShell(
  cmd: string,
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
  log: (msg: string) => void,
): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, { shell: true, cwd: opts.cwd, env: opts.env });
    proc.stdout?.on('data', (d: Buffer) => log(d.toString()));
    proc.stderr?.on('data', (d: Buffer) => log(d.toString()));
    proc.on('close', (code) => resolve({ exitCode: code ?? 1 }));
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

export async function runAutofix(
  worktreePath: string,
  _projectDir: string,
  commands: string[],
  log: (msg: string) => void,
): Promise<AutofixResult> {
  if (commands.length === 0) {
    return { success: true, summary: 'no autofix commands configured' };
  }

  const failures: string[] = [];

  for (const cmd of commands) {
    log(`[autofix] running: ${cmd}\n`);
    const { exitCode } = await spawnShell(cmd, { cwd: worktreePath }, log);
    if (exitCode !== 0) {
      const msg = `command exited with code ${exitCode}: ${cmd}`;
      log(`[autofix] WARN: ${msg}\n`);
      failures.push(msg);
    }
  }

  const dirty = await isWorktreeDirty(worktreePath);
  if (!dirty) {
    const summary =
      failures.length > 0
        ? `autofix commands ran but produced no diff (failures: ${failures.join('; ')})`
        : 'autofix commands produced no diff';
    return { success: failures.length === 0, summary };
  }

  // Commit the diff with bot identity
  const env = { ...process.env, ...BOT_GIT_ENV };

  const addResult = await spawnCmd('git', ['add', '-A'], {
    cwd: worktreePath,
    env,
  });
  if (addResult.exitCode !== 0) {
    const msg = `git add -A failed (exit ${addResult.exitCode})`;
    log(`[autofix] ERROR: ${msg}\n`);
    failures.push(msg);
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

  // If un-staging banned files left nothing staged, skip the commit entirely.
  const remainingResult = await spawnCmd(
    'git',
    ['diff', '--cached', '--name-only'],
    { cwd: worktreePath },
  );
  if (!remainingResult.stdout.trim()) {
    const summary =
      failures.length > 0
        ? `autofix: only banned files were staged; skipped commit (failures: ${failures.join('; ')})`
        : 'autofix: only banned files were staged; skipped commit';
    return { success: failures.length === 0, summary };
  }

  const commitResult = await spawnCmd(
    'git',
    ['commit', '-m', 'chore: apply autofix [orchestrator] [skip ci]'],
    { cwd: worktreePath, env },
  );
  if (commitResult.exitCode !== 0) {
    const msg = `git commit failed (exit ${commitResult.exitCode})`;
    log(`[autofix] ERROR: ${msg}\n`);
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

  // Append the autofix commit SHA to .git-blame-ignore-revs inside the
  // worktree and commit it before pushing, so the entry travels with the PR
  // branch and is never left as uncommitted dirt in the main-repo working tree.
  try {
    const blameIgnorePath = path.join(worktreePath, '.git-blame-ignore-revs');
    fs.appendFileSync(
      blameIgnorePath,
      `${sha} # chore: apply autofix [orchestrator]\n`,
    );
    await spawnCmd('git', ['add', '.git-blame-ignore-revs'], {
      cwd: worktreePath,
      env,
    });
    const blameCommitResult = await spawnCmd(
      'git',
      ['commit', '-m', 'chore: update .git-blame-ignore-revs [orchestrator]'],
      { cwd: worktreePath, env },
    );
    if (blameCommitResult.exitCode === 0) {
      log(`[autofix] committed ${sha} to .git-blame-ignore-revs\n`);
    } else {
      log(
        `[autofix] WARN: failed to commit .git-blame-ignore-revs (exit ${blameCommitResult.exitCode})\n`,
      );
    }
  } catch (err) {
    log(`[autofix] WARN: failed to write .git-blame-ignore-revs: ${err}\n`);
  }

  const pushResult = await spawnCmd('git', ['push', 'origin', 'HEAD'], {
    cwd: worktreePath,
    env,
  });
  if (pushResult.exitCode !== 0) {
    const msg = `git push failed (exit ${pushResult.exitCode})`;
    log(`[autofix] ERROR: ${msg}\n`);
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

  return { success, commitSha: sha, syncedTo, touchedFiles, summary };
}
