#!/usr/bin/env node
/**
 * ops-journal-set.mjs — deterministic in-place field writer for the /ops staging journal.
 *
 * Sibling to ops-load.mjs. Sets `state` (and optionally `resolution`) on ONE journal entry, so
 * the /ops skill never hand-edits the large `ops-state.json` — the error-prone part (a stray
 * `"resolution": null` line, a duplicate key, a botched block delete broke resolves mid-run).
 *
 * It does NOT delete entries. Trimming stays with ops-load.mjs's on-load reconcile — deletion is
 * the fragile part; this only replaces the in-place field writes. Model: on resolve, call this to
 * set `state: resolved` + `resolution`; the next `ops-load.mjs` load drops it.
 *
 * Usage:
 *   node ops-journal-set.mjs --task <id> --state <state> \
 *     [--resolution '<json>'] [--disposition pass|blocked-pending-fix|pass-with-caveat] \
 *     ( --project <key> --milestone <M> | --file <path/to/ops-state.json> )
 *
 *   <state> ∈ pending | candidate | staged-proposal | applied-pending-confirm |
 *            blocked | incident-frozen | resolved
 *   --disposition  pass | blocked-pending-fix | pass-with-caveat — for the 🧪 Testing
 *            (observational/E2E) Investigation variant. There is NO "fail": a surfaced issue →
 *            blocked-pending-fix (file the fix, set the task Ready + Depends On it).
 *   <id>    full Notion UUID or the 16-hex prefix (matched prefix-aware, dashes ignored).
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
function fail(m) {
  console.error(`ops-journal-set: ${m}`);
  process.exit(1);
}

const STATES = new Set([
  'pending',
  'candidate',
  'staged-proposal',
  'applied-pending-confirm',
  'blocked',
  'incident-frozen',
  'resolved',
]);

const taskId = option('--task');
const state = option('--state');
const resolutionRaw = option('--resolution');
const dispositionRaw = option('--disposition');
const fileOpt = option('--file');
const project = option('--project');
const milestone = option('--milestone');
const configDirOpt = option('--config-dir');

if (!taskId || !state)
  fail(
    'required: --task <id> --state <state>  (see the header for full usage).',
  );
if (!STATES.has(state))
  fail(`unknown --state "${state}". One of: ${[...STATES].join(' | ')}.`);
const DISPOSITIONS = new Set([
  'pass',
  'blocked-pending-fix',
  'pass-with-caveat',
]);
if (dispositionRaw !== undefined && !DISPOSITIONS.has(dispositionRaw))
  fail(
    `--disposition must be one of: ${[...DISPOSITIONS].join(' | ')} (got "${dispositionRaw}"). ` +
      `There is no "fail" — a surfaced issue is blocked-pending-fix.`,
  );

// ── Resolve the journal path (mirrors ops-load.mjs's config-tree resolution) ──
function resolveConfigDir() {
  const explicit = configDirOpt ?? process.env.ORCHESTRATOR_CONFIG_DIR;
  if (explicit) return resolve(process.cwd(), explicit);
  // Walk up from cwd looking for a `config/` dir with a `projects/` subdir — robust whether run
  // from the projects root, a repo, or a worktree (the fixed-depth candidates missed some cwds).
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'config', 'projects'))) return join(dir, 'config');
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let file = fileOpt ? resolve(process.cwd(), fileOpt) : null;
if (!file) {
  if (!project || !milestone)
    fail(
      'locate the journal with --file <path>, or --project <key> --milestone <M>.',
    );
  const cfg = resolveConfigDir();
  if (!cfg)
    fail('could not locate the config tree; pass --file or --config-dir.');
  file = join(
    cfg,
    'projects',
    project,
    '.ops-cache',
    milestone,
    'ops-state.json',
  );
}
if (!existsSync(file))
  fail(`journal not found at ${file} (run ops-load.mjs first?).`);

let journal;
try {
  journal = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  fail(`journal is not valid JSON: ${e.message}`);
}

// ── Prefix-aware key match (full UUID or 16-hex prefix; dashes ignored) ──
const norm = (s) => s.replace(/-/g, '').toLowerCase();
const want = norm(taskId);
let key = Object.keys(journal).find((k) => norm(k) === want);
if (!key)
  key = Object.keys(journal).find(
    (k) => norm(k).startsWith(want) || want.startsWith(norm(k)),
  );
if (!key)
  fail(
    `no journal entry matches task "${taskId}". Entries: ${
      Object.keys(journal)
        .map((k) => k.slice(0, 13))
        .join(', ') || '(none)'
    }.`,
  );

let resolution;
if (resolutionRaw !== undefined) {
  try {
    resolution = JSON.parse(resolutionRaw);
  } catch (e) {
    fail(`--resolution is not valid JSON: ${e.message}`);
  }
}

const entry = journal[key];
const prevState = entry.state;
entry.state = state;
if (resolution !== undefined) entry.resolution = resolution;
if (dispositionRaw !== undefined) entry.disposition = dispositionRaw;

writeFileSync(file, JSON.stringify(journal, null, 2), 'utf8');
console.log(
  `ops-journal-set: ${key.slice(0, 13)}  state ${prevState} → ${state}` +
    `${resolution !== undefined ? '  (+resolution)' : ''}` +
    `${dispositionRaw !== undefined ? `  (disposition: ${dispositionRaw})` : ''}\n  ${file}`,
);
if (state === 'resolved' && resolution === undefined)
  console.log(
    '  note: marked resolved without --resolution; add one so the task page gets the outcome.',
  );
