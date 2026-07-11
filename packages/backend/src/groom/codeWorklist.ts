/**
 * Parses a task's `## Files / paths affected` section (falling back to the
 * whole task body when the section is absent) into a deduped per-package
 * worklist of file paths, validated against the repo's tracked files so
 * prose that merely looks path-shaped (e.g. `try/except`) is dropped.
 *
 * Ported from the vendored scripts/groom-load.mjs — same token-extraction
 * and package-resolution rules, minus the git/Notion I/O (that lives in
 * groomLoad.ts).
 */

export interface WorklistTask {
  id: string;
  title: string;
  filesSection: string;
  rawMarkdown: string;
}

export interface CodeWorklistOptions {
  /** Repo-relative root all `packages` entries are relative to (e.g. "packages/backend/src"). */
  sourceRoot?: string;
  /** Registered package keys, relative to sourceRoot, longest-match-first resolution. */
  packages?: string[];
  /** Free-text phrase → package path, for tasks whose body describes an area without a literal path. */
  areaAliases?: Record<string, string>;
  /** `git ls-files` output for the repo — validates candidate paths and resolves bare filenames. */
  trackedFiles: string[];
}

interface FileIndex {
  tracked: Set<string>;
  byBasename: Map<string, string[]>;
}

function buildFileIndex(trackedFiles: string[]): FileIndex {
  const tracked = new Set(trackedFiles);
  const byBasename = new Map<string, string[]>();
  for (const p of trackedFiles) {
    const base = p.split('/').pop() ?? p;
    const list = byBasename.get(base);
    if (list) list.push(p);
    else byBasename.set(base, [p]);
  }
  return { tracked, byBasename };
}

/** True if a resolved package path corresponds to real tracked files (drops prose noise). */
function pkgHasFiles(fileIndex: FileIndex, pkgPath: string): boolean {
  for (const p of fileIndex.tracked) {
    if (p === pkgPath || p.startsWith(pkgPath + '/')) return true;
  }
  return false;
}

function cleanToken(tok: string): string {
  return tok
    .replace(/^[`*_~\s(]+/, '')
    .replace(/[`*_~\s).,;:]+$/, '')
    .replace(/\\/g, '/')
    .trim();
}

function extractCandidates(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const t = cleanToken(m[1]);
    if (t.includes('/') || /\.[a-z0-9]+$/i.test(t)) found.add(t);
  }
  for (const m of text.matchAll(
    /(?:^|[\s(`])([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)/g,
  )) {
    found.add(cleanToken(m[1]));
  }
  for (const m of text.matchAll(
    /(?:^|[\s(`])([A-Za-z0-9_-]+\.(?:py|sql|toml|ya?ml|json|md|sh|ts|tsx|js|jsx))\b/g,
  )) {
    found.add(cleanToken(m[1]));
  }
  return [...found].filter(Boolean);
}

function firstSegments(rel: string, n: number): string {
  return rel.split('/').slice(0, n).join('/');
}

/** Resolve a repo-relative-ish declared path to a coarse package path (repo-relative). */
function pathToPackage(
  rawPath: string,
  sourceRoot: string,
  packages: string[],
): string {
  const p = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (sourceRoot && p.startsWith(sourceRoot + '/')) {
    const rel = p.slice(sourceRoot.length + 1);
    const match = packages.find(
      (pkg) => rel === pkg || rel.startsWith(pkg + '/'),
    );
    return `${sourceRoot}/${match ?? firstSegments(rel, 1)}`;
  }
  if (sourceRoot && p === sourceRoot) return sourceRoot;
  const segs = p.split('/');
  return segs.length >= 2 ? firstSegments(p, 2) : segs[0];
}

function aliasPackages(
  text: string,
  areaAliases: Record<string, string>,
  sourceRoot: string,
): string[] {
  const out: string[] = [];
  const hay = text.toLowerCase();
  for (const [phrase, pkg] of Object.entries(areaAliases)) {
    if (hay.includes(phrase.toLowerCase())) {
      out.push(sourceRoot ? `${sourceRoot}/${pkg}` : pkg);
    }
  }
  return out;
}

function addPath(map: Map<string, Set<string>>, pkg: string, path?: string) {
  const set = map.get(pkg) ?? new Set<string>();
  if (path) set.add(path);
  map.set(pkg, set);
}

/**
 * Resolve candidate code references in a single task's scope text into
 * per-package deduped path sets. Bare filenames are resolved to their real
 * tracked path(s); tokens that resolve to nothing in the repo are dropped
 * (prose noise, not silently under-read — callers surface unresolved tasks
 * separately if they need that signal).
 */
function resolveTaskPackages(
  scope: string,
  aliasText: string,
  fileIndex: FileIndex,
  sourceRoot: string,
  packages: string[],
  areaAliases: Record<string, string>,
): Map<string, Set<string>> {
  const pkgFiles = new Map<string, Set<string>>();
  for (const tok of extractCandidates(scope)) {
    if (tok.includes('/')) {
      const pkg = pathToPackage(tok, sourceRoot, packages);
      if (pkgHasFiles(fileIndex, pkg)) addPath(pkgFiles, pkg, tok);
    } else if (/\.[a-z0-9]+$/i.test(tok)) {
      const matches = fileIndex.byBasename.get(tok) ?? [];
      for (const m of matches) {
        const pkg = pathToPackage(m, sourceRoot, packages);
        if (pkgHasFiles(fileIndex, pkg)) addPath(pkgFiles, pkg, m);
      }
    }
  }
  for (const a of aliasPackages(aliasText, areaAliases, sourceRoot)) {
    if (pkgHasFiles(fileIndex, a)) addPath(pkgFiles, a);
  }
  return pkgFiles;
}

/**
 * Build the deduped per-package code-exploration worklist across a set of
 * target tasks. Each package maps to a sorted, deduped list of the file
 * paths declared across all tasks that touch it.
 */
export function buildCodeWorklist(
  tasks: WorklistTask[],
  opts: CodeWorklistOptions,
): Map<string, string[]> {
  const sourceRoot = (opts.sourceRoot ?? '').replace(/\/+$/, '');
  const packages = [...(opts.packages ?? [])].sort(
    (a, b) => b.length - a.length,
  );
  const areaAliases = opts.areaAliases ?? {};
  const fileIndex = buildFileIndex(opts.trackedFiles);

  const merged = new Map<string, Set<string>>();
  for (const t of tasks) {
    const scope = t.filesSection || t.rawMarkdown;
    const perTask = resolveTaskPackages(
      scope,
      `${t.title}\n${t.filesSection}`,
      fileIndex,
      sourceRoot,
      packages,
      areaAliases,
    );
    for (const [pkg, paths] of perTask) {
      const set = merged.get(pkg) ?? new Set<string>();
      for (const p of paths) set.add(p);
      merged.set(pkg, set);
    }
  }

  const result = new Map<string, string[]>();
  for (const pkg of [...merged.keys()].sort()) {
    result.set(pkg, [...merged.get(pkg)!].sort());
  }
  return result;
}
