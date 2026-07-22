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
  declared?: Set<string>,
): Map<string, Set<string>> {
  const pkgFiles = new Map<string, Set<string>>();
  for (const tok of extractCandidates(scope)) {
    if (tok.includes('/')) {
      const pkg = pathToPackage(tok, sourceRoot, packages);
      if (pkgHasFiles(fileIndex, pkg)) {
        addPath(pkgFiles, pkg, tok);
        declared?.add(tok);
      }
    } else if (/\.[a-z0-9]+$/i.test(tok)) {
      const matches = fileIndex.byBasename.get(tok) ?? [];
      if (matches.length) declared?.add(tok);
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
 * A declared-but-nonexistent path from a task's `## Files / paths affected`
 * section — greenfield code the task will create. Tagged distinct from
 * `packages`/`files` (which are validated against tracked files) so
 * consumers can render it honestly while still binding it, via `package`,
 * to the nearest real package for constraint/size/injection purposes.
 */
interface PlannedRegion {
  /** The declared path exactly as it appeared in the task's Files section. */
  path: string;
  /** Nearest existing ancestor directory with tracked files, or null if none resolves (e.g. a brand-new top-level area). */
  package: string | null;
}

export interface TaskRegions {
  /** Coarse package paths this task's declared scope resolves to. */
  packages: string[];
  /** Deduped, repo-validated tokens declared in the task's scope text (drives size_check.files). */
  files: string[];
  /** Declared paths from `## Files / paths affected` that don't exist yet — greenfield, not noise. */
  planned: PlannedRegion[];
}

/** Walk up `rawPath`'s ancestor directories to the nearest one with tracked files. */
function nearestExistingAncestor(
  rawPath: string,
  fileIndex: FileIndex,
): string | null {
  const segs = rawPath.split('/');
  segs.pop();
  while (segs.length > 0) {
    const candidate = segs.join('/');
    if (pkgHasFiles(fileIndex, candidate)) return candidate;
    segs.pop();
  }
  return null;
}

/**
 * Backtick-only counterpart to `extractCandidates` — a declared path in a
 * structured Files section is conventionally backtick-quoted (as every
 * fixture in this file's own tests shows). Since a planned region has no
 * tracked file to validate against (it doesn't exist yet, by definition),
 * this is the noise-guard for planned surfacing: it skips the bare,
 * unquoted path-shaped regex `extractCandidates` also matches, which is
 * exactly the prose false-positive (e.g. `try/except`) `pkgHasFiles`
 * exists to drop for resolved paths.
 */
function extractBacktickCandidates(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const t = cleanToken(m[1]);
    if (t.includes('/') || /\.[a-z0-9]+$/i.test(t)) found.add(t);
  }
  return [...found].filter(Boolean);
}

/**
 * Surfaces declared-but-nonexistent paths from the task's explicit
 * `## Files / paths affected` section as planned regions. Deliberately
 * scoped to `filesSection` only (never the `rawMarkdown` prose fallback) —
 * an explicit Files entry is a declaration of intent to create that path,
 * while a path-shaped token in free prose is exactly the noise
 * `pkgHasFiles` exists to drop.
 */
function resolvePlannedRegions(
  filesSection: string,
  fileIndex: FileIndex,
  alreadyDeclared: Set<string>,
): PlannedRegion[] {
  if (!filesSection) return [];
  const planned = new Map<string, PlannedRegion>();
  for (const tok of extractBacktickCandidates(filesSection)) {
    if (!tok.includes('/')) continue;
    if (alreadyDeclared.has(tok)) continue;
    if (planned.has(tok)) continue;
    planned.set(tok, {
      path: tok,
      package: nearestExistingAncestor(tok, fileIndex),
    });
  }
  return [...planned.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Per-task counterpart to `buildCodeWorklist` — resolves a single task's
 * declared scope into its own package set and validated file-token count,
 * without merging into the milestone-wide worklist. Ported from the vendored
 * scripts/groom-load.mjs's `resolveRegions` (its `declared` return), which
 * `buildCodeWorklist` never exposed per-task.
 */
export function resolveTaskRegions(
  task: WorklistTask,
  opts: CodeWorklistOptions,
): TaskRegions {
  const sourceRoot = (opts.sourceRoot ?? '').replace(/\/+$/, '');
  const packages = [...(opts.packages ?? [])].sort(
    (a, b) => b.length - a.length,
  );
  const areaAliases = opts.areaAliases ?? {};
  const fileIndex = buildFileIndex(opts.trackedFiles);

  const scope = task.filesSection || task.rawMarkdown;
  const declared = new Set<string>();
  const pkgFiles = resolveTaskPackages(
    scope,
    `${task.title}\n${task.filesSection}`,
    fileIndex,
    sourceRoot,
    packages,
    areaAliases,
    declared,
  );

  const planned = resolvePlannedRegions(task.filesSection, fileIndex, declared);

  return {
    packages: [...pkgFiles.keys()].sort(),
    files: [...declared].sort(),
    planned,
  };
}

/**
 * Regions a planned region binds via for downstream purposes — constraint
 * catalog intersection, selective architecture injection, size accounting.
 * A greenfield file legitimately inherits its nearest existing package's
 * constraints/injection, so planned entries fold into `packages` here; the
 * `planned` tag itself stays digest-only, never a binding exclusion.
 */
export function regionsForBinding(regions: TaskRegions): {
  packages: string[];
  files: string[];
} {
  const plannedPackages = regions.planned
    .map((p) => p.package)
    .filter((p): p is string => !!p);
  return {
    packages: [...new Set([...regions.packages, ...plannedPackages])].sort(),
    files: regions.files,
  };
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
