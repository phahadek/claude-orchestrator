#!/usr/bin/env node
/**
 * ops-load.mjs — Deterministic loader for the /ops skill (Flow step 2).
 *
 * Sister to groom-load.mjs / design-load.mjs. Where /groom brings 🔲 Backlog tasks to
 * 🗂️ Ready and /design executes 📐 Design / 📋 Planning tasks, /ops *works* the interactive
 * 🔧 Operational and 🔎 Investigation tasks. This loader does the deterministic part of the
 * /ops Flow step 2 and, crucially, owns the THREE on-load jobs that prose alone can't enforce:
 *
 *   1. Load context — context.md is read by the skill; this loads the fixed Notion context
 *      pages from the manifest (the MASTER Project Context page + the source-of-truth docs it
 *      links: findings / retrospective / architecture / guidelines). Skipping the master page
 *      is the #1 load failure; the loader makes it non-optional.
 *   2. Pre-seed the staging journal (ops-state.json) with ONE stub per eligible task, at
 *      `state: "pending"`. This is what makes the first-pass gate real: an un-worked task is a
 *      visible `pending` entry, not a self-attested count. The skill's coverage line
 *      ("N eligible · N journaled") reads this file.
 *   3. Reconcile / trim — rebuild the journal against the LIVE board so entries for tasks now
 *      ✅ Done / ⏭️ Deferred / removed are DROPPED (the journal holds open work, not history),
 *      while worked fields (evidence, state, finding, resolution) for still-open tasks are
 *      preserved across resumes.
 *
 * It REUSES the proven sibling scripts rather than re-implementing Notion REST:
 *   - notion-query.mjs  (paginated board query → JSON rows)
 *   - notion-page.mjs   (page body → clean Markdown)
 *
 * Usage:
 *   node ops-load.mjs --milestone M12 --project polimarket-analyser [options]
 *
 * Options:
 *   --milestone <id>     Required. Milestone key (registered in the manifest, or pass --board).
 *   --project <key>      Project dir under config/projects/ (default: --repo basename).
 *   --manifest <path>    Manifest JSON (explicit full path; overrides the central-tree default).
 *   --config-dir <path>  Central config tree root (overrides $ORCHESTRATOR_CONFIG_DIR).
 *   --repo <path>        Repo / project root, only used to derive --project (default: cwd).
 *   --cache-dir <path>   Cache root (default: <config-tree>/projects/<project>/.ops-cache/<milestone>).
 *   --env <path>         .env with NOTION_API_KEY (default: manifest.notion_env).
 *   --board <id>         Board data-source id for an UNregistered milestone — run it now
 *                        without editing the manifest; prints the entry to persist.
 *   --refresh            Re-fetch context pages even if cached files already exist.
 *
 * Eligibility (status_vocab from the manifest):
 *   - Ready / In Progress  → executable — the /ops first-pass works these (journal-seeded).
 *   - Backlog              → needs-grooming — surfaced but NOT seeded (groom to Ready first).
 *   - In Review            → closed-not-done (context only).
 *   - Done / Deferred      → context only (used for dep resolution; prunes stale journal entries).
 *
 * Exit code is non-zero on any fetch failure, so the skill halts rather than proceeding on a
 * partial load.
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
const projectKey = option('--project') ?? basename(repo);
const boardOverride = option('--board');
const refresh = flag('--refresh');
let envPath = option('--env'); // may fall back to manifest.notion_env after load

function fail(msg) {
  console.error(`ops-load: ${msg}`);
  process.exit(1);
}

// ── Central config tree + manifest resolution (mirrors design-load) ──────
function resolveConfigDir(repoRoot) {
  const explicit =
    option('--config-dir') ?? process.env.ORCHESTRATOR_CONFIG_DIR;
  if (explicit) return resolve(process.cwd(), explicit);
  for (const c of [
    resolve(repoRoot, '..', 'config'),
    resolve(repoRoot, '..', '..', 'config'),
    // ops is often run from the projects root itself (cwd = projects/):
    resolve(repoRoot, 'config'),
  ]) {
    if (existsSync(join(c, 'projects'))) return c;
  }
  return null;
}

const configDir = resolveConfigDir(repo);
const manifestPath =
  option('--manifest') ??
  (configDir ? join(configDir, 'projects', projectKey, 'grooming.json') : null);

if (!milestone) {
  console.error(
    'Usage: node ops-load.mjs --milestone <id> --project <key> [options]',
  );
  console.error('Run with no args to see full help at the top of the script.');
  process.exit(1);
}
if (!manifestPath)
  fail(
    `could not locate the central config tree. Set $ORCHESTRATOR_CONFIG_DIR or pass --config-dir <path> ` +
      `(must contain a 'projects/' subdir), or pass --manifest <path> directly.`,
  );
if (!existsSync(manifestPath))
  fail(
    `manifest not found at ${manifestPath} (the /ops skill shares the grooming manifest with /groom + /design — ` +
      `create it in the central config tree; see ~/.claude/skills/groom/reference/manifest.example.json).`,
  );

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  fail(`manifest is not valid JSON: ${e.message}`);
}
if (!envPath) envPath = manifest.notion_env;

// Suggest the immediately-prior registered milestone by trailing integer (M12 → M11).
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

// Resolve the milestone. Unregistered milestone → run via --board or fail with a paste-able entry.
const registeredMilestones = manifest.milestones ?? {};
let milestoneCfg = registeredMilestones[milestone];
let unregisteredNote = null;
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
      `ops-load: ⚠ milestone "${milestone}" is not registered in ${manifestPath} — running with ` +
        `--board ${boardOverride}. Persist it via the snippet printed at the end.`,
    );
  } else {
    fail(
      `milestone "${milestone}" is not registered in ${manifestPath} ` +
        `(registered: ${Object.keys(registeredMilestones).join(', ') || 'none'}).\n` +
        `Do one of:\n` +
        `  • add under "milestones": "${milestone}": { "board": "<board-data-source-id>", "neighbours": ${neighboursJson} }\n` +
        `  • or run now: re-run with --board <board-data-source-id> (prints the entry to persist).`,
    );
  }
}

const statusProp = manifest.status_property ?? 'Status';
const vocab = manifest.status_vocab ?? {};
const sourceRoot = (manifest.source_root ?? '').replace(/\/+$/, '');
const packages = (manifest.packages ?? [])
  .filter((p) => typeof p === 'string')
  .sort((a, b) => b.length - a.length);
const contextPagesCfg = (manifest.context_pages ?? []).filter(
  (p) => p && typeof p.id === 'string',
);

// /ops targets Type = "🔧 Operational" OR "🔎 Investigation", PLUS observational / E2E "🧪 Testing"
// folded in as an Investigation variant (run the system live → a disposition, no "fail"). Tolerant of
// the emoji being stripped — match on the word (case-insensitive). Legacy "🛠️ Tooling" is surfaced
// separately as needing reclassification (the split retired it). Test-AUTHORING Testing tasks are
// excluded (they are really 💻 Code) — see parseTestingVariant + the test_authoring triage list.
const opsTypeMatcher = (t) =>
  typeof t === 'string' && /operational|investigation/i.test(t);
const testingTypeMatcher = (t) => typeof t === 'string' && /testing/i.test(t);
const toolingTypeMatcher = (t) => typeof t === 'string' && /tooling/i.test(t);
const modeOf = (type) =>
  /investigation/i.test(type) ? 'investigation' : 'operational';

// A 🧪 Testing task folds into /ops only as OBSERVATIONAL / E2E work (run the system, observe by
// value, reach a disposition). Test-AUTHORING (writing test code, no live-data dependency) is
// 💻 Code — excluded. Deterministic signal: an explicit `Mode: 🧪 Testing · authoring` marker;
// absent one we default to observational (fold in) and let the skill's triage catch any unmarked
// authoring task by judgment (surfaced in test_authoring, never silently worked).
function parseTestingVariant(md) {
  const m = md.match(
    /mode\s*:.*testing.*?(authoring|observational|e2e|end[-\s]?to[-\s]?end)/is,
  );
  return m && /authoring/i.test(m[1]) ? 'authoring' : 'observational';
}

const cacheDir = resolve(
  process.cwd(),
  option('--cache-dir') ??
    join(configDir, 'projects', projectKey, '.ops-cache', milestone),
);
const contextDir = join(cacheDir, 'context');
const tasksDir = join(cacheDir, 'tasks');
for (const d of [cacheDir, contextDir, tasksDir])
  mkdirSync(d, { recursive: true });

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
    fail(`could not parse notion-query.mjs JSON for board ${boardId}: ${e.message}`);
  }
}
function fetchPageMarkdown(pageId) {
  return runScript('notion-page.mjs', [pageId, '--format', 'md']);
}

// ── parsing helpers (shared idiom with design-load) ──────────────────
const NOTION_ID_RE =
  /\b([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})(?:-?([0-9a-f]{4}))?(?:-?([0-9a-f]{12}))?\b/gi;
const normaliseId = (id) => id.replace(/-/g, '').toLowerCase();

function sectionBody(md, headRe) {
  const lines = md.split('\n');
  const anyHead = /^#{1,4}\s+/;
  const i = lines.findIndex((l) => headRe.test(l));
  if (i === -1) return '';
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (anyHead.test(lines[j])) break;
    body.push(lines[j]);
  }
  return body.join('\n');
}

/** Parse the "Mode:" declaration line → operational flavor (directed | research-first). */
function parseFlavor(md, mode) {
  if (mode !== 'operational') return null;
  const m = md.match(/mode\s*:.*?operational.*?(directed|research[-\s]?first)/is);
  if (m) return /research/i.test(m[1]) ? 'research-first' : 'directed';
  return null;
}

