import { execSync } from 'child_process';
import { logger } from '../logger';
import { getCorporateMode } from '../config/corporateMode';
import { ProjectService } from '../projects/ProjectService';
import { slugify, deriveBranchSlug } from './branchSlug';

export type BranchMode = 'two_tier' | 'flat';

export { slugify, deriveBranchSlug };

export type BranchProbe = 'exists' | 'absent' | 'unknown';

/**
 * Probes whether `branch` exists as a local ref in `projectDir`, distinguishing
 * a confirmed negative (git ran and reported the ref absent) from an
 * inconclusive result (the invocation itself failed — spawn error, timeout,
 * unexpected exit code/signal). Callers that treat absence as "safe to
 * proceed" must treat 'unknown' the same as 'exists' — fail closed.
 *
 * `--quiet` is load-bearing: without it `git rev-parse --verify` reports a
 * missing ref as exit 128 with `fatal: Needed a single revision` on stderr,
 * which is indistinguishable from a genuine invocation failure and so reads
 * as 'unknown' for every absent branch. With it, a missing ref is exit 1
 * with empty stderr — the shape the absent-detection below matches on.
 */
export function probeBranchLocally(
  branch: string,
  projectDir: string,
): BranchProbe {
  try {
    execSync(`git rev-parse --verify --quiet refs/heads/${branch}`, {
      cwd: projectDir,
      stdio: 'pipe',
    });
    return 'exists';
  } catch (err) {
    const e = err as {
      status?: number | null;
      signal?: string | null;
      code?: string;
      errno?: number;
      stderr?: Buffer | string;
    };
    const stderr = e.stderr?.toString() ?? '';
    if (e.status === 1 && e.signal == null && stderr.trim() === '') {
      return 'absent';
    }
    logger.warn(
      `[branchModel] probeBranchLocally inconclusive for branch ${branch} — code=${e.code ?? 'n/a'} status=${e.status ?? 'n/a'} signal=${e.signal ?? 'n/a'} stderr=${stderr.trim()}`,
    );
    return 'unknown';
  }
}

/**
 * Cap on uniquification probes — purely a defensive backstop against an
 * unbounded loop; a real collision chain this long has never been observed.
 */
const MAX_BRANCH_UNIQUIFY_ATTEMPTS = 1000;

/**
 * Resolves the first of `<base>`, `<base>-2`, `<base>-3`, ... not already
 * present as a local ref in `projectDir`. Returns `base` unchanged when it
 * has no collision — the common case, so nothing changes when there is no
 * collision. A branch outlives its owning session by design (it holds
 * committed work), so a dead session's branch must never block a later
 * launch for the same task; this lets that launch proceed on a fresh branch
 * alongside the stranded one instead of failing forever on
 * `git worktree add -b`.
 *
 * `probeBranchLocally`'s 'unknown' result (an inconclusive git invocation)
 * is treated the same as 'exists' for the purpose of not returning that
 * name — fail closed, never risk colliding with a ref we couldn't actually
 * verify is absent. But unlike 'exists', 'unknown' aborts the search
 * immediately instead of continuing to probe: an inconclusive invocation
 * most plausibly means git itself is failing (spawn exhaustion, not a repo,
 * timeout), and looping through up to 1000 more candidates would just
 * amplify that failure with 1000 more subprocess spawns.
 */
export function resolveAvailableBranchSlug(
  base: string,
  projectDir: string,
): string {
  const baseProbe = probeBranchLocally(base, projectDir);
  if (baseProbe === 'absent') {
    return base;
  }
  if (baseProbe === 'unknown') {
    throw new Error(
      `[branchModel] resolveAvailableBranchSlug: git invocation to probe branch "${base}" was inconclusive — aborting instead of probing further candidates`,
    );
  }
  for (let i = 2; i <= MAX_BRANCH_UNIQUIFY_ATTEMPTS; i++) {
    const candidate = `${base}-${i}`;
    const probe = probeBranchLocally(candidate, projectDir);
    if (probe === 'absent') {
      return candidate;
    }
    if (probe === 'unknown') {
      throw new Error(
        `[branchModel] resolveAvailableBranchSlug: git invocation to probe branch "${candidate}" was inconclusive — aborting instead of probing further candidates`,
      );
    }
  }
  throw new Error(
    `[branchModel] resolveAvailableBranchSlug: exhausted ${MAX_BRANCH_UNIQUIFY_ATTEMPTS} uniquification attempts for base "${base}"`,
  );
}

/**
 * Resolves the worktree path currently checked out to `branch`, if any, by
 * parsing `git worktree list --porcelain`. Returns null when the branch has
 * no registered worktree (e.g. it exists but is not checked out anywhere) or
 * the list can't be read.
 */
