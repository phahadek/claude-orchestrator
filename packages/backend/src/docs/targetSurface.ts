/**
 * Classifies a Docs task's declared Target surface (see skills/docs/SKILL.md
 * § "Docs task-body convention") as a repo-file path or a Notion page
 * reference. Shared by dispatch/prompt-assembly code — sessionPredicates.ts's
 * `usesWorktree` and planning/procedureAssembler.ts's skeleton/digest
 * renderers — so they branch on one definition instead of re-deriving the
 * same pattern match independently.
 */

const NOTION_PAGE_ID_RE = /^[0-9a-f]{32}$/i;
const NOTION_PAGE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when a declared Target surface is a repo file path rather than a
 * Notion page id/URL. An empty/undeclared surface is NOT a repo-file
 * surface — callers must keep treating that as "stop and ask", not silently
 * default to the direct-PR path.
 */
export function isRepoFileTargetSurface(targetSurface: string): boolean {
  const trimmed = targetSurface.trim();
  if (!trimmed) return false;
  if (/notion\.so/i.test(trimmed)) return false;
  if (NOTION_PAGE_ID_RE.test(trimmed) || NOTION_PAGE_UUID_RE.test(trimmed)) {
    return false;
  }
  return true;
}
