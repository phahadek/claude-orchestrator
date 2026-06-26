#!/usr/bin/env node
/**
 * design-load.mjs — Deterministic Step-1 loader for the /design skill.
 *
 * Sister to groom-load.mjs. Where grooming brings 🔲 Backlog tasks to 🗂️ Ready,
 * /design executes 📐 Design and 📋 Planning tasks (at Ready / In Progress) to lock specs, file
 * follow-on 🔲 Backlog Code tasks, and update architecture pages. This loader
 * does the deterministic part of /design's Step 1: fetches the fixed context
 * pages + the target milestone board (and neighbour boards) + every non-Done
 * task body, parses each into a per-task structure (open questions,
 * pages affected, dep status, theme tags), and writes a cache the skill (and
 * later sessions) read instead of re-discovering.
 *
 * It REUSES the proven sibling scripts rather than re-implementing Notion REST:
 *   - notion-query.mjs  (paginated board query → JSON rows)
 *   - notion-page.mjs   (page body → clean Markdown)
 *
 * Usage:
 *   node design-load.mjs --milestone M9 [options]
 *
 * Options:
 *   --milestone <id>     Required. Milestone key present in the manifest (e.g. M9).
 *   --manifest <path>    Manifest JSON (explicit full path; overrides the central-tree default).
 *   --config-dir <path>  Central config tree root (overrides $ORCHESTRATOR_CONFIG_DIR).
 *   --project <key>      Project dir under config/projects/ (default: --repo basename).
 *   --repo <path>        Repo / project root for cache (default: cwd). Shared manifest with /groom.
 *   --cache-dir <path>   Cache root (default: <repo>/.skill-cache/design/<milestone>).
 *   --env <path>         .env file with NOTION_API_KEY (passed through to sibling scripts).
 *   --refresh            Re-fetch context pages even if cached files already exist.
 *
 * Status classification (status_vocab from the manifest):
 *   - Ready / In Progress  → executable (skill walks these one open-question at a time)
 *   - Backlog              → needs-grooming (skill refuses; user must /groom first)
 *   - In Review            → closed-not-done (context only)
 *   - Done                 → context only (used for dep status resolution; not surfaced)
 *   - Deferred             → equivalent to Done — scope superseded by another task;
 *                            not surfaced, satisfied for dep purposes (see anti-patterns).
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
function flag(name) { const i = args.indexOf(name); if (i === -1) return false; args.splice(i, 1); return true; }
function option(name) { const i = args.indexOf(name); if (i === -1 || i + 1 >= args.length) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; }

const milestone = option('--milestone');
const repo = resolve(process.cwd(), option('--repo') ?? '.');
const manifestPath = resolveManifestPath(repo);
const envPath = option('--env');
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
  const explicit = option('--config-dir') ?? process.env.ORCHESTRATOR_CONFIG_DIR;
  if (explicit) return resolve(process.cwd(), explicit);
  for (const c of [resolve(repoRoot, '..', 'config'), resolve(repoRoot, '..', '..', 'config')]) {
    if (existsSync(join(c, 'projects'))) return c;
  }
  return null;
}

if (!milestone) {
  console.error('Usage: node design-load.mjs --milestone <id> [options]');
  console.error('Run with no args to see full help at the top of the script.');
  process.exit(1);
}

function fail(msg) { console.error(`design-load: ${msg}`); process.exit(1); }

// ── Manifest ─────────────────────────────────────────────────────────
if (!existsSync(manifestPath)) fail(`manifest not found at ${manifestPath} (the /design skill shares the grooming manifest with /groom — create it in the central config tree; see ~/.claude/skills/groom/reference/manifest.example.json).`);
let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
catch (e) { fail(`manifest is not valid JSON: ${e.message}`); }

const milestoneCfg = manifest.milestones?.[milestone];
if (!milestoneCfg) fail(`milestone "${milestone}" is not defined in ${manifestPath} (milestones: ${Object.keys(manifest.milestones ?? {}).join(', ') || 'none'}).`);

const statusProp = manifest.status_property ?? 'Status';
const vocab = manifest.status_vocab ?? {};
const sourceRoot = (manifest.source_root ?? '').replace(/\/+$/, '');
const packages = (manifest.packages ?? []).filter(p => typeof p === 'string').sort((a, b) => b.length - a.length);
const contextPagesCfg = (manifest.context_pages ?? []).filter(p => p && typeof p.id === 'string');

// The /design skill targets Type = "📐 Design" AND Type = "📋 Planning". Both
// share the same workflow shape: open questions → locked decisions → follow-on
// 🔲 Backlog tasks + (sometimes) architecture-page edits. The matcher is tolerant
// of the emoji being stripped — match on "design" or "planning" (case-insensitive).
const designTypeMatcher = (t) => typeof t === 'string' && /design|planning/i.test(t);

const cacheDir = resolve(repo, option('--cache-dir') ?? join('.skill-cache', 'design', milestone));
const contextDir = join(cacheDir, 'context');
const tasksDir = join(cacheDir, 'tasks');
for (const d of [cacheDir, contextDir, tasksDir]) mkdirSync(d, { recursive: true });

// ── sibling-script orchestration ─────────────────────────────────────
function runScript(name, scriptArgs) {
  const scriptPath = join(SCRIPT_DIR, name);
  const passthru = envPath ? ['--env', envPath] : [];
  const r = spawnSync('node', [scriptPath, ...scriptArgs, ...passthru], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    fail(`${name} ${scriptArgs.join(' ')} failed (exit ${r.status}):\n${(r.stderr ?? '').trim() || (r.stdout ?? '').trim()}`);
  }
  return r.stdout ?? '';
}

function queryBoard(boardId) {
  const out = runScript('notion-query.mjs', [boardId, '--json']);
  try { return JSON.parse(out); }
  catch (e) { fail(`could not parse notion-query.mjs JSON for board ${boardId}: ${e.message}`); }
}

function fetchPageMarkdown(pageId) {
  return runScript('notion-page.mjs', [pageId, '--format', 'md']);
}

// ── parsing helpers ──────────────────────────────────────────────────
// Matches both full Notion UUIDs (32 hex, optionally dashed) and the truncated
// 16-hex prefix form ("38522f91-52f3-81dd") that task bodies sometimes use.
// Resolution against depMap is prefix-aware (see resolveDep below).
const NOTION_ID_RE = /\b([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})(?:-?([0-9a-f]{4}))?(?:-?([0-9a-f]{12}))?\b/gi;
function normaliseId(id) { return id.replace(/-/g, '').toLowerCase(); }

/** Extract the body between a heading matching `headRe` and the next heading. */
function sectionBody(md, headRe) {
  const lines = md.split('\n');
  const anyHead = /^#{1,4}\s+/;
  const i = lines.findIndex(l => headRe.test(l));
  if (i === -1) return '';
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (anyHead.test(lines[j])) break;
    body.push(lines[j]);
  }
  return body.join('\n');
}