export function findWorktreePathForBranch(
  branch: string,
  projectDir: string,
): string | null {
  try {
    const out = execSync('git worktree list --porcelain', {
      cwd: projectDir,
      stdio: 'pipe',
    }).toString();
    let currentPath: string | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length).trim();
      } else if (line === `branch refs/heads/${branch}`) {
        return currentPath;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolves the branch to use for resuming an existing session's worktree.
 *
 * Branches created before the task-id-based suffix landed were named from
 * the title-only derivation (`deriveBranchSlug(taskTitle)`). For short
 * titles (no hash suffix) the two derivations are identical, so there is
 * nothing to resolve. For long titles, if the id-based branch doesn't exist
 * locally but the legacy title-only branch does, resume against the legacy
 * branch — preferring the id-based name would silently create a *new*,
 * empty branch and orphan the session's prior commits.
 */
export function resolveResumeBranchSlug(
  taskTitle: string,
  taskId: string | null | undefined,
  projectDir: string,
  prefix = 'feature',
): string {
  const current = deriveBranchSlug(taskTitle, taskId, prefix);
  if (!taskId) return current;
  const legacy = deriveBranchSlug(taskTitle, null, prefix);
  if (legacy === current) return current;
  // An 'unknown' probe on `current` must not be read as absent — that would
  // silently resume against the legacy branch (or worse, a fresh empty one)
  // and orphan the session's prior commits. Only a confirmed absence of
  // `current` combined with a confirmed existence of `legacy` migrates.
  if (
    probeBranchLocally(current, projectDir) === 'absent' &&
    probeBranchLocally(legacy, projectDir) === 'exists'
  ) {
    return legacy;
  }
  return current;
}

/**
 * Resolves the branching mode for a given project's milestone_branching setting:
 * 1. Explicit 'two_tier' or 'flat' wins.
 * 2. Falls back to two_tier when corporate mode is enabled.
 * 3. Otherwise flat.
 */
export function resolveBranchMode(
  milestoneBranching: 'two_tier' | 'flat' | null | undefined,
): BranchMode {
  if (milestoneBranching === 'two_tier') return 'two_tier';
  if (milestoneBranching === 'flat') return 'flat';
  return getCorporateMode().enabled ? 'two_tier' : 'flat';
}

/**
 * Resolves the git starting point (the ref the detached worktree will point at).
 *
 * Returns:
 *   - `feature/<milestone-slug>` for two_tier mode with a known milestone
 *   - project.baseBranch (default 'dev') for flat mode or when no milestoneId is provided
 */
export function resolveStartingPoint(
  project: {
    milestoneBranching?: 'two_tier' | 'flat' | null;
    baseBranch?: string;
  },
  milestoneId: string | null,
): { startingPoint: string; milestoneSlug: string | null } {
  const mode = resolveBranchMode(project.milestoneBranching);
  if (mode === 'two_tier' && milestoneId) {
    const milestone = ProjectService.getMilestone(milestoneId);
    if (milestone) {
      const slug = slugify(milestone.name);
      return { startingPoint: `feature/${slug}`, milestoneSlug: slug };
    }
  }
  return { startingPoint: project.baseBranch ?? 'dev', milestoneSlug: null };
}

/**
 * Ensures `feature/<milestoneSlug>` exists locally and on origin.
 * Creates it from origin/<baseBranch> when missing; no-ops when it already exists.
 * Only called in two_tier mode.
 */
export function ensureMilestoneBranch(
  milestoneSlug: string,
  projectDir: string,
  baseBranch = 'dev',
): void {
  const ref = `feature/${milestoneSlug}`;

  // Check if branch already exists locally.
  try {
    execSync(`git rev-parse --verify ${ref}`, {
      cwd: projectDir,
      stdio: 'pipe',
    });
    return; // already exists locally
  } catch {
    // not found locally — fall through
  }

  // Fetch origin to pick up any remote branch and latest base branch.
  try {
    execSync(`git fetch origin ${baseBranch}`, {
      cwd: projectDir,
      timeout: 30_000,
    });
  } catch {
    // non-fatal — proceed with local refs
  }

  // Check if branch exists on origin after fetch.
  try {
    execSync(`git rev-parse --verify origin/${ref}`, {
      cwd: projectDir,
      stdio: 'pipe',
    });
    // Exists on origin — create local tracking branch.
    execSync(`git branch ${ref} origin/${ref}`, { cwd: projectDir });
    return;
  } catch {
    // not on origin — create it from origin/<baseBranch>
  }

  execSync(`git branch ${ref} origin/${baseBranch}`, { cwd: projectDir });
  execSync(`git push origin ${ref}`, { cwd: projectDir });
}
