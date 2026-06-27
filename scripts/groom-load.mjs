#!/usr/bin/env node
/**
 * groom-load.mjs — Deterministic Step-1 loader for the /groom skill.
 *
 * The Backlog Grooming procedure's Step 1 ("load full context") is the step
 * sessions most often skip or compress, because it is large and front-loaded.
 * This script does it deterministically so there is nothing left for the model
 * to shortcut: it fetches the fixed context pages + the target milestone board
 * (and neighbour boards) + every non-Done target task body, parses each task's
 * `## Files / paths affected` into a deduped per-package code-exploration
 * worklist, and computes git freshness for each package against the LOCAL
 * integration branch (default `dev`). It writes a cache the skill (and later
 * sessions) read instead of re-discovering.
 *
 * It REUSES the proven sibling scripts rather than re-implementing Notion REST:
 *   - notion-query.mjs  (paginated board query → JSON rows)
 *   - notion-page.mjs   (page body → clean Markdown)
 *
 * Usage:
 *   node groom-load.mjs --milestone M9 [options]
 *
 * Options:
 *   --milestone <id>     Required. Milestone key (registered in the manifest, or pass --board).
 *   --manifest <path>    Manifest JSON (explicit full path; overrides the central-tree default).
 *   --config-dir <path>  Central config tree root (overrides $ORCHESTRATOR_CONFIG_DIR).
 *   --project <key>      Project dir under config/projects/ (default: --repo basename).
 *   --repo <path>        Repo / project root for git + cache (default: cwd).
 *   --cache-dir <path>   Cache root (default: <repo>/.skill-cache/grooming/<milestone>).
 *   --env <path>         .env file with NOTION_API_KEY (passed through to sibling scripts).
 *   --board <id>         Board data-source id for an UNregistered milestone — run it now
 *                        without editing the manifest; prints the entry to persist.
 *   --refresh            Re-fetch context pages even if cached files already exist.
 *
 * Freshness model:
 *   Baseline = the LOCAL integration branch ref (manifest.integration_branch, default
 *   `dev`) — NOT origin/dev. Local dev only advances on a human `git pull`, so it is a
 *   frozen anchor for a grooming session's duration even while implementation sessions
 *   push to origin. A package is `fresh` when it has not changed between the SHA recorded
 *   on its cached digest and the current local baseline (and the working tree is clean
 *   for that path); otherwise `stale`; `missing` if never explored.
 *
 * Exit code is non-zero on any fetch failure, so the skill halts rather than
 * proceeding on a partial load.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ── Arg parsing (same idiom as the sibling scripts) ──────────────────
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}
function option(name) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

const milestone = option('--milestone');
const repo = resolve(process.cwd(), option('--repo') ?? '.');
const manifestPath = resolveManifestPath(repo);
const envPath = option('--env');
const boardOverride = option('--board');
const refresh = flag('--refresh');

// Resolve the grooming manifest from the central config tree (decoupled from the repo).
// Precedence: --manifest (explicit full path) > central tree (--config-dir / $ORCHESTRATOR_CONFIG_DIR)
// > host-aware default: a `config/` dir beside the projects root — dev `<repo>/../config`,
// prod `<repo>/../../config`. Keyed by --project (default: the repo basename).
function resolveManifestPath(repoRoot) {
  const explicit = option('--manifest');
  if (explicit) return resolve(process.cwd(), explicit);
  const projectKey = option('--project') ?? basename(repoRoot);
  const configDir = resolveConfigDir(repoRoot);
  if (!configDir) {
    fail(
      `could not locate the central config tree. Set $ORCHESTRATOR_CONFIG_DIR or pass --config-dir <path> ` +
        `(must contain a 'projects/' subdir), or pass --manifest <path> directly. Looked beside the projects ` +
        `root at ${resolve(repoRoot, '..', 'config')} and ${resolve(repoRoot, '..', '..', 'config')}.`,
    );
  }
  return join(configDir, 'projects', projectKey, 'grooming.json');
}
function resolveConfigDir(repoRoot) {
  const explicit =
    option('--config-dir') ?? process.env.ORCHESTRATOR_CONFIG_DIR;
  if (explicit) return resolve(process.cwd(), explicit);
  for (const c of [
    resolve(repoRoot, '..', 'config'),
    resolve(repoRoot, '..', '..', 'config'),
  ]) {
    if (existsSync(join(c, 'projects'))) return c;
  }
  return null;
}

if (!milestone) {
  console.error('Usage: node groom-load.mjs --milestone <id> [options]');
  console.error('Run with no args to see full help at the top of the script.');
  process.exit(1);
}

function fail(msg) {
  console.error(`groom-load: ${msg}`);
  process.exit(1);
}

// ── Manifest ─────────────────────────────────────────────────────────
if (!existsSync(manifestPath))
  fail(
    `manifest not found at ${manifestPath} (create it in the central config tree — see ~/.claude/skills/groom/reference/manifest.example.json).`,
  );
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  fail(`manifest is not valid JSON: ${e.message}`);
}

// Suggest the immediately-prior registered milestone by trailing integer (M12 → M11),
// to auto-fill a new milestone's neighbour. Returns {id, board} or null.
function suggestPriorMilestone(key, registered) {
  const m = /^(.*?)(\d+)$/.exec(key);
  if (!m) return null;
  const [, prefix, numStr] = m;
  for (let n = parseInt(numStr, 10) - 1; n >= 0; n--) {
    const cand = `${prefix}${n}`;
    if (registered[cand]?.board)
      return { id: cand, board: registered[cand].board };
  }
  return null;
}

// Resolve the milestone. A new milestone board is a routine event, so an unregistered
// milestone is handled gracefully rather than dead-ending: either run it now via
// `--board <data-source-id>` (neighbour auto-set to the prior registered milestone), or
// fail with a copy-pasteable manifest entry so registering it is a paste, not a hunt.
const registeredMilestones = manifest.milestones ?? {};
let milestoneCfg = registeredMilestones[milestone];
let unregisteredNote = null; // set when running an unregistered milestone via --board
if (!milestoneCfg) {
  const prior = suggestPriorMilestone(milestone, registeredMilestones);
  const neighboursJson = prior
    ? `[{ "id": "${prior.id}", "board": "${prior.board}" }]`
    : '[]';
  if (boardOverride) {
    milestoneCfg = {
      board: boardOverride,
      neighbours: prior ? [{ id: prior.id, board: prior.board }] : [],
    };
    unregisteredNote = `"${milestone}": { "board": "${boardOverride}", "neighbours": ${neighboursJson} }`;
    console.error(
      `groom-load: ⚠ milestone "${milestone}" is not registered in ${manifestPath} — running with ` +
        `--board ${boardOverride} (neighbour: ${prior ? prior.id : 'none'}). Persist it via the snippet printed at the end.`,
    );
  } else {
    fail(
      `milestone "${milestone}" is not registered in ${manifestPath} ` +
        `(registered: ${Object.keys(registeredMilestones).join(', ') || 'none'}).\n` +
        `A new milestone board is routine — do one of:\n` +
        `  • add this entry under "milestones" (board id = the data-source id in the board's Notion URL / context.md):\n` +
        `      "${milestone}": { "board": "<board-data-source-id>", "neighbours": ${neighboursJson} }\n` +
        `  • or run now without editing the manifest: re-run with --board <board-data-source-id> ` +
        `(auto-neighbour ${prior ? prior.id : 'none'}; prints the entry to persist).`,
    );
  }
}

const sourceRoot = (manifest.source_root ?? '').replace(/\/+$/, '');
const integrationBranch = manifest.integration_branch ?? 'dev';
const statusProp = manifest.status_property ?? 'Status';
const vocab = manifest.status_vocab ?? {};
const doneStatuses = new Set([vocab.done, vocab.deferred].filter(Boolean));
// Manifest packages: longest-match keys, relative to source_root. Drop $comment-ish keys.
const packages = (manifest.packages ?? [])
  .filter((p) => typeof p === 'string')
  .sort((a, b) => b.length - a.length);
const areaAliases = Object.fromEntries(
  Object.entries(manifest.area_aliases ?? {}).filter(
    ([k]) => !k.startsWith('$'),
  ),
);

const cacheDir = resolve(
  repo,
  option('--cache-dir') ?? join('.skill-cache', 'grooming', milestone),
);
const contextDir = join(cacheDir, 'context');
const tasksDir = join(cacheDir, 'tasks');
for (const d of [cacheDir, contextDir, tasksDir])
  mkdirSync(d, { recursive: true });

// ── git helpers (read-only, run inside the repo; never mutate a branch) ──
function git(argv) {
  const r = spawnSync('git', argv, { cwd: repo, encoding: 'utf8' });
  return {
    status: r.status,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}
const baselineRev = git([
  'rev-parse',
  '--verify',
  '--quiet',
  integrationBranch,
]);
if (baselineRev.status !== 0 || !baselineRev.stdout) {
  fail(
    `could not resolve local integration branch "${integrationBranch}" in ${repo}. Is it checked out / does the local ref exist? (freshness roots on the LOCAL ref, not origin.)`,
  );
}
const baselineSha = baselineRev.stdout;

// ── repo file index (resolves bare filenames + validates declared paths) ──
function buildFileIndex() {
  const r = git(['ls-files']);
  const paths = r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  const tracked = new Set(paths);
  const byBasename = new Map();
  for (const p of paths) {
    const base = p.split('/').pop();
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(p);
  }
  return { tracked, byBasename };
}
const fileIndex = buildFileIndex();
/** True if a resolved package path corresponds to real tracked files (drops prose noise). */
function pkgHasFiles(pkgPath) {
  for (const p of fileIndex.tracked)
    if (p === pkgPath || p.startsWith(pkgPath + '/')) return true;
  return false;
}

