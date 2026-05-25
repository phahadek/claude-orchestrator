import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function gitExec(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
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
 * Checks out baseBranch, runs git merge --no-commit --no-ff <featureBranch>,
 * then runs git merge --abort to restore the worktree to the pre-merge state
 * (on baseBranch with no in-progress merge).
 */
export async function detectMergeConflict(
  worktreePath: string,
  baseBranch: string,
  featureBranch: string,
): Promise<boolean> {
  await gitExec(['checkout', baseBranch], worktreePath);

  let hasConflict = false;
  try {
    await gitExec(
      ['merge', '--no-commit', '--no-ff', featureBranch],
      worktreePath,
    );
  } catch {
    // Non-zero exit = merge had conflicts
    hasConflict = true;
  }

  // Abort the in-progress merge to restore worktree to clean baseBranch state.
  // Ignore errors when there is no in-progress merge (e.g. "Already up to date").
  await gitExec(['merge', '--abort'], worktreePath).catch(() => {});

  return hasConflict;
}
