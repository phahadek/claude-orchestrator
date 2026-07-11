#!/usr/bin/env node
/**
 * sync-guidelines-load.mjs — Deterministic Step-1 loader for the /sync-guidelines skill.
 *
 * WHY THIS EXISTS. The universal guideline docs — `task-writing.md` and `procedures.md` —
 * are NOT mechanically deployable. The repo copy (`config-template/<doc>`) is the *upstream
 * guideline source*; the live copy (`<config-tree>/<doc>`) is an *integrated working copy*
 * that carries host/project-specific content the upstream must never clobber (the live
 * `procedures.md` has a filled-in Project index; the live `task-writing.md` carries concrete
 * project examples). A `cpSync` fails both ways: overwrite destroys the local content,
 * seed-only never propagates upstream updates. So deployment of these docs is a **Claude-led
 * integration**: take what changed upstream since the last integration and weave it into the
 * locally-enriched live doc, preserving local content and resolving conflicts with judgment.
 *
 * This loader does the deterministic part so the model has nothing to shortcut: it resolves
 * the repo (upstream) + config tree (live), reads the per-doc baseline (the repo commit last
 * integrated), and prints — per doc — the exact UPSTREAM DELTA since that baseline (a
 * `git diff <baseline>..HEAD -- config-template/<doc>`) plus the resolved live/upstream paths.
 * The skill reads that delta + the two docs and performs the merge by hand (the delta will NOT
 * `git apply` cleanly onto the enriched live doc — that is the whole point; it is guidance, not
 * a patch to apply). After the human confirms the integrated live doc, `--record` bumps the
 * baseline to the current HEAD.
 *
 * Usage:
 *   node sync-guidelines-load.mjs [options]            # plan: show per-doc upstream delta
 *   node sync-guidelines-load.mjs --record [doc ...]   # after integration: bump baseline → HEAD
 *
 * Options:
 *   --config-dir <path>  Central config tree root (overrides $ORCHESTRATOR_CONFIG_DIR).
 *   --repo <path>        Upstream repo root (overrides $ORCHESTRATOR_REPO_DIR / discovery).
 *   --record [doc ...]   Record the current repo HEAD as the new baseline for the named docs
 *                        (default: all). Run ONLY after the live docs have been integrated.
 *   --json               Emit the plan as JSON instead of the human-readable report.
 *
 * The baseline lives at `<config-tree>/guidelines-baseline.json`:
 *   { "task-writing.md": "<repo-sha>", "procedures.md": "<repo-sha>" }
 * A doc with no baseline entry is a FIRST integration (full reconcile: compare upstream vs live
 * directly, there is no delta to diff).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';

// The two integrated guideline docs, relative to the repo's config-template/ (upstream) and
// the config tree root (live). Everything else in config-template/ is mechanical (cpSync).
const GUIDELINES = ['task-writing.md', 'procedures.md'];
const BASELINE_FILE = 'guidelines-baseline.json';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const wantJson = process.argv.includes('--json');
const doRecord = process.argv.includes('--record');

// --- Resolve the central config tree (live docs). Same precedence the other loaders use. ---
function resolveConfigDir() {
  const explicit = arg('--config-dir') || process.env.ORCHESTRATOR_CONFIG_DIR;
  if (explicit) return resolve(explicit);
  for (const c of [
    resolve(process.cwd(), 'config'),
    resolve(process.cwd(), '..', 'config'),
  ]) {
    if (existsSync(join(c, 'projects'))) return c;
  }
  // Fall back to the projects-root convention: cwd is usually the projects root.
  return resolve(process.cwd(), 'config');
}

// --- Resolve the upstream repo (holds config-template/<doc> + the git history). Deployed to
// ~/.claude/scripts, this loader is detached from the repo, so it discovers it beside the
// config tree: <projects-root>/claude-orchestrator, or any sibling holding the sources. ---
function resolveRepo(configDir) {
  const explicit = arg('--repo') || process.env.ORCHESTRATOR_REPO_DIR;
  if (explicit) return resolve(explicit);
  const projectsRoot = resolve(configDir, '..');
  const named = join(projectsRoot, 'claude-orchestrator');
  if (existsSync(join(named, 'config-template', 'task-writing.md')))
    return named;
  // Last resort: scan siblings for one that carries the upstream sources.
  return named; // best-effort; the caller validates existence and reports a clear error.
}

const configDir = resolveConfigDir();
const repo = resolveRepo(configDir);
const baselinePath = join(configDir, BASELINE_FILE);

function readBaseline() {
  if (!existsSync(baselinePath)) return {};
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (e) {
    console.error(`! could not parse ${baselinePath}: ${e.message}`);
    process.exit(1);
  }
}

function git(args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function headSha() {
  return git(['rev-parse', 'HEAD']).trim();
}

// --- --record: bump baseline for the named docs (default all) to the current HEAD. ---
if (doRecord) {
  const idx = process.argv.indexOf('--record');
  const named = process.argv.slice(idx + 1).filter((a) => !a.startsWith('--'));
  const docs = named.length ? named : GUIDELINES;
  for (const d of docs) {
    if (!GUIDELINES.includes(d)) {
      console.error(
        `! not a tracked guideline doc: ${d} (known: ${GUIDELINES.join(', ')})`,
      );
      process.exit(1);
    }
  }
  const baseline = readBaseline();
  const sha = headSha();
  for (const d of docs) baseline[d] = sha;
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`recorded baseline ${sha.slice(0, 10)} for: ${docs.join(', ')}`);
  console.log(`  → ${baselinePath}`);
  process.exit(0);
}

// --- Plan mode: report per-doc upstream delta since baseline. ---
if (!existsSync(join(repo, 'config-template', 'task-writing.md'))) {
  console.error(
    `! upstream sources not found under ${repo}/config-template/ — pass --repo <orchestrator-repo>.`,
  );
  process.exit(1);
}

const baseline = readBaseline();
const head = headSha();
const plan = [];

for (const doc of GUIDELINES) {
  const upstreamPath = join(repo, 'config-template', doc);
  const livePath = join(configDir, doc);
  const base = baseline[doc];
  const liveExists = existsSync(livePath);
  let status;
  let delta = '';
  if (!liveExists) {
    status = 'missing-live'; // first deploy of this doc — live copy does not exist yet
  } else if (!base) {
    status = 'no-baseline'; // first integration — reconcile upstream vs live directly
  } else if (base === head) {
    status = 'up-to-date'; // baseline already at HEAD — nothing changed upstream
  } else {
    delta = git(['diff', `${base}..${head}`, '--', `config-template/${doc}`]);
    status = delta.trim() ? 'has-upstream-changes' : 'up-to-date';
  }
  plan.push({
    doc,
    status,
    base: base || null,
    head,
    upstreamPath,
    livePath,
    delta,
  });
}

if (wantJson) {
  console.log(JSON.stringify({ repo, configDir, baselinePath, plan }, null, 2));
  process.exit(0);
}

// Human-readable report for the skill to read.
console.log(`sync-guidelines plan`);
console.log(`  upstream repo : ${repo}`);
console.log(`  config tree   : ${configDir}`);
console.log(
  `  baseline file : ${baselinePath}${existsSync(baselinePath) ? '' : '  (absent — first run)'}`,
);
console.log(`  repo HEAD     : ${head.slice(0, 10)}\n`);

for (const p of plan) {
  const baseStr = p.base ? p.base.slice(0, 10) : '—';
  console.log(`── ${p.doc}  [${p.status}]  baseline=${baseStr}`);
  console.log(`     upstream: ${p.upstreamPath}`);
  console.log(`     live    : ${p.livePath}`);
  if (p.status === 'up-to-date') {
    console.log(`     nothing to integrate.\n`);
  } else if (p.status === 'missing-live') {
    console.log(
      `     live copy absent — first deploy: copy upstream, then add local content, then --record.\n`,
    );
  } else if (p.status === 'no-baseline') {
    console.log(
      `     no baseline — FULL reconcile: diff upstream vs live by hand, integrate, then --record.\n`,
    );
  } else {
    console.log(
      `     UPSTREAM DELTA since baseline (integrate this into the live doc, preserving local content):`,
    );
    console.log(
      p.delta
        .split('\n')
        .map((l) => `       ${l}`)
        .join('\n'),
    );
    console.log('');
  }
}

const actionable = plan.filter((p) => p.status !== 'up-to-date');
if (!actionable.length) {
  console.log('All guideline docs are up to date — no integration needed.');
} else {
  console.log(
    `${actionable.length} doc(s) need integration: ${actionable.map((p) => p.doc).join(', ')}.`,
  );
  console.log(
    'After integrating + human confirmation, run:  node sync-guidelines-load.mjs --record',
  );
}