/** Freshness of a repo-relative path vs the cached SHA. */
function freshnessFor(pkgPath, priorSha) {
  if (!priorSha) return 'missing';
  // status 0 = no diff between priorSha and baseline for this path; 1 = differs; >1 = error
  const diff = git(['diff', '--quiet', priorSha, baselineSha, '--', pkgPath]);
  if (diff.status === 1) return 'stale';
  if (diff.status !== 0) return 'stale'; // unknown ref / error → re-explore to be safe
  const dirty = git(['status', '--porcelain', '--', pkgPath]);
  return dirty.stdout ? 'stale' : 'fresh';
}

// ── sibling-script orchestration ─────────────────────────────────────
function runScript(name, scriptArgs) {
  const scriptPath = join(SCRIPT_DIR, name);
  const passthru = envPath ? ['--env', envPath] : [];
  const r = spawnSync('node', [scriptPath, ...scriptArgs, ...passthru], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    fail(
      `${name} ${scriptArgs.join(' ')} failed (exit ${r.status}):\n${(r.stderr ?? '').trim() || (r.stdout ?? '').trim()}`,
    );
  }
  return r.stdout ?? '';
}

function queryBoard(boardId) {
  const out = runScript('notion-query.mjs', [boardId, '--json']);
  try {
    return JSON.parse(out);
  } catch (e) {
    fail(
      `could not parse notion-query.mjs JSON for board ${boardId}: ${e.message}`,
    );
  }
}