/** Extract top-level bullet items from a chunk of markdown.
 *  Top-level = no leading indent (sub-bullets stay attached to their parent). */
function topLevelBullets(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const out = [];
  let current = null;
  const bulletRe = /^(?:[-*+]|\d+\.)\s+(.*)$/;
  const indentedRe = /^\s+\S/;
  for (const line of lines) {
    const m = bulletRe.exec(line);
    if (m && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (current !== null) out.push(current.trim());
      current = m[1];
    } else if (current !== null && indentedRe.test(line)) {
      current += '\n' + line;
    } else if (current !== null && line.trim() === '') {
      // blank line — keep accumulating; closes only on next non-indented non-bullet
    } else if (current !== null && line.trim() !== '' && !bulletRe.test(line)) {
      // a non-bullet, non-indented line — close the current bullet
      out.push(current.trim());
      current = null;
    }
  }
  if (current !== null) out.push(current.trim());
  return out.filter(Boolean);
}

/**
 * Extract the "Open questions" list from a Design task body. Tolerant of:
 *   - `### Open questions to resolve during design`
 *   - `### Open questions`, `## Open questions:`
 *   - Inline `Decide:` followed by a bullet list (the older convention)
 *   - As a last resort: bullets under the `## Context` section
 * Returns the bullet text per question, verbatim (markdown preserved).
 */
