import { execSync } from 'child_process';
import { getCorporateMode } from '../config/corporateMode';
import { ProjectService } from '../projects/ProjectService';
import { slugify, deriveBranchSlug } from './branchSlug';

export type BranchMode = 'two_tier' | 'flat';

export { slugify, deriveBranchSlug };

/** True when `branch` exists as a local ref in `projectDir`. */
function branchExistsLocally(branch: string, projectDir: string): boolean {
  try {
    execSync(`git rev-parse --verify refs/heads/${branch}`, {
      cwd: projectDir,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
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
  if (
    !branchExistsLocally(current, projectDir) &&
    branchExistsLocally(legacy, projectDir)
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