function fetchPageMarkdown(pageId) {
  return runScript('notion-page.mjs', [pageId, '--format', 'md']);
}

// ── task body parsing: `## Files / paths affected` → packages ────────
function extractFilesSection(md) {
  const lines = md.split('\n');
  const headRe = /^#{1,4}\s+.*files\s*\/\s*paths?\s*affected/i;
  const anyHead = /^#{1,4}\s+/;
  let i = lines.findIndex((l) => headRe.test(l));
  if (i === -1) return '';
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (anyHead.test(lines[j])) break;
    body.push(lines[j]);
  }
  return body.join('\n');
}

function cleanToken(tok) {
  return tok
    .replace(/^[`*_~\s(]+/, '')
    .replace(/[`*_~\s).,;:]+$/, '')
    .replace(/\\/g, '/')
    .trim();
}

function extractCandidates(text) {
  const found = new Set();
  // backtick-wrapped tokens: keep paths and bare filenames-with-extension
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const t = cleanToken(m[1]);
    if (t.includes('/') || /\.[a-z0-9]+$/i.test(t)) found.add(t);
  }
  // bare slash tokens anywhere (validated against the repo later)
  for (const m of text.matchAll(
    /(?:^|[\s(`])([A-Za-z0-9_.\-]+\/[A-Za-z0-9_./\-]+)/g,
  )) {
    found.add(cleanToken(m[1]));
  }
  // bare filenames with a code-ish extension (resolved via the file index)
  for (const m of text.matchAll(
    /(?:^|[\s(`])([A-Za-z0-9_\-]+\.(?:py|sql|toml|ya?ml|json|md|sh))\b/g,
  )) {
    found.add(cleanToken(m[1]));
  }
  return [...found].filter(Boolean);
}

