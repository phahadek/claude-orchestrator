import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd });
}

export async function revertBannedFiles(opts: {
  worktreePath: string;
  baseBranch: string;
  bannedFiles: string[];
  prNumber: number;
  repo: string;
}): Promise<{
  commitSha: string | null;
  reverted: string[];
  syncedTo: string | null;
}> {
  const { worktreePath, baseBranch, bannedFiles } = opts;

  if (bannedFiles.length === 0) {
    return { commitSha: null, reverted: [], syncedTo: null };
  }

  // Fetch base branch from origin so we have origin/<baseBranch> available
  await git(['fetch', 'origin', baseBranch], worktreePath).catch(() => {});

  // Sync local HEAD with the remote feature branch so that commits pushed by
  // the session agent via GitHub API (which don't update the local git state)
  // are included in the diff. Without this, git diff --cached against the
  // previous revert commit shows no changes even when new violations exist.
  const currentBranch = (
    await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath).catch(
      () => ({ stdout: '' }),
    )
  ).stdout.trim();
  if (currentBranch) {
    await git(['fetch', 'origin', currentBranch], worktreePath).catch(() => {});
    await git(
      ['reset', '--hard', `origin/${currentBranch}`],
      worktreePath,
    ).catch(() => {});
  }

  const reverted: string[] = [];

  for (const f of bannedFiles) {
    try {
      // Try to restore the file from origin/<baseBranch>.
      // This works for tracked files. If the file didn't exist on the base branch
      // (i.e. it was added by the session), the checkout will fail.
      await git(['checkout', `origin/${baseBranch}`, '--', f], worktreePath);
      reverted.push(f);
    } catch {
      // File wasn't on the base branch — remove it entirely
      try {
        await git(['rm', '-f', '--', f], worktreePath);
        reverted.push(f);
      } catch {
        // File may already be gone; still mark as reverted so we attempt the commit
        reverted.push(f);
      }
    }
  }

  if (reverted.length === 0) {
    return { commitSha: null, reverted: [], syncedTo: null };
  }

  // Stage the reverted files
  await git(['add', '--', ...reverted], worktreePath).catch(() => {});

  // Check if there's actually a diff to commit
  let hasStagedChanges = false;
  try {
    await git(['diff', '--cached', '--quiet'], worktreePath);
    // exit 0 = no staged changes
  } catch {
    hasStagedChanges = true;
  }

  if (!hasStagedChanges) {
    return { commitSha: null, reverted: [], syncedTo: null };
  }

  const fileList = reverted.join(', ');
  const message = `chore: orchestrator-revert: restore ${fileList} [auto-revert] [skip ci]`;

  await git(
    [
      '-c',
      'user.name=Orchestrator',
      '-c',
      'user.email=orchestrator@claude-code',
      'commit',
      '-m',
      message,
    ],
    worktreePath,
  );

  const { stdout: sha } = await git(['rev-parse', 'HEAD'], worktreePath);
  const commitSha = sha.trim();

  // Push the revert commit
  await git(['push', 'origin', `HEAD:${currentBranch}`], worktreePath);

  // Intentionally do NOT restore the worktree files to their pre-revert (injected) state.
  // Restoring would allow the next `git add` cycle to re-stage the banned file,
  // causing the repeated contamination loop observed in PR #410.
  // The base-branch content stays on disk so subsequent git add cycles are clean.

  // Sync the local branch pointer to match origin after the push so the session's
  // subsequent git operations see a consistent state (no divergence between local
  // and origin/<branch>).
  const syncedTo = await syncToOrigin(worktreePath, currentBranch);

  return { commitSha, reverted, syncedTo };
}

/**
 * Fetch the named branch from origin and hard-reset the local HEAD to match it.
 * Returns the resulting HEAD SHA, or null if either step fails.
 * Exported for use by ReviewOrchestrator boot-retry logic.
 */
export async function syncToOrigin(
  worktreePath: string,
  branch: string,
): Promise<string | null> {
  try {
    await git(['fetch', 'origin', branch], worktreePath);
    await git(['reset', '--hard', `origin/${branch}`], worktreePath);
    const { stdout } = await git(['rev-parse', 'HEAD'], worktreePath);
    return stdout.trim();
  } catch {
    return null;
  }
}
