import { execFile } from 'child_process';
import { promisify } from 'util';
import { recoverStaleIndexLock } from './staleIndexLock';

const execFileAsync = promisify(execFile);

async function gitExec(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  await recoverStaleIndexLock(cwd);
  return execFileAsync('git', args, { cwd });
}

/**
 * Returns the name of the currently checked-out branch in the given worktree,
 * or null if it cannot be determined.
 */
export async function getCurrentBranch(
  worktreePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await gitExec(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      worktreePath,
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Returns true when the diff between baseBranch..featureBranch is non-empty.
 * Uses git diff --quiet which exits 0 for empty diff and 1 for non-empty.
 */
export async function hasNonEmptyDiff(
  worktreePath: string,
  baseBranch: string,
  featureBranch: string,
): Promise<boolean> {
  try {
    await gitExec(
      ['diff', '--quiet', `${baseBranch}..${featureBranch}`],
      worktreePath,
    );
    return false; // exit 0 = no diff
  } catch {
    return true; // exit non-zero = has diff
  }
}

/**
 * Returns true when merging featureBranch into baseBranch would produce conflicts.
 * Checkout-free: uses `git merge-tree --write-tree` to compute the merge
 * result without touching any working tree or index, so this is safe to call
 * even when baseBranch is checked out in another worktree (e.g. the
 * project's primary working tree).
 */
export async function detectMergeConflict(
  worktreePath: string,
  baseBranch: string,
  featureBranch: string,
): Promise<boolean> {
  try {
    await gitExec(
      ['merge-tree', '--write-tree', baseBranch, featureBranch],
      worktreePath,
    );
    return false;
  } catch {
    return true;
  }
}