function firstSegments(rel, n) {
  return rel.split('/').slice(0, n).join('/');
}

/** Resolve a repo-relative-ish declared path to a coarse package path (repo-relative). */
function pathToPackage(rawPath) {
  let p = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (sourceRoot && p.startsWith(sourceRoot + '/')) {
    const rel = p.slice(sourceRoot.length + 1);
    const match = packages.find(
      (pkg) => rel === pkg || rel.startsWith(pkg + '/'),
    );
    return `${sourceRoot}/${match ?? firstSegments(rel, 1)}`;
  }
  if (sourceRoot && p === sourceRoot) return sourceRoot;
  // Outside source_root (migrations/, tests/, docs/, config/ …): key by first 1–2 segments.
  const segs = p.split('/');
  return segs.length >= 2 ? firstSegments(p, 2) : segs[0];
}

function aliasPackages(text) {
  const out = [];
  const hay = text.toLowerCase();
  for (const [phrase, pkg] of Object.entries(areaAliases)) {
    if (typeof pkg === 'string' && hay.includes(phrase.toLowerCase())) {
      out.push(sourceRoot ? `${sourceRoot}/${pkg}` : pkg);
    }
  }
  return out;
}

/**
 * Resolve candidate code references in `scope` to validated packages.
 * Every package is checked against the repo file index, so prose that merely
 * looks path-shaped (e.g. `try/except`) is dropped. Bare filenames are resolved
 * to their real path(s) via the index. Identifier/symbol-only references that
 * resolve to nothing are left for the skill's judgment pass (they surface as an
 * unresolved Backlog task, not a silent under-read).
 */
function resolveRegions(scope, aliasText) {
  const pkgs = new Set();
  const kept = new Set();
  for (const tok of extractCandidates(scope)) {
    if (tok.includes('/')) {
      const pkg = pathToPackage(tok);
      if (pkgHasFiles(pkg)) {
        pkgs.add(pkg);
        kept.add(tok);
      }
    } else if (/\.[a-z0-9]+$/i.test(tok)) {
      const matches = fileIndex.byBasename.get(tok) ?? [];
      if (matches.length) {
        kept.add(tok);
        for (const m of matches) {
          const pkg = pathToPackage(m);
          if (pkgHasFiles(pkg)) pkgs.add(pkg);
        }
      }
    }
  }
  for (const a of aliasPackages(aliasText)) if (pkgHasFiles(a)) pkgs.add(a);
  return { packages: [...pkgs], declared: [...kept] };
}

// ── load existing cache (code-map for freshness, grooming-state to preserve) ──
function readJson(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}
const codeMap = readJson(join(cacheDir, 'code-map.json'), {}); // skill-owned; loader only reads
const priorState = readJson(join(cacheDir, 'grooming-state.json'), {});

// ── main ─────────────────────────────────────────────────────────────
const titleOf = (row) =>
  row._title ?? row['Task Name'] ?? row['Name'] ?? '(untitled)';

const targetRows = queryBoard(milestoneCfg.board);

const targetTasks = [];
const pkgMap = {}; // pkgPath → Set(taskId)
const unresolved = [];

