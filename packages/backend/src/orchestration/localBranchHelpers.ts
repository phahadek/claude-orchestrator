import { execFile } from 'child_process';
import { promisify } from 'util';
import { recoverStaleIndexLock } from './staleIndexLock';
import { logger } from '../logger';

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
 *
 * Only exit code 1 means "has diff" — any other failure (bad revision,
 * missing worktree, dubious ownership, etc.) means the diff could not be
 * determined at all. Treating those as "has diff" would silently block the
 * no-op investigator gate downstream (recoverSession requires !hasDiff), so
 * on an indeterminate result this fails safe by reporting "no diff" and
 * logging the underlying error instead.
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
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 1) {
      return true; // exit 1 = diff present
    }
    logger.error(
      `[hasNonEmptyDiff] could not determine diff for ${baseBranch}..${featureBranch} in ${worktreePath}, failing safe as no-diff: ${e}`,
    );
    return false;
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

type PreTestMergeOutcome =
  | 'up_to_date'
  | 'merged'
  | 'conflict'
  | 'dirty_refused'
  | 'error';

export interface PreTestMergeResult {
  outcome: PreTestMergeOutcome;
  /** Worktree HEAD after the merge; set for 'up_to_date' and 'merged'. */
  mergedSha?: string;
  detail?: string;
}

const MERGE_IDENTITY = [
  '-c',
  'user.name=claude-orchestrator',
  '-c',
  'user.email=bot@claude-code.internal',
];

/** Best-effort `git fetch origin <branch>`; a failure falls back to the local ref. */
export async function fetchBaseBranch(
  worktreePath: string,
  baseBranch: string,
): Promise<void> {
  try {
    await gitExec(['fetch', 'origin', baseBranch], worktreePath);
  } catch (e) {
    logger.warn(
      `[fetchBaseBranch] git fetch origin ${baseBranch} failed (continuing with local ref): ${execFailure(e).text}`,
    );
  }
}

function execFailure(e: unknown): { code: unknown; text: string } {
  const err = e as { code?: unknown; stderr?: string; stdout?: string };
  return {
    code: err.code,
    text: `${err.stderr ?? ''}${err.stdout ?? ''}`.trim() || String(e),
  };
}

/**
 * Merges `baseRef` into the branch checked out in `worktreePath`. A textual
 * conflict is detected first via checkout-free `git merge-tree --write-tree`,
 * so a conflicting merge never mutates the worktree. The real merge is plain
 * `git merge`, which succeeds over unrelated uncommitted work and itself
 * refuses (reported as 'dirty_refused') when uncommitted changes overlap files
 * the merge would touch.
 */
export async function mergeBaseIntoSessionBranch(
  worktreePath: string,
  baseRef: string,
): Promise<PreTestMergeResult> {
  const headSha = async (): Promise<string> =>
    (await gitExec(['rev-parse', 'HEAD'], worktreePath)).stdout.trim();
  try {
    try {
      await gitExec(
        ['merge-base', '--is-ancestor', baseRef, 'HEAD'],
        worktreePath,
      );
      return { outcome: 'up_to_date', mergedSha: await headSha() };
    } catch (e) {
      if (execFailure(e).code !== 1) throw e;
    }

    try {
      await gitExec(
        ['merge-tree', '--write-tree', 'HEAD', baseRef],
        worktreePath,
      );
    } catch (e) {
      const f = execFailure(e);
      if (f.code === 1) return { outcome: 'conflict', detail: f.text };
      throw e;
    }

    try {
      await gitExec(
        [...MERGE_IDENTITY, 'merge', '--no-edit', baseRef],
        worktreePath,
      );
    } catch (e) {
      const f = execFailure(e);
      if (/would be overwritten|untracked working tree files/i.test(f.text)) {
        return { outcome: 'dirty_refused', detail: f.text };
      }
      await gitExec(['merge', '--abort'], worktreePath).catch(() => undefined);
      return { outcome: 'error', detail: f.text };
    }
    return { outcome: 'merged', mergedSha: await headSha() };
  } catch (e) {
    const f = execFailure(e);
    logger.warn(
      `[mergeBaseIntoSessionBranch] merge of ${baseRef} in ${worktreePath} failed: ${f.text}`,
    );
    return { outcome: 'error', detail: f.text };
  }
}
