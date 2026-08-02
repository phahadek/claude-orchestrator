/**
 * Shared workflow-scope credential-ceiling denylist — paths no dispatched
 * session can ever land, since the auto-dispatch `GITHUB_TOKEN` deliberately
 * lacks the `workflow` OAuth scope (see `isWorkflowScopeDenied` in
 * `AgentSession.ts`, the reactive backstop this denylist lets every landing
 * site check *proactively* instead). Every check site — the code-session
 * push, the ops-session pre-staging decision — imports this single constant
 * rather than hand-rolling its own copy, so the ceiling can only ever be
 * widened or narrowed in one place.
 *
 * Reuses `matchesRegionGlob` from `groom/constraintCatalog.ts` (the same
 * `<prefix>/**` subtree-or-exact glob shape `appliesTo` entries use) rather
 * than inventing a second glob dialect.
 */

import { matchesRegionGlob } from '../groom/constraintCatalog';

/**
 * Region globs a dispatched session's landing action (git push, PR-creation
 * intent) can never carry, regardless of grant — the auto-dispatch PAT has
 * no `workflow` scope to push them with.
 */
export const WORKFLOW_SCOPE_DENYLIST: readonly string[] = [
  '.github/workflows/**',
];

/**
 * True when any of `paths` falls under the workflow-scope credential
 * ceiling. Used both by the code-session proactive push check (against a
 * branch diff's changed files) and the ops-session pre-staging check
 * (against the discovered fix's target path(s), as the session's own
 * investigation names them).
 */
export function matchesWorkflowScopeDenylist(paths: readonly string[]): boolean {
  return paths.some((path) =>
    WORKFLOW_SCOPE_DENYLIST.some((glob) => matchesRegionGlob(glob, path)),
  );
}
