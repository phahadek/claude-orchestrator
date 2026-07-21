#!/usr/bin/env node
/**
 * sync-guidelines-load.mjs — Deterministic Step-1 loader for the /sync-guidelines skill.
 *
 * WHY THIS EXISTS. Every artifact this repo vendors into a live tree — the universal guideline
 * docs (`config-template/{task-writing,procedures}.md`), the `/groom /design /ops /deploy /wrap
 * /sync-guidelines /gate` skill directories, and the sanctioned route-client scripts
 * (`scripts/*.mjs`, `packages/backend/scripts/*.mjs`) — can carry a live copy that has drifted
 * from the repo: either deliberate vendored-local content (a skill instruction refined in place)
 * or an emergency hotfix. A `cpSync(..., { force: true })` blind overwrite silently destroys
 * that drift with no backup and no way to tell it happened — this is exactly how the `/ops`
 * skill lost its "lead with a recommendation, not a menu" guidance. There is no re-vendor path
 * in this repo that force-overwrites a live tree; every one of them goes through this loader +
 * a Claude-led three-way merge (repo = upstream, live = current, baseline = last integrated
 * repo SHA).
 *
 * This loader does the deterministic part so the model has nothing to shortcut: it resolves the
 * live targets (central config tree for guideline docs; `~/.claude/{skills,scripts}` for skills
 * and route-client scripts), reads the per-item baseline (the repo commit last integrated), and
 * prints — per item — the exact UPSTREAM DELTA since that baseline (a `git diff <baseline>..HEAD
 * -- <path>`) plus the resolved live/upstream paths and each item's status. The skill reads that
 * delta + the two copies and performs the merge by hand (the delta will NOT `git apply` cleanly
 * onto a live copy carrying local content — that is the whole point; it is guidance, not a patch
 * to apply). After the human confirms the integrated live copy, `--record` bumps the baseline to
 * the current HEAD.
 *
 * Usage:
 *   node sync-guidelines-load.mjs [options]              # plan: show per-item upstream delta
 *   node sync-guidelines-load.mjs --record [item ...]     # after integration: bump baseline → HEAD
 *
 * Options:
 *   --config-dir <path>  Central config tree root (overrides $ORCHESTRATOR_CONFIG_DIR).
 *   --claude-home <path> Live ~/.claude root (overrides $CLAUDE_HOME, default ~/.claude).
 *   --repo <path>        Upstream repo root (overrides $ORCHESTRATOR_REPO_DIR / discovery).
 *   --record [item ...]  Record the current repo HEAD as the new baseline for the named items
 *                        (default: all). Run ONLY after the live copies have been integrated.
 *   --json               Emit the plan as JSON instead of the human-readable report.
 *
 * Items are grouped:
 *   - guideline docs: `task-writing.md`, `procedures.md`               → central config tree
 *   - skills:         `skill:groom`, `skill:design`, `skill:ops`,
 *                     `skill:deploy`, `skill:wrap`, `skill:sync-guidelines`,
 *                     `skill:gate`                                     → ~/.claude/skills/<name>
 *   - route clients:  `script:<name>.mjs`                              → ~/.claude/scripts/<name>
 *   - hook mechanism: `hook:load-procedures.mjs`                       → <config-tree>/hooks/
 *
 * The baseline lives at `<config-tree>/guidelines-baseline.json`:
 *   { "task-writing.md": "<repo-sha>", "skill:ops": "<repo-sha>", "script:ops-client.mjs": "<repo-sha>", ... }
 * An item with no baseline entry is a FIRST integration (`no-baseline`): full reconcile — compare
 * upstream vs live directly, there is no delta to diff.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { execFileSync } from 'child_process';
import { homedir } from 'os';

// The two integrated guideline docs, relative to the repo's config-template/ (upstream) and
// the config tree root (live). Everything else in config-template/ besides the hook is mechanical.
const GUIDELINES = ['task-writing.md', 'procedures.md'];
const SKILLS = [
  'groom',
  'design',
  'ops',
  'deploy',
  'wrap',
  'sync-guidelines',
  'gate',
];
const SCRIPT_SOURCES = [
  {
    dir: 'scripts',
    names: [
      'design-load.mjs',
      'check-task-status.mjs',
      'sync-guidelines-load.mjs',
      'notion-page.mjs',
      'ops-client.mjs',
    ],
  },
  {
    dir: join('packages', 'backend', 'scripts'),
    names: [
      'groom-context-client.mjs',
      'groom-flip-client.mjs',
      'gate-state-client.mjs',
      'seed-state-client.mjs',
      'stage-task-intent.mjs',
      'staged-intents-client.mjs',
    ],
  },
];
const BASELINE_FILE = 'guidelines-baseline.json';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const wantJson = process.argv.includes('--json');
const doRecord = process.argv.includes('--record');

// --- Resolve the central config tree (guideline docs + the hook mechanism). Same precedence
// the other loaders use. ---
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

// --- Resolve the live ~/.claude root (skills + route-client scripts). ---
function resolveClaudeHome() {
  const explicit = arg('--claude-home') || process.env.CLAUDE_HOME;
  return explicit ? resolve(explicit) : join(homedir(), '.claude');
}

// --- Resolve the upstream repo (holds config-template/skills/scripts + the git history).
// Deployed to ~/.claude/scripts, this loader is detached from the repo, so it discovers it
// beside the config tree: <projects-root>/claude-orchestrator, or any sibling holding the
// sources. ---
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
const claudeHome = resolveClaudeHome();
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

// --- Build the full vendor item list: guideline docs, skills, route-client scripts, hook. ---
function buildItems() {
  const items = [];
  for (const doc of GUIDELINES) {
    items.push({
      id: doc,
      kind: 'doc',
      repoRelPath: join('config-template', doc),
      upstreamPath: join(repo, 'config-template', doc),
      livePath: join(configDir, doc),
    });
  }
  for (const name of SKILLS) {
    items.push({
      id: `skill:${name}`,
      kind: 'skill',
      repoRelPath: join('skills', name),
      upstreamPath: join(repo, 'skills', name),
      livePath: join(claudeHome, 'skills', name),
    });
  }
  for (const { dir, names } of SCRIPT_SOURCES) {
    for (const name of names) {
      items.push({
        id: `script:${name}`,
        kind: 'script',
        repoRelPath: join(dir, name),
        upstreamPath: join(repo, dir, name),
        livePath: join(claudeHome, 'scripts', name),
      });
    }
  }
  items.push({
    id: 'hook:load-procedures.mjs',
    kind: 'hook',
    repoRelPath: join('config-template', 'hooks', 'load-procedures.mjs'),
    upstreamPath: join(repo, 'config-template', 'hooks', 'load-procedures.mjs'),
    livePath: join(configDir, 'hooks', 'load-procedures.mjs'),
  });
  return items;
}

const ALL_ITEMS = buildItems();
const ITEM_IDS = ALL_ITEMS.map((i) => i.id);

// --- --record: bump baseline for the named items (default all) to the current HEAD. ---
if (doRecord) {
  const idx = process.argv.indexOf('--record');
  const named = process.argv.slice(idx + 1).filter((a) => !a.startsWith('--'));
  const ids = named.length ? named : ITEM_IDS;
  for (const id of ids) {
    if (!ITEM_IDS.includes(id)) {
      console.error(`! not a tracked vendor item: ${id}`);
      console.error(`  known: ${ITEM_IDS.join(', ')}`);
      process.exit(1);
    }
  }
  const baseline = readBaseline();
  const sha = headSha();
  for (const id of ids) baseline[id] = sha;
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`recorded baseline ${sha.slice(0, 10)} for: ${ids.join(', ')}`);
  console.log(`  → ${baselinePath}`);
  process.exit(0);
}

// --- Plan mode: report per-item upstream delta since baseline. ---
if (!existsSync(join(repo, 'config-template', 'task-writing.md'))) {
  console.error(
    `! upstream sources not found under ${repo}/config-template/ — pass --repo <orchestrator-repo>.`,
  );
  process.exit(1);
}

const baseline = readBaseline();
const head = headSha();
const plan = [];

for (const item of ALL_ITEMS) {
  const base = baseline[item.id];
  const liveExists = existsSync(item.livePath);
  let status;
  let delta = '';
  if (!liveExists) {
    status = 'missing-live'; // first deploy of this item — live copy does not exist yet
  } else if (!base) {
    status = 'no-baseline'; // first integration — reconcile upstream vs live directly
  } else if (base === head) {
    status = 'up-to-date'; // baseline already at HEAD — nothing changed upstream
  } else {
    delta = git(['diff', `${base}..${head}`, '--', item.repoRelPath]);
    status = delta.trim() ? 'has-upstream-changes' : 'up-to-date';
  }
  plan.push({ ...item, status, base: base || null, head, delta });
}

if (wantJson) {
  console.log(
    JSON.stringify(
      { repo, configDir, claudeHome, baselinePath, plan },
      null,
      2,
    ),
  );
  process.exit(0);
}

// Human-readable report for the skill to read.
console.log(`sync-guidelines plan`);
console.log(`  upstream repo : ${repo}`);
console.log(`  config tree   : ${configDir}`);
console.log(`  claude home   : ${claudeHome}`);
console.log(
  `  baseline file : ${baselinePath}${existsSync(baselinePath) ? '' : '  (absent — first run)'}`,
);
console.log(`  repo HEAD     : ${head.slice(0, 10)}\n`);

for (const p of plan) {
  const baseStr = p.base ? p.base.slice(0, 10) : '—';
  console.log(`── ${p.id}  [${p.kind}]  [${p.status}]  baseline=${baseStr}`);
  console.log(`     upstream: ${p.upstreamPath}`);
  console.log(`     live    : ${p.livePath}`);
  if (p.status === 'up-to-date') {
    console.log(`     nothing to integrate.\n`);
  } else if (p.status === 'missing-live') {
    console.log(
      `     live copy absent — first deploy: copy upstream verbatim (nothing local to lose), then --record.\n`,
    );
  } else if (p.status === 'no-baseline') {
    console.log(
      `     no baseline — FULL reconcile: diff upstream vs live by hand (byte-identical → safe\n` +
        `     to record with no edit; any difference is either drift to preserve or a stale repo\n` +
        `     change to pull in — read both before writing), then --record.\n`,
    );
  } else {
    console.log(
      `     UPSTREAM DELTA since baseline (integrate this into the live copy, preserving local content):`,
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
  console.log('Everything is up to date — no integration needed.');
} else {
  console.log(
    `${actionable.length} item(s) need integration: ${actionable.map((p) => p.id).join(', ')}.`,
  );
  console.log(
    'After integrating + human confirmation, run:  node sync-guidelines-load.mjs --record',
  );
}
