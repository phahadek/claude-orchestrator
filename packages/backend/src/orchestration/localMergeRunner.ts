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
 * Squash-merges featureBranch into baseBranch, then deletes the feature
 * branch. The squash commit uses the taskName as the commit message and the
 * claude-orchestrator bot identity.
 *
 * Checkout-free: computes the merged tree via `git merge-tree --write-tree`,
 * builds the squash commit via `git commit-tree`, and atomically advances
 * baseBranch via `git update-ref`. Nothing is ever checked out, so this is
 * safe to call from a worktree whose baseBranch is checked out elsewhere
 * (e.g. the project's primary working tree).
 *
 * Returns { merged: true, commitSha } on success.
 * Returns { merged: false, conflict: true } if merging would conflict.
 */
export async function squashMergeLocal(
  args: SquashMergeLocalArgs,
): Promise<SquashMergeLocalResult> {
  const { worktreePath, baseBranch, featureBranch, taskName } = args;

  const baseSha = (
    await gitExec(['rev-parse', baseBranch], worktreePath)
  ).stdout.trim();

  let treeSha: string;
  try {
    const { stdout } = await gitExec(
      ['merge-tree', '--write-tree', baseBranch, featureBranch],
      worktreePath,
    );
    treeSha = stdout.trim().split('\n')[0];
  } catch {
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
    const { stdout } = await gitExec(
      ['commit-tree', treeSha, '-p', baseSha, '-m', taskName],
      worktreePath,
      botEnv,
    );
    commitSha = stdout.trim();
  } catch {
    return { merged: false, conflict: false };
  }

  await gitExec(
    ['update-ref', `refs/heads/${baseBranch}`, commitSha, baseSha],
    worktreePath,
  );

  // worktreePath's own checked-out branch is typically featureBranch itself
  // (the session's worktree). Git refuses to delete a branch that's checked
  // out in the worktree running the command, so detach that worktree's own
  // HEAD first — this never touches the base branch or any other worktree.
  const currentBranch = (
    await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
  ).stdout.trim();
  if (currentBranch === featureBranch) {
    await gitExec(['checkout', '--detach', 'HEAD'], worktreePath);
  }

  await gitExec(['branch', '-D', featureBranch], worktreePath);

  return { merged: true, commitSha };
}