for (const row of targetRows) {
  const status = row[statusProp] ?? '';
  if (doneStatuses.has(status)) continue;

  const slug = row.id.replace(/-/g, '');
  const bodyFileRel = join('tasks', `${slug}.md`);
  const bodyPath = join(cacheDir, bodyFileRel);

  const md = fetchPageMarkdown(row.id);
  writeFileSync(bodyPath, md, 'utf8');

  // Prefer the dedicated section; fall back to the whole body (the section is
  // frequently absent in real tasks). Validation against the repo keeps the
  // wider scope from picking up prose noise.
  const section = extractFilesSection(md);
  const scope = section || md;
  const { packages: pkgList, declared } = resolveRegions(
    scope,
    `${titleOf(row)}\n${section}`,
  );
  const isBacklog = status === vocab.backlog;

  if (isBacklog && pkgList.length === 0) {
    unresolved.push({
      id: row.id,
      title: titleOf(row),
      reason:
        'no resolvable `Files / paths affected` and no area-alias hit — needs manual scoping',
    });
  }
  for (const pkg of pkgList) {
    (pkgMap[pkg] ??= new Set()).add(row.id);
  }

  targetTasks.push({
    id: row.id,
    title: titleOf(row),
    status,
    priority: row['Priority'] ?? '',
    type: row['Type'] ?? '',
    depends_on: row['Depends On'] ?? '',
    url: row.url,
    body_file: bodyFileRel.replace(/\\/g, '/'),
    files_paths: declared,
    packages: pkgList,
    unresolved: isBacklog && pkgList.length === 0,
  });
}

// neighbour boards: context-only (names + statuses), no bodies in v1
const neighbours = [];
for (const n of milestoneCfg.neighbours ?? []) {
  const rows = queryBoard(n.board);
  neighbours.push({
    id: n.id,
    board: n.board,
    tasks: rows
      .filter((r) => !doneStatuses.has(r[statusProp] ?? ''))
      .map((r) => ({
        id: r.id,
        title: titleOf(r),
        status: r[statusProp] ?? '',
      })),
  });
}

// context pages: fetch (cache by file existence unless --refresh)
const contextPages = [];
for (const pg of manifest.context_pages ?? []) {
  const slug = pg.id.replace(/-/g, '');
  const fileRel = join('context', `${slug}.md`);
  const filePath = join(cacheDir, fileRel);
  let fetched = false;
  if (refresh || !existsSync(filePath)) {
    writeFileSync(filePath, fetchPageMarkdown(pg.id), 'utf8');
    fetched = true;
  }
  contextPages.push({
    id: pg.id,
    title: pg.title ?? '',
    file: fileRel.replace(/\\/g, '/'),
    refetched: fetched,
  });
}

// worklist with freshness
const worklistPackages = {};
let nFresh = 0,
  nStale = 0,
  nMissing = 0;
for (const [pkg, taskSet] of Object.entries(pkgMap).sort()) {
  const prior = codeMap[pkg]?.head_sha ?? null;
  const freshness = freshnessFor(pkg, prior);
  if (freshness === 'fresh') nFresh++;
  else if (freshness === 'stale') nStale++;
  else nMissing++;
  worklistPackages[pkg] = {
    tasks: [...taskSet],
    freshness,
    prior_sha: prior,
    baseline_sha: baselineSha,
  };
}

