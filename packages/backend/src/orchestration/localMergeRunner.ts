import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface SquashMergeLocalArgs {
  worktreePath: string;
  baseBranch: string;
  featureBranch: string;
  taskName: string;
}

export interface SquashMergeLocalResult {
  merged: boolean;
  conflict?: boolean;
  commitSha?: string;
}

async function gitExec(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd, env });
}

/**
 * Squash-merges featureBranch into baseBranch in the given worktree, then
 * deletes the feature branch. The squash commit uses the taskName as the
 * commit message and the claude-orchestrator bot identity.
 *
 * Returns { merged: true, commitSha } on success.
 * Returns { merged: false, conflict: true } if conflicts are detected;
 * the worktree is restored to the feature branch with no in-progress merge.
 */
export async function squashMergeLocal(
  args: SquashMergeLocalArgs,
): Promise<SquashMergeLocalResult> {
  const { worktreePath, baseBranch, featureBranch, taskName } = args;

  await gitExec(['checkout', baseBranch], worktreePath);

  let mergeHadConflict = false;
  try {
    await gitExec(['merge', '--squash', featureBranch], worktreePath);
  } catch {
    mergeHadConflict = true;
  }

  if (!mergeHadConflict) {
    // Check for conflict markers left by git merge --squash in a partially-conflicted state
    try {
      const { stdout } = await gitExec(['diff', '--check'], worktreePath);
      if (stdout.trim().length > 0) {
        mergeHadConflict = true;
      }
    } catch {
      mergeHadConflict = true;
    }
  }

  if (mergeHadConflict) {
    // Abort merge and restore to feature branch
    await gitExec(['merge', '--abort'], worktreePath).catch(() => {});
    // Clean up any staged files from a partial squash
    await gitExec(['reset', '--merge'], worktreePath).catch(() => {});
    await gitExec(['checkout', featureBranch], worktreePath);
    return { merged: false, conflict: true };
  }

  const botEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'claude-orchestrator',
    GIT_AUTHOR_EMAIL: 'bot@claude-code.internal',
    GIT_COMMITTER_NAME: 'claude-orchestrator',
    GIT_COMMITTER_EMAIL: 'bot@claude-code.internal',
  };

  let commitSha: string;
  try {
    await gitExec(['commit', '-m', taskName], worktreePath, botEnv);
    const { stdout } = await gitExec(['rev-parse', 'HEAD'], worktreePath);
    commitSha = stdout.trim();
  } catch {
    // Commit failed — restore feature branch
    await gitExec(['reset', '--merge'], worktreePath).catch(() => {});
    await gitExec(['checkout', featureBranch], worktreePath);
    return { merged: false, conflict: false };
  }

  await gitExec(['branch', '-D', featureBranch], worktreePath);

  return { merged: true, commitSha };
}