function extractDepIds(depsStr) {
  if (!depsStr || typeof depsStr !== 'string') return [];
  const out = new Set();
  for (const m of depsStr.matchAll(NOTION_ID_RE)) {
    const norm = [m[1], m[2], m[3], m[4], m[5]].filter(Boolean).join('').toLowerCase();
    if (norm.length >= 16) out.add(norm);
  }
  return [...out];
}
function resolveDep(idOrPrefix, depMap) {
  if (depMap.has(idOrPrefix)) return depMap.get(idOrPrefix);
  if (idOrPrefix.length < 32) {
    for (const [k, v] of depMap) if (k.startsWith(idOrPrefix)) return v;
  }
  return null;
}

function extractThemeTags(md) {
  const tags = new Set();
  function tagPath(tok) {
    const cleaned = tok.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (!cleaned.includes('/')) return;
    let rel = cleaned;
    if (sourceRoot && cleaned.startsWith(sourceRoot + '/'))
      rel = cleaned.slice(sourceRoot.length + 1);
    const pkg = packages.find((p) => rel === p || rel.startsWith(p + '/'));
    if (pkg) tags.add(`pkg:${pkg}`);
  }
  for (const m of md.matchAll(/`([^`]+)`/g)) tagPath(m[1]);
  for (const m of md.matchAll(
    /(?:^|[\s(])([A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_.\-]+)+\.(?:py|sql|toml|ya?ml|json|md|sh|ps1))\b/g,
  ))
    tagPath(m[1]);
  const hay = md.toLowerCase();
  for (const p of contextPagesCfg) {
    const t = (p.title ?? '').toLowerCase().trim();
    if (t && hay.includes(t)) tags.add(`page:${p.title}`);
  }
  return [...tags];
}

function readJson(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

// ── Step 1: load context pages (master page + source-of-truth docs) ──────
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
  contextPages.push({
    id: pg.id,
    title: pg.title ?? '',
    file: fileRel.replace(/\\/g, '/'),
    refetched: fetched,
  });
}

// ── Step 2: query target board + neighbour boards ────────────────────
const titleOf = (row) =>
  row._title ?? row['Task Name'] ?? row['Name'] ?? '(untitled)';

const targetRows = queryBoard(milestoneCfg.board);
const neighbours = [];
for (const n of milestoneCfg.neighbours ?? [])
  neighbours.push({ id: n.id, board: n.board, rows: queryBoard(n.board) });

const depMap = new Map();
for (const r of targetRows)
  depMap.set(normaliseId(r.id), {
    status: r[statusProp] ?? '',
    title: titleOf(r),
    board: milestoneCfg.board,
  });
for (const n of neighbours)
  for (const r of n.rows)
    depMap.set(normaliseId(r.id), {
      status: r[statusProp] ?? '',
      title: titleOf(r),
      board: n.board,
    });

// ── Step 3: process Operational + Investigation tasks on the target board ──────
const tasks = {
  executable: [], // Ready + In Progress with deps satisfied — the first-pass works these
  dep_blocked: [], // Ready/In-Progress but a hard dep isn't ✅ Done — surfaced, NOT walkable/seeded
  needs_grooming: [], // Backlog — surfaced, not seeded
  closed_not_done: [], // In Review
  done: [], // Done / Deferred (context only)
};
const leftoverTooling = []; // open 🛠️ Tooling that still needs reclassification
const testAuthoring = []; // open 🧪 Testing that is really 💻 Code (test-authoring) → excluded

for (const row of targetRows) {
  const type = row['Type'] ?? '';
  const status = row[statusProp] ?? '';
  const isDone = status === vocab.done || status === vocab.deferred;

  // Flag any still-open legacy 🛠️ Tooling (the split retired it → reclassify to Operational/Investigation).
  if (toolingTypeMatcher(type) && !isDone) {
    leftoverTooling.push({ id: row.id, title: titleOf(row), status, url: row.url });
    continue;
  }
  const isOps = opsTypeMatcher(type);
  const isTesting = testingTypeMatcher(type);
  if (!isOps && !isTesting) continue;

  if (isDone) {
    tasks.done.push({ id: row.id, title: titleOf(row), status, url: row.url });
    continue;
  }

  const isInReview = status === vocab.in_review;
  const isBacklog = status === vocab.backlog;
  const isExecutable = status === vocab.ready || status === vocab.in_progress;

  const slug = normaliseId(row.id);
  const bodyFileRel = join('tasks', `${slug}.md`);
  const md = fetchPageMarkdown(row.id);
  writeFileSync(join(cacheDir, bodyFileRel), md, 'utf8');

  // 🧪 Testing folds in as an Investigation variant (observational/E2E → a disposition); test-authoring
  // is 💻 Code → excluded to the test_authoring triage list.
  let mode, flavor;
  if (isTesting) {
    if (parseTestingVariant(md) === 'authoring') {
      testAuthoring.push({ id: row.id, title: titleOf(row), status, url: row.url });
      continue;
    }
    mode = 'investigation';
    flavor = 'testing';
  } else {
    mode = modeOf(type);
    flavor = parseFlavor(md, mode);
  }

  const depIds = extractDepIds(row['Depends On'] ?? '');
  const depDetails = depIds.map((id) => {
    const found = resolveDep(id, depMap);
    return found
      ? { id, title: found.title, status: found.status, resolved: true }
      : { id, title: null, status: null, resolved: false };
  });
  // Only ✅ Done satisfies a hard dep for /ops — same strictness as auto-dispatch. A 🗂️ Ready or
  // ⏭️ Deferred dep BLOCKS (Ready isn't finished; Deferred is superseded → the dep is stale, re-groom).
  // Unresolved/external deps (on a board not loaded) are NOT counted as blocking; the skill surfaces them.
  const blockingDeps = depDetails.filter(
    (d) => d.resolved && d.status !== vocab.done,
  );
  const depStatus = blockingDeps.length === 0 ? 'ready' : 'blocked';

  const entry = {
    id: row.id,
    title: titleOf(row),
    status,
    priority: row['Priority'] ?? '',
    type,
    mode,
    flavor,
    url: row.url,
    body_file: bodyFileRel.replace(/\\/g, '/'),
    depends_on: depDetails,
    dep_status: depStatus,
    blocking_dep_ids: blockingDeps.map((d) => d.id),
    theme_tags: extractThemeTags(md),
  };

  if (isExecutable)
    (depStatus === 'blocked' ? tasks.dep_blocked : tasks.executable).push(entry);
  else if (isBacklog) tasks.needs_grooming.push(entry);
  else if (isInReview) tasks.closed_not_done.push(entry);
}

// ── Step 4: ops-state.json — pre-seed + preserve + reconcile/trim ──────
// Rebuild from empty against the LIVE board: only EXECUTABLE (Ready/In-Progress) tasks get a
// journal entry (that is the first-pass work set). Prior worked fields are pulled forward for
// tasks still executable; entries whose task is now Done/Deferred/removed/off-eligibility are
// DROPPED (trim). This is the deterministic half of the skill's "journal holds open work, not
// history" rule.
const priorState = readJson(join(cacheDir, 'ops-state.json'), {});
const WORKED_FIELDS = [
  'worked_in',
  'state',
  'evidence',
  'finding_or_proposal',
  'falsification',
  'filed_followons',
  'needs_from_operator',
  'resolution',
  'disposition', // 🧪 Testing variant only: pass | blocked-pending-fix | pass-with-caveat | null
];
const state = {};
for (const t of tasks.executable) {
  const prior = priorState[t.id] ?? {};
  const seed = {
    title: t.title,
    task_status: t.status,
    priority: t.priority,
    board: milestoneCfg.board,
    mode: t.mode,
    flavor: t.flavor,
    dep_status: t.dep_status,
    // worked fields — pre-seeded fresh, overwritten by any preserved prior values below.
    worked_in: null,
    state: 'pending', // ← first-pass must advance this off "pending"
    evidence: [],
    finding_or_proposal: null,
    falsification: null,
    filed_followons: [],
    needs_from_operator: null,
    resolution: null,
  };
  // 🧪 Testing variant carries a disposition (pass | blocked-pending-fix | pass-with-caveat;
  // set at resolve — there is no "fail"); seed it null.
  if (t.flavor === 'testing') seed.disposition = null;
  for (const f of WORKED_FIELDS)
    if (prior[f] !== undefined && prior[f] !== null) seed[f] = prior[f];
  state[t.id] = seed;
}
const prunedIds = Object.keys(priorState).filter((id) => !(id in state));
const prunedResolved = prunedIds.filter(
  (id) => priorState[id]?.state === 'resolved',
).length;

// ── Step 5: emit ─────────────────────────────────────────────────────
const sourceOfTruthDocs = contextPages.map((p) => ({
  title: p.title,
  id: p.id,
  file: p.file,
}));

const bundle = {
  generated: { milestone, project: projectKey, ts: null /* skill stamps on first use */ },
  context_pages: contextPages,
  // Surfaced explicitly so the skill CONSULTS these before interpreting any zero/anomaly.
  source_of_truth_docs: sourceOfTruthDocs,
  boards: {
    target: {
      milestone,
      board: milestoneCfg.board,
      ops_tasks: {
        executable: tasks.executable.length,
        testing_observational: tasks.executable.filter((t) => t.flavor === 'testing').length,
        dep_blocked: tasks.dep_blocked.length,
        needs_grooming: tasks.needs_grooming.length,
        closed_not_done: tasks.closed_not_done.length,
        done_or_deferred: tasks.done.length,
        leftover_tooling: leftoverTooling.length,
        test_authoring_excluded: testAuthoring.length,
      },
    },
    neighbours: neighbours.map((n) => ({ id: n.id, board: n.board })),
  },
};

const worklist = {
  milestone,
  project: projectKey,
  executable: tasks.executable,
  dep_blocked: tasks.dep_blocked,
  needs_grooming: tasks.needs_grooming,
  closed_not_done: tasks.closed_not_done,
  leftover_tooling: leftoverTooling,
  test_authoring: testAuthoring,
};

writeFileSync(join(cacheDir, 'context-bundle.json'), JSON.stringify(bundle, null, 2), 'utf8');
writeFileSync(join(cacheDir, 'ops-worklist.json'), JSON.stringify(worklist, null, 2), 'utf8');
writeFileSync(join(cacheDir, 'ops-state.json'), JSON.stringify(state, null, 2), 'utf8');

// ── summary ──────────────────────────────────────────────────────────
const nTesting = tasks.executable.filter((t) => t.flavor === 'testing').length;
const nOperational = tasks.executable.filter((t) => t.mode === 'operational').length;
const nInvestigation = tasks.executable.length - nOperational - nTesting;
console.log(`ops-load: ${projectKey} / ${milestone} loaded into ${cacheDir}`);
console.log(
  `  context pages: ${contextPages.length} (${contextPages.filter((p) => p.refetched).length} fetched, rest cached) — source-of-truth docs surfaced in context-bundle.json`,
);
console.log(`  🔧 Operational + 🔎 Investigation (+ observational 🧪 Testing) tasks on target board:`);
console.log(
  `    executable (Ready/In-Progress, deps ✅ Done): ${tasks.executable.length} — ${nOperational} operational, ${nInvestigation} investigation, ${nTesting} testing (observational/E2E)`,
);
if (tasks.dep_blocked.length)
  console.log(
    `    ⚠ dep-blocked (Ready but a hard dep is not ✅ Done — surfaced for re-groom, NOT walkable/seeded): ${tasks.dep_blocked.length}`,
  );
console.log(
  `    needs grooming (🔲 Backlog): ${tasks.needs_grooming.length}  ← /groom to Ready before /ops works them`,
);
console.log(
  `    closed not done (In Review): ${tasks.closed_not_done.length}  done/deferred: ${tasks.done.length}`,
);
console.log(
  `  journal (ops-state.json): ${tasks.executable.length} eligible task(s) seeded at state:"pending" — the first-pass must advance every one.`,
);
if (prunedIds.length)
  console.log(
    `  trimmed ${prunedIds.length} stale journal entr${prunedIds.length === 1 ? 'y' : 'ies'} (${prunedResolved} resolved, rest done/deferred/removed since last run)`,
  );
if (leftoverTooling.length) {
  console.log(
    `  ⚠ ${leftoverTooling.length} open 🛠️ Tooling task(s) still need reclassification to 🔧 Operational / 🔎 Investigation:`,
  );
  for (const t of leftoverTooling.slice(0, 8)) console.log(`     - ${t.title}`);
}
if (testAuthoring.length) {
  console.log(
    `  ⚠ ${testAuthoring.length} 🧪 Testing task(s) marked test-authoring → excluded (reclassify as 💻 Code; /ops folds in only observational/E2E Testing):`,
  );
  for (const t of testAuthoring.slice(0, 8)) console.log(`     - ${t.title}`);
}
if (unregisteredNote)
  console.log(
    `  ⚠ milestone ${milestone} ran UNREGISTERED (via --board). Persist under "milestones":\n      ${unregisteredNote}`,
  );
console.log(
  'Next: /ops runs the read-only FIRST-PASS over every seeded task (advancing each off "pending"), then presents the overview + review order.',
);