function extractOpenQuestions(md) {
  const variants = [
    // "Open questions" / "Questions" / "Questions to resolve during design" / etc.
    /^#{1,4}\s+(?:open\s+)?questions?(?:\s+to\s+resolve.*)?:?\s*$/i,
    // "Design questions" / "Design questions to settle"
    /^#{1,4}\s+design\s+questions?(?:\s+to\s+settle.*)?:?\s*$/i,
    // "Decide" / "Decisions" / "Decisions to lock" / "Decision space (to lock)" / etc.
    /^#{1,4}\s+(?:decide|decisions?(?:\s+to\s+lock|\s+space(?:\s*\(.*\))?)?)(?:\s*\(.*\))?:?\s*$/i,
  ];
  for (const re of variants) {
    const body = sectionBody(md, re);
    if (body.trim()) {
      const bullets = topLevelBullets(body);
      if (bullets.length) return { items: bullets, source: 'explicit_heading' };
    }
  }
  // "Decide:" convention — find a line containing only "Decide:" or "Decide the following:"
  // and capture the following bullet block.
  const lines = md.split('\n');
  const decideIdx = lines.findIndex(l => /^\s*decide(?:\s+the\s+following)?\s*:?\s*$/i.test(l));
  if (decideIdx !== -1) {
    const tail = lines.slice(decideIdx + 1).join('\n');
    // stop at the next heading
    const headIdx = tail.split('\n').findIndex(l => /^#{1,4}\s+/.test(l));
    const block = headIdx === -1 ? tail : tail.split('\n').slice(0, headIdx).join('\n');
    const bullets = topLevelBullets(block);
    if (bullets.length) return { items: bullets, source: 'decide_block' };
  }
  return { items: [], source: 'none' };
}

/**
 * Extract the "Notion pages affected" list from a Design task body. Each item is
 * the human-readable page title with its annotation (e.g. "*(new)*",
 * "*(update — Section X)*") preserved.
 */
function extractPagesAffected(md) {
  const headRe = /^#{1,4}\s+notion\s+pages?\s+affected/i;
  const body = sectionBody(md, headRe);
  if (!body.trim()) return [];
  return topLevelBullets(body).map(raw => {
    // Strip leading bold/code/italic markers from the title; keep the rest.
    const trimmed = raw.replace(/^[*`_]+/, '').trim();
    // Title is everything up to the first ' — ' or ' - ' or ' *(' (annotation).
    const sepMatch = trimmed.match(/(.+?)\s*(?:—|–|-|\*\()/);
    const title = sepMatch ? sepMatch[1].trim() : trimmed;
    return { title, raw };
  });
}

/** Try to resolve a page title to a Notion page_id via manifest.context_pages. */
function resolvePageId(title) {
  const want = title.replace(/\s+/g, ' ').toLowerCase().trim();
  for (const p of contextPagesCfg) {
    const t = (p.title ?? '').replace(/\s+/g, ' ').toLowerCase().trim();
    if (t && (t === want || want.includes(t) || t.includes(want))) return p.id;
  }
  return null;
}

/** Extract notion IDs (full UUIDs or 16-hex prefixes) from a depends_on string. */
function extractDepIds(depsStr) {
  if (!depsStr || typeof depsStr !== 'string') return [];
  const out = new Set();
  for (const m of depsStr.matchAll(NOTION_ID_RE)) {
    const norm = [m[1], m[2], m[3], m[4], m[5]].filter(Boolean).join('').toLowerCase();
    if (norm.length >= 16) out.add(norm);
  }
  return [...out];
}

/** Look up a dep id in depMap, allowing prefix-match for truncated IDs. */
function resolveDep(idOrPrefix) {
  if (depMap.has(idOrPrefix)) return depMap.get(idOrPrefix);
  if (idOrPrefix.length < 32) {
    for (const [k, v] of depMap) if (k.startsWith(idOrPrefix)) return v;
  }
  return null;
}

/** Heuristic theme tags from the body: package paths + arch-page references.
 *  Path tokens may be backtick-wrapped or bare; they may be absolute (under
 *  source_root) or source_root-relative ("ingestion/rest/foo.py"). All forms
 *  resolve to the same package via the manifest's `packages` list (longest match). */
function extractThemeTags(md) {
  const tags = new Set();
  function tagPath(tok) {
    const cleaned = tok.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (!cleaned.includes('/')) return;
    let rel = null;
    if (sourceRoot && cleaned.startsWith(sourceRoot + '/')) rel = cleaned.slice(sourceRoot.length + 1);
    else rel = cleaned;
    const pkg = packages.find(p => rel === p || rel.startsWith(p + '/'));
    if (pkg) tags.add(`pkg:${pkg}`);
  }
  // Backtick-wrapped path-like tokens.
  for (const m of md.matchAll(/`([^`]+)`/g)) tagPath(m[1]);
  // Bare path tokens with a code-ish extension (catches "see ingestion/rest/foo.py").
  for (const m of md.matchAll(/(?:^|[\s(])([A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_.\-]+)+\.(?:py|sql|toml|ya?ml|json|md|sh))\b/g)) tagPath(m[1]);
  // Arch-page references — exact title matches in the body.
  const hay = md.toLowerCase();
  for (const p of contextPagesCfg) {
    const t = (p.title ?? '').toLowerCase().trim();
    if (t && hay.includes(t)) tags.add(`page:${p.title}`);
  }
  return [...tags];
}

// ── Step 1: load context pages ───────────────────────────────────────
const contextPages = [];
for (const pg of contextPagesCfg) {
  const slug = normaliseId(pg.id);
  const fileRel = join('context', `${slug}.md`);
  const filePath = join(cacheDir, fileRel);
  let fetched = false;
  if (refresh || !existsSync(filePath)) {
    writeFileSync(filePath, fetchPageMarkdown(pg.id), 'utf8');
    fetched = true;
  }
  contextPages.push({ id: pg.id, title: pg.title ?? '', file: fileRel.replace(/\\/g, '/'), refetched: fetched });
}

// ── Step 2: query target board + neighbour boards ────────────────────
const titleOf = (row) => row._title ?? row['Task Name'] ?? row['Name'] ?? '(untitled)';

const targetRows = queryBoard(milestoneCfg.board);
const neighbours = [];
for (const n of milestoneCfg.neighbours ?? []) {
  neighbours.push({ id: n.id, board: n.board, rows: queryBoard(n.board) });
}

// dep_map: id → {status, title, board} for resolving depends_on against either
// the milestone board or any neighbour board. We include Done/Deferred rows so
// finished dependencies still resolve.
const depMap = new Map();
for (const r of targetRows) depMap.set(normaliseId(r.id), { status: r[statusProp] ?? '', title: titleOf(r), board: milestoneCfg.board });
for (const n of neighbours) for (const r of n.rows) depMap.set(normaliseId(r.id), { status: r[statusProp] ?? '', title: titleOf(r), board: n.board });

// ── Step 3: process Design + Planning tasks on the milestone board ──────────────
const tasks = {
  executable: [],          // Ready + In Progress
  needs_grooming: [],      // Backlog
  closed_not_done: [],     // In Review
  done: [],                // Done (kept for completeness; just title+id)
  // NOTE: Deferred tasks are NOT surfaced — they mean "scope superseded by another
  // task" (equivalent to Done from the skill's standpoint). They stay in depMap
  // for dep resolution (a dep on a Deferred task is satisfied, not blocked).
};
const unresolvedPageRefs = [];

for (const row of targetRows) {
  const type = row['Type'] ?? '';
  if (!designTypeMatcher(type)) continue;

  const status = row[statusProp] ?? '';
  const isDone = status === vocab.done;
  const isDeferred = status === vocab.deferred;
  const isInReview = status === vocab.in_review;
  const isBacklog = status === vocab.backlog;
  const isExecutable = status === vocab.ready || status === vocab.in_progress;

  // Done / Deferred tasks — record only in done summary (Deferred is treated as
  // Done: scope superseded by another task, not surfaced for grooming/design).
  if (isDone || isDeferred) {
    tasks.done.push({ id: row.id, title: titleOf(row), status, url: row.url });
    continue;
  }

  // Fetch body for everything else (Ready / In Progress / In Review / Backlog).
  const slug = normaliseId(row.id);
  const bodyFileRel = join('tasks', `${slug}.md`);
  const bodyPath = join(cacheDir, bodyFileRel);
  const md = fetchPageMarkdown(row.id);
  writeFileSync(bodyPath, md, 'utf8');

  const openQ = extractOpenQuestions(md);
  const pagesAffected = extractPagesAffected(md).map(p => {
    const page_id = resolvePageId(p.title);
    if (!page_id) unresolvedPageRefs.push({ task_id: row.id, task_title: titleOf(row), page_title: p.title, raw: p.raw });
    return { title: p.title, page_id, raw: p.raw };
  });

  const depIds = extractDepIds(row['Depends On'] ?? '');
  const depDetails = depIds.map(id => {
    const found = resolveDep(id);
    return found
      ? { id, title: found.title, status: found.status, resolved: true }
      : { id, title: null, status: null, resolved: false };
  });
  // dep_status: 'ready' = all deps satisfied (Done, Ready, or Deferred — Deferred
  // means scope superseded, so the dep is closed not blocked) or unresolved/external,
  // 'blocked' otherwise. Unresolved external deps are NOT counted as blocking — they
  // may live on a board not loaded as a neighbour. The skill surfaces them but does
  // not gate on them.
  const blockingDeps = depDetails.filter(d => d.resolved && d.status !== vocab.done && d.status !== vocab.ready && d.status !== vocab.deferred);
  const depStatus = blockingDeps.length === 0 ? 'ready' : 'blocked';

  const themeTags = extractThemeTags(md);

  const entry = {
    id: row.id,
    title: titleOf(row),
    status,
    priority: row['Priority'] ?? '',
    type,
    url: row.url,
    body_file: bodyFileRel.replace(/\\/g, '/'),
    open_questions: openQ.items,
    open_questions_source: openQ.source,
    pages_affected: pagesAffected,
    depends_on: depDetails,
    dep_status: depStatus,
    blocking_dep_ids: blockingDeps.map(d => d.id),
    theme_tags: themeTags,
    size: openQ.items.length,
  };

  if (isExecutable) tasks.executable.push(entry);
  else if (isBacklog) tasks.needs_grooming.push(entry);
  else if (isInReview) tasks.closed_not_done.push(entry);
}

// neighbour boards: context-only summaries (Design + Planning tasks only).
const neighboursSummary = neighbours.map(n => ({
  id: n.id,
  board: n.board,
  design_tasks: n.rows
    .filter(r => designTypeMatcher(r['Type'] ?? ''))
    .map(r => ({ id: r.id, title: titleOf(r), status: r[statusProp] ?? '' })),
}));

// ── Step 4: design-state.json — preserve signed-off entries across resumes ──
function readJson(path, fallback) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback; }
  catch { return fallback; }
}
const priorState = readJson(join(cacheDir, 'design-state.json'), {});
const state = { ...priorState };

for (const t of [...tasks.executable, ...tasks.needs_grooming, ...tasks.closed_not_done]) {
  // Status of the question seed: each open question gets a slot. If the prior
  // state had a locked decision for the SAME question text, preserve it.
  const priorTask = state[t.id] ?? {};
  const priorQs = Array.isArray(priorTask.open_questions) ? priorTask.open_questions : [];
  const priorByText = new Map(priorQs.map(q => [q.q, q]));
  const seededQs = t.open_questions.map(q => {
    const p = priorByText.get(q);
    return p ?? { q, investigated: false, recommendation: null, locked_decision: null, signed_off_at: null };
  });

  // Pages-affected: preserve applied_at / applied_diff if the page title matches.
  const priorPages = Array.isArray(priorTask.pages_affected) ? priorTask.pages_affected : [];
  const priorPagesByTitle = new Map(priorPages.map(p => [p.title, p]));
  const seededPages = t.pages_affected.map(p => {
    const prev = priorPagesByTitle.get(p.title);
    return {
      title: p.title,
      page_id: p.page_id,
      proposed_diff: prev?.proposed_diff ?? null,
      applied_at: prev?.applied_at ?? null,
      applied_diff: prev?.applied_diff ?? null,
    };
  });

  state[t.id] = {
    title: t.title,
    status: t.status,
    moved_to_in_progress_at: priorTask.moved_to_in_progress_at ?? null,
    open_questions: seededQs,
    pages_affected: seededPages,
    followon_tasks: Array.isArray(priorTask.followon_tasks) ? priorTask.followon_tasks : [],
    implementation_notes_written_at: priorTask.implementation_notes_written_at ?? null,
    moved_to_done_at: priorTask.moved_to_done_at ?? priorTask.moved_to_in_review_at ?? null,
  };
}

// ── Step 5: emit ─────────────────────────────────────────────────────
const bundle = {
  generated: { milestone, repo, ts: null /* skill stamps this on first use */ },
  context_pages: contextPages,
  boards: {
    target: { milestone, board: milestoneCfg.board, design_tasks: { executable: tasks.executable.length, needs_grooming: tasks.needs_grooming.length, closed_not_done: tasks.closed_not_done.length, done_or_deferred: tasks.done.length } },
    neighbours: neighboursSummary,
  },
  done_design_tasks: tasks.done,
};

const worklist = {
  milestone,
  executable: tasks.executable,
  needs_grooming: tasks.needs_grooming,
  closed_not_done: tasks.closed_not_done,
  unresolved_page_refs: unresolvedPageRefs,
  // NOTE: no `deferred` field — Deferred tasks mean "scope superseded by another
  // task" (equivalent to Done) and are not surfaced. See anti-patterns.md.
};

writeFileSync(join(cacheDir, 'context-bundle.json'), JSON.stringify(bundle, null, 2), 'utf8');
writeFileSync(join(cacheDir, 'design-worklist.json'), JSON.stringify(worklist, null, 2), 'utf8');
writeFileSync(join(cacheDir, 'design-state.json'), JSON.stringify(state, null, 2), 'utf8');

// ── summary ──────────────────────────────────────────────────────────
const blockedExec = tasks.executable.filter(t => t.dep_status === 'blocked').length;
const readyExec = tasks.executable.length - blockedExec;
console.log(`design-load: milestone ${milestone} loaded into ${cacheDir}`);
console.log(`  context pages: ${contextPages.length} (${contextPages.filter(p => p.refetched).length} fetched, rest cached)`);
console.log(`  📐 Design + 📋 Planning tasks on target board:`);
console.log(`    executable (Ready + In Progress): ${tasks.executable.length} (${readyExec} dep-ready, ${blockedExec} dep-blocked)`);
console.log(`    needs grooming (🔲 Backlog): ${tasks.needs_grooming.length}  ← run /groom first`);
console.log(`    closed not done (In Review): ${tasks.closed_not_done.length}  done/deferred (not surfaced): ${tasks.done.length}`);
console.log(`  neighbour boards: ${neighboursSummary.length} (Design-task context only)`);
if (unresolvedPageRefs.length) {
  console.log(`  ⚠ ${unresolvedPageRefs.length} "Notion pages affected" reference(s) did not resolve to a context_pages title:`);
  for (const u of unresolvedPageRefs.slice(0, 8)) console.log(`     - "${u.page_title}" (task: ${u.task_title})`);
  if (unresolvedPageRefs.length > 8) console.log(`     … and ${unresolvedPageRefs.length - 8} more (see design-worklist.json)`);
}
const tasksMissingQs = tasks.executable.filter(t => t.open_questions.length === 0);
if (tasksMissingQs.length) {
  console.log(`  ⚠ ${tasksMissingQs.length} executable Design / Planning task(s) parsed with zero open questions — the skill will need manual scoping:`);
  for (const t of tasksMissingQs) console.log(`     - ${t.title}`);
}
console.log('Next: the /design skill proposes a thematic execution order over the dep-ready executable tasks, then walks each one question at a time.');
