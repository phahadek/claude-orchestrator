import crypto from 'crypto';
import { execSync } from 'child_process';
import { runtimeSettings } from '../config';
import { ProjectService } from '../projects/ProjectService';

export type BranchMode = 'two_tier' | 'flat';

/** Returns the corporate-mode setting from runtimeSettings. */
function getCorporateMode(): { enabled: boolean } {
  return { enabled: runtimeSettings.corporate_mode_enabled };
}

/**
 * Converts a milestone name to a URL-friendly git branch slug.
 * Example: "M6 — Enterprise Adoption Readiness" → "m6-enterprise-adoption-readiness"
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const MAX_BRANCH_SLUG_LEN = 80;
const HASH_SUFFIX_LEN = 8;

/**
 * Derives a git branch name from a task title, capped at MAX_BRANCH_SLUG_LEN
 * chars (the part after the prefix slash) for Windows MAX_PATH safety.
 * When the slug exceeds the cap, a deterministic 8-char SHA1 suffix is appended
 * so retries for the same task always reproduce the same branch name.
 */
export function deriveBranchSlug(
  taskTitle: string,
  prefix = 'feature',
): string {
  const fullSlug = slugify(taskTitle);
  if (fullSlug.length <= MAX_BRANCH_SLUG_LEN) {
    return `${prefix}/${fullSlug}`;
  }
  const truncateAt = MAX_BRANCH_SLUG_LEN - HASH_SUFFIX_LEN - 1;
  let truncated = fullSlug.slice(0, truncateAt);
  // Trim at last word boundary to avoid cutting mid-word
  const lastDash = truncated.lastIndexOf('-');
  if (lastDash > 0) {
    truncated = truncated.slice(0, lastDash);
  }
  const hash = crypto
    .createHash('sha1')
    .update(fullSlug)
    .digest('hex')
    .slice(0, HASH_SUFFIX_LEN);
  return `${prefix}/${truncated}-${hash}`;
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
