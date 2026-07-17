import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

export interface StaleIndexLockDeps {
  resolveGitDir: (worktreePath: string) => Promise<string | null>;
  statLock: (lockPath: string) => Promise<{ size: number } | null>;
  hasLiveGitProcess: (worktreePath: string) => Promise<boolean>;
  removeLock: (lockPath: string) => Promise<void>;
}

async function defaultResolveGitDir(
  worktreePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-dir'], {
      cwd: worktreePath,
    });
    const gitDir = stdout.trim();
    return gitDir ? path.resolve(worktreePath, gitDir) : null;
  } catch {
    return null;
  }
}

async function defaultStatLock(
  lockPath: string,
): Promise<{ size: number } | null> {
  try {
    const st = await fs.promises.stat(lockPath);
    return { size: st.size };
  } catch {
    return null;
  }
}

async function defaultRemoveLock(lockPath: string): Promise<void> {
  await fs.promises.unlink(lockPath);
}

/**
 * Scans /proc for a running `git` process whose cwd is inside worktreePath.
 * Non-Linux platforms (and any /proc read failure) can't be verified, so we
 * report "live" to stay on the safe side and never remove a held lock.
 */
async function defaultHasLiveGitProcess(
  worktreePath: string,
): Promise<boolean> {
  if (process.platform !== 'linux') return true;

  let pids: string[];
  try {
    pids = (await fs.promises.readdir('/proc')).filter((n) => /^\d+$/.test(n));
  } catch {
    return true;
  }

  const target = path.resolve(worktreePath);
  for (const pid of pids) {
    try {
      const cmdlineRaw = await fs.promises.readFile(
        `/proc/${pid}/cmdline`,
        'utf8',
      );
      const argv = cmdlineRaw.split('\0').filter(Boolean);
      if (!argv.length) continue;
      const cmd = argv[0].split('/').pop();
      if (cmd !== 'git') continue;

      const cwdLink = await fs.promises.readlink(`/proc/${pid}/cwd`);
      const resolvedCwd = path.resolve(cwdLink);
      if (resolvedCwd === target || resolvedCwd.startsWith(target + path.sep)) {
        return true;
      }
    } catch {
      // process exited mid-scan, or /proc/<pid> is unreadable — ignore it
    }
  }
  return false;
}

export const defaultStaleIndexLockDeps: StaleIndexLockDeps = {
  resolveGitDir: defaultResolveGitDir,
  statLock: defaultStatLock,
  hasLiveGitProcess: defaultHasLiveGitProcess,
  removeLock: defaultRemoveLock,
};

/**
 * Recovers a worktree wedged by a git process that was killed mid-commit.
 * Git writes index.lock and atomically renames it onto index on success, so
 * a 0-byte index.lock means the rename never happened: the real index is
 * intact and the lock is safe to clear, but only when no live git process
 * still holds it for this worktree.
 *
 * Returns true when a stale lock was found and removed.
 */
export async function recoverStaleIndexLock(
  worktreePath: string,
  deps: StaleIndexLockDeps = defaultStaleIndexLockDeps,
): Promise<boolean> {
  const gitDir = await deps.resolveGitDir(worktreePath);
  if (!gitDir) return false;

  const lockPath = path.join(gitDir, 'index.lock');
  const stat = await deps.statLock(lockPath);
  if (!stat || stat.size !== 0) return false;

  if (await deps.hasLiveGitProcess(worktreePath)) {
    return false;
  }

  try {
    await deps.removeLock(lockPath);
  } catch (err) {
    logger.warn(
      `[staleIndexLock] failed to remove stale index.lock at ${lockPath}: ${err}`,
    );
    return false;
  }

  logger.info(
    `[staleIndexLock] removed stale 0-byte index.lock for worktree ${worktreePath}`,
  );
  return true;
}