// grooming-state.json: rebuild against the LIVE board each run so stale entries
// can't survive a resume. Three guarantees:
//   1. Seed a fresh skeleton for every Backlog task that has no prior entry.
//   2. Carry forward human-entered fields for tasks still present, but ALWAYS
//      refresh `status` (and `title`) from the live board — not only at Backlog,
//      so a task that moved past Backlog can't keep a stale recorded status.
//   3. PRUNE any prior entry whose task is no longer a live non-done target
//      (completed / deferred / removed since the last groom). Done + Deferred
//      rows were already dropped from `targetTasks` above, so building `state`
//      from `targetTasks` alone — rather than spreading `priorState` — is the
//      prune. Without it, a task done since the last groom kept its old recorded
//      status and a resumed session read it as still Backlog.
const state = {};
for (const t of targetTasks) {
  const prior = priorState[t.id];
  if (!prior) {
    // No prior entry: only Backlog tasks need a skeleton (the ones grooming acts
    // on). A live non-Backlog task gets none until it returns to Backlog.
    if (t.status !== vocab.backlog) continue;
    state[t.id] = {
      title: t.title,
      status: t.status,
      achieves: null,
      open_questions: null,
      tests: null,
      manual: null,
      regions: t.packages,
      hard_block_deps: null,
      size_check: null,
      signoff: null,
    };
  } else {
    state[t.id] = { ...prior }; // keep human-entered fields (signoff, achieves, …)
    state[t.id].title = t.title; // refresh — tasks get renamed during grooming
    state[t.id].status = t.status; // ALWAYS refresh from the live board
    state[t.id].regions = Array.from(
      new Set([...(prior.regions ?? []), ...t.packages]),
    );
    if (!('hard_block_deps' in state[t.id])) state[t.id].hard_block_deps = null; // back-compat
    if (!('size_check' in state[t.id])) state[t.id].size_check = null; // back-compat
  }
}
const prunedStateIds = Object.keys(priorState).filter((id) => !(id in state));

// ── emit ─────────────────────────────────────────────────────────────
const bundle = {
  generated: {
    milestone,
    integration_branch: integrationBranch,
    baseline_sha: baselineSha,
    repo,
  },
  context_pages: contextPages,
  boards: {
    target: { milestone, board: milestoneCfg.board, tasks: targetTasks },
    neighbours,
  },
};
const worklist = {
  milestone,
  integration_branch: integrationBranch,
  baseline_sha: baselineSha,
  packages: worklistPackages,
  unresolved_tasks: unresolved,
};

writeFileSync(
  join(cacheDir, 'context-bundle.json'),
  JSON.stringify(bundle, null, 2),
  'utf8',
);
writeFileSync(
  join(cacheDir, 'worklist.json'),
  JSON.stringify(worklist, null, 2),
  'utf8',
);
writeFileSync(
  join(cacheDir, 'grooming-state.json'),
  JSON.stringify(state, null, 2),
  'utf8',
);

// ── summary ──────────────────────────────────────────────────────────
const backlog = targetTasks.filter((t) => t.status === vocab.backlog);
const other = targetTasks.length - backlog.length;
console.log(`groom-load: milestone ${milestone} loaded into ${cacheDir}`);
console.log(
  `  baseline: ${integrationBranch} @ ${baselineSha.slice(0, 10)} (local)`,
);
console.log(
  `  context pages: ${contextPages.length} (${contextPages.filter((p) => p.refetched).length} fetched, rest cached)`,
);
console.log(
  `  target tasks: ${targetTasks.length} non-done (${backlog.length} 🔲 Backlog need grooming, ${other} other = context)`,
);
console.log(`  neighbour boards: ${neighbours.length} (context-only)`);
console.log(
  `  code-exploration packages: ${Object.keys(worklistPackages).length} (${nFresh} fresh / ${nStale} stale / ${nMissing} missing → explore stale+missing)`,
);
if (unresolved.length) {
  console.log(
    `  ⚠ ${unresolved.length} Backlog task(s) with no resolvable code region (manual scoping needed):`,
  );
  for (const u of unresolved) console.log(`     - ${u.title}`);
}
if (prunedStateIds.length) {
  console.log(
    `  pruned ${prunedStateIds.length} stale grooming-state entr${prunedStateIds.length === 1 ? 'y' : 'ies'} (task completed/deferred/removed since last groom)`,
  );
}
if (unregisteredNote) {
  console.log(
    `  ⚠ milestone ${milestone} ran UNREGISTERED (via --board). To persist it, add under "milestones" in the manifest:\n      ${unregisteredNote}`,
  );
}
console.log(
  'Next: the /groom skill explores stale+missing packages (Explore subagents), writes code-map.json, then presents Backlog in batches.',
);
