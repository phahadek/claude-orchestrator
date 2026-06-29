#!/usr/bin/env node
/**
 * deploy-grooming.mjs — copy the vendored grooming/design skill artifacts from this
 * repo into ~/.claude so the /groom and /design skills + their loaders run user-globally.
 *
 * Run by hand after changing any vendored artifact:
 *   node scripts/deploy-grooming.mjs [--dry-run]
 *
 * Idempotent and cross-platform (Node fs; Windows + Linux). Copies:
 *   scripts/{groom-load,design-load,groom-gate,notion-page}.mjs → ~/.claude/scripts/
 *   skills/groom/**  +  skills/design/**                         → ~/.claude/skills/
 *   config-template/hooks/load-procedures.mjs → <config-tree>/hooks/  (overwrite)
 *   config-template/task-writing.md           → <config-tree>/task-writing.md  (overwrite)
 *   config-template/procedures.md             → <config-tree>/procedures.md  (seed-only)
 *
 * The config-template/* artifacts go into the central config tree (a `config/` dir inside
 * the projects root, beside each managed repo), not ~/.claude — that's where the Remote
 * Control SessionStart hook runs from. The config tree is resolved via
 * $ORCHESTRATOR_CONFIG_DIR, else `<repo>/../config` (config-inside-projects, both hosts),
 * with `<repo>/../../config` kept only as a legacy-layout fallback.
 * load-procedures.mjs + task-writing.md are overwritten each run (pure universal rules);
 * procedures.md is seeded only if absent (it's deployment-edited — fill in its Project index).
 *
 * By design there is NO auto-run (no postinstall, no symlink, no watcher) — see the M9
 * "Productize the Backlog Grooming procedure" task. It also does NOT register any hooks in
 * ~/.claude/settings.json — both the `groom-gate.mjs` PreToolUse hook and the
 * `load-procedures.mjs` SessionStart hook stay documented one-time manual steps
 * (auto-editing user-global settings is riskier). See README § Grooming/design skills.
 *
 * Note: groom-load.mjs / design-load.mjs also call sibling scripts notion-query.mjs and
 * notion-move-tasks.mjs, which are deployed to ~/.claude/scripts separately (they predate
 * this script). This deploy only owns the four grooming/design-specific scripts + the skills.
 */
import { cpSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const dryRun = process.argv.includes('--dry-run');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // <repo>/scripts → <repo>
const claudeHome = join(homedir(), '.claude');

const SCRIPTS = [
  'groom-load.mjs',
  'design-load.mjs',
  'groom-gate.mjs',
  'notion-page.mjs',
];
const SKILLS = ['groom', 'design'];

function copy(src, dest, label) {
  if (!existsSync(src)) {
    console.error(`  ! missing source: ${src}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ${dryRun ? '[dry-run] would copy' : 'copied'}  ${label}`);
  if (dryRun) return;
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
}

// Copy only if the destination does not already exist — for deployment-edited
// files (e.g. procedures.md) that must never be clobbered by a re-deploy.
function seedIfAbsent(src, dest, label) {
  if (!existsSync(src)) {
    console.error(`  ! missing source: ${src}`);
    process.exitCode = 1;
    return;
  }
  if (existsSync(dest)) {
    console.log(`  skip (exists)  ${label}`);
    return;
  }
  console.log(`  ${dryRun ? '[dry-run] would seed' : 'seeded'}  ${label}`);
  if (dryRun) return;
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { force: true });
}

// Resolve the central config tree (a `config/` dir inside the projects root, beside
// each repo). Same precedence the loaders use: $ORCHESTRATOR_CONFIG_DIR, else the first
// candidate whose `projects/` subdir exists (`<repo>/../config` for config-inside-projects,
// `<repo>/../../config` as a legacy fallback), else `<repo>/../config`.
function resolveConfigDir(root) {
  const explicit = process.env.ORCHESTRATOR_CONFIG_DIR;
  if (explicit) return resolve(explicit);
  for (const c of [
    resolve(root, '..', 'config'),
    resolve(root, '..', '..', 'config'),
  ]) {
    if (existsSync(join(c, 'projects'))) return c;
  }
  return resolve(root, '..', 'config');
}

console.log(
  `deploy-grooming: ${repoRoot} -> ${claudeHome}${dryRun ? '  (dry-run)' : ''}`,
);
if (!dryRun) {
  mkdirSync(join(claudeHome, 'scripts'), { recursive: true });
  mkdirSync(join(claudeHome, 'skills'), { recursive: true });
}
for (const s of SCRIPTS)
  copy(
    join(repoRoot, 'scripts', s),
    join(claudeHome, 'scripts', s),
    `scripts/${s}`,
  );
for (const s of SKILLS)
  copy(
    join(repoRoot, 'skills', s),
    join(claudeHome, 'skills', s),
    `skills/${s}/`,
  );

// Central config tree (outside every repo): the Remote Control SessionStart hook
// (overwrite) + a procedures.md to fill in (seed only).
const configDir = resolveConfigDir(repoRoot);
console.log(`config tree -> ${configDir}`);
copy(
  join(repoRoot, 'config-template', 'hooks', 'load-procedures.mjs'),
  join(configDir, 'hooks', 'load-procedures.mjs'),
  'config/hooks/load-procedures.mjs',
);
copy(
  join(repoRoot, 'config-template', 'task-writing.md'),
  join(configDir, 'task-writing.md'),
  'config/task-writing.md',
);
seedIfAbsent(
  join(repoRoot, 'config-template', 'procedures.md'),
  join(configDir, 'procedures.md'),
  'config/procedures.md',
);

console.log(dryRun ? 'dry-run complete (no changes).' : 'deploy complete.');
console.log(
  'Reminder: register BOTH hooks once in ~/.claude/settings.json (manual — see README ' +
    '§ Grooming/design skills): the groom-gate.mjs PreToolUse gate and the ' +
    'load-procedures.mjs SessionStart bootstrap.',
);
