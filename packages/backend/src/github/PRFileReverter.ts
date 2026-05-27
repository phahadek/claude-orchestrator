import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

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
}): Promise<{ commitSha: string | null; reverted: string[] }> {
  const { worktreePath, baseBranch, bannedFiles } = opts;

  if (bannedFiles.length === 0) {
    return { commitSha: null, reverted: [] };
  }

  // Save current worktree content for each banned file so we can restore after push
  const saved = new Map<string, Buffer | null>();
  for (const f of bannedFiles) {
    const abs = path.join(worktreePath, f);
    try {
      saved.set(f, fs.readFileSync(abs));
    } catch {
      saved.set(f, null);
    }
  }

  // Fetch base branch from origin so we have origin/<baseBranch> available
  await git(['fetch', 'origin', baseBranch], worktreePath).catch(() => {});

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
    return { commitSha: null, reverted: [] };
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
    // Nothing actually changed — restore worktree content and return no-op
    restoreWorktree(worktreePath, saved);
    return { commitSha: null, reverted: [] };
  }

  const fileList = reverted.join(', ');
  const message = `chore: orchestrator-revert: restore ${fileList} [auto-revert]`;

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
  const branch = (
    await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
  ).stdout.trim();
  await git(['push', 'origin', `HEAD:${branch}`], worktreePath);

  // Restore the worktree files (e.g. CLAUDE.md with orchestrator injection)
  restoreWorktree(worktreePath, saved);

  return { commitSha, reverted };
}

function restoreWorktree(
  worktreePath: string,
  saved: Map<string, Buffer | null>,
): void {
  for (const [f, content] of saved) {
    const abs = path.join(worktreePath, f);
    if (content !== null) {
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      } catch {
        // best-effort
      }
    }
  }
}
