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
 *
 * By design there is NO auto-run (no postinstall, no symlink, no watcher) — see the M9
 * "Productize the Backlog Grooming procedure" task. It also does NOT register the
 * PreToolUse hook in ~/.claude/settings.json — that stays a documented one-time manual
 * step (auto-editing user-global settings is riskier). See README § Grooming/design skills.
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

console.log(dryRun ? 'dry-run complete (no changes).' : 'deploy complete.');
console.log(
  'Reminder: the groom-gate.mjs PreToolUse hook must be registered once in ~/.claude/settings.json ' +
    '(manual — see README § Grooming/design skills).',
);
