import { minimatch } from 'minimatch';
import { PathGlob } from './playbookSchema';

/**
 * Whether any path in `diffPaths` (e.g. from `git diff --name-only
 * <deployed>..<target>`) matches any of `globs`. Shared by both a step's
 * `changed_paths` (should this conditional step run?) and a companion's
 * `trigger_paths` (does this companion likely need redeploying?) — same
 * question, same predicate, asked against a different glob list.
 */
export function matchesPathDiff(
  globs: PathGlob[],
  diffPaths: string[],
): boolean {
  if (globs.length === 0 || diffPaths.length === 0) {
    return false;
  }
  return diffPaths.some((diffPath) =>
    globs.some((glob) => minimatch(diffPath, glob, { dot: true })),
  );
}
