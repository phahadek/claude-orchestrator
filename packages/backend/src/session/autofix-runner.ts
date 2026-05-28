import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import yaml from 'js-yaml';

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
  projectDir: string,
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

  // Restore CLAUDE.md (both casings) so that prettier-formatting noise on the
  // orchestrator-injected file is never staged into the autofix commit.
  for (const file of ['CLAUDE.md', 'CLAUDE.MD']) {
    await spawnCmd('git', ['restore', file], { cwd: worktreePath });
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

  const commitResult = await spawnCmd(
    'git',
    ['commit', '-m', 'chore: apply autofix [orchestrator]'],
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

  const pushResult = await spawnCmd('git', ['push', 'origin', 'HEAD'], {
    cwd: worktreePath,
    env,
  });
  if (pushResult.exitCode !== 0) {
    const msg = `git push failed (exit ${pushResult.exitCode})`;
    log(`[autofix] ERROR: ${msg}\n`);
    failures.push(msg);
  }

  // Append SHA to .git-blame-ignore-revs at project root
  try {
    const blameIgnorePath = path.join(projectDir, '.git-blame-ignore-revs');
    fs.appendFileSync(
      blameIgnorePath,
      `${sha} # chore: apply autofix [orchestrator]\n`,
    );
    log(`[autofix] appended ${sha} to .git-blame-ignore-revs\n`);
  } catch (err) {
    log(`[autofix] WARN: failed to append to .git-blame-ignore-revs: ${err}\n`);
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
