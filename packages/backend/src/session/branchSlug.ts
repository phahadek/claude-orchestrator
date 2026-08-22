import crypto from 'crypto';

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
 *
 * The suffix is derived from the full `taskId` (never truncated), not the
 * title — two tasks sharing a title must not collide on the disambiguating
 * suffix, since the suffix exists to disambiguate the very thing that
 * collides. When `taskId` is omitted, the suffix falls back to hashing the
 * title alone — this reproduces the pre-task-id derivation exactly, which is
 * what lets a branch created under the previous scheme still be located (see
 * `resolveResumeBranchSlug` in branchModel.ts).
 *
 * Kept in its own leaf module (no backend-internal imports besides `crypto`)
 * so `db/queries.ts` can re-derive a session's branch name — e.g. to match a
 * PR's head_branch back to the session that opened it — without pulling in
 * branchModel.ts's ProjectService/queries dependency chain and creating an
 * import cycle.
 */
export function deriveBranchSlug(
  taskTitle: string,
  taskId?: string | null,
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
    .update(taskId || fullSlug)
    .digest('hex')
    .slice(0, HASH_SUFFIX_LEN);
  return `${prefix}/${truncated}-${hash}`;
}
