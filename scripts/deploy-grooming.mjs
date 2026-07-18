#!/usr/bin/env node
/**
 * deploy-grooming.mjs — copy the vendored grooming/design/ops/gate skill artifacts from this
 * repo into ~/.claude so the /groom, /design, /ops, /deploy, /wrap and /gate skills + their
 * loaders run user-globally.
 *
 * Run by hand after changing any vendored artifact:
 *   node scripts/deploy-grooming.mjs [--dry-run]
 *
 * Idempotent and cross-platform (Node fs; Windows + Linux). Copies:
 *   scripts/{design-load,check-task-status,sync-guidelines-load,notion-page,
 *            ops-client}.mjs                                   → ~/.claude/scripts/
 *   packages/backend/scripts/{groom-context-client,gate-state-client,
 *            seed-state-client,stage-task-intent,
 *            staged-intents-client}.mjs                         → ~/.claude/scripts/
 *   skills/{groom,design,ops,deploy,wrap,sync-guidelines,gate}/** → ~/.claude/skills/
 *   config-template/hooks/load-procedures.mjs → <config-tree>/hooks/  (overwrite)
 *
 * groom-load.mjs, ops-load.mjs and ops-journal-set.mjs (Notion-shell-out loaders) and the
 * groom-gate.mjs PreToolUse hook are retired and no longer vendored: groom/ops context loads
 * and ops-journal writes now go through the backend's device-authed routes (the route clients
 * above), and the promotion gate groom-gate.mjs enforced on `notion-update-page` is superseded
 * by the command-layer `checkGroomingPromotionGate` (`groomGate.ts`), enforced server-side on
 * staged-intent apply.
 *
 * The config-template/hooks/* artifacts go into the central config tree (a `config/` dir inside
 * the projects root, beside each managed repo), not ~/.claude — that's where the Remote
 * Control SessionStart hook runs from. The config tree is resolved via
 * $ORCHESTRATOR_CONFIG_DIR, else `<repo>/../config` (config-inside-projects, both hosts),
 * with `<repo>/../../config` kept only as a legacy-layout fallback.
 * load-procedures.mjs is overwritten each run (pure mechanism).
 *
 * NOT copied here: the guideline docs config-template/{task-writing,procedures}.md. They are
 * Class-2 — the repo copy is the *upstream guideline source*, the live copy is an *integrated*
 * copy carrying host/project content (the filled Project index; project examples). A file op
 * would clobber that (overwrite) or never propagate updates (seed-only), so deploying an update
 * to them is a Claude-led merge via the /sync-guidelines skill (scripts/sync-guidelines-load.mjs).
 *
 * By design there is NO auto-run (no postinstall, no symlink, no watcher) — see the M9
 * "Productize the Backlog Grooming procedure" task. It also does NOT register any hooks in
 * ~/.claude/settings.json — the `check-task-status.mjs` PreToolUse hook and the
 * `load-procedures.mjs` SessionStart hook stay documented one-time manual steps (auto-editing
 * user-global settings is riskier). See README § Grooming/design skills.
 *
 * Note: the loaders also call sibling scripts notion-query.mjs and notion-move-tasks.mjs,
 * which are deployed to ~/.claude/scripts separately (they predate this script).
 */
import { cpSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const dryRun = process.argv.includes('--dry-run');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // <repo>/scripts → <repo>
const claudeHome = join(homedir(), '.claude');

// Repo-root scripts.
const SCRIPTS = [
  'design-load.mjs',
  'check-task-status.mjs',
  'sync-guidelines-load.mjs',
  'notion-page.mjs',
  'ops-client.mjs',
];
// Route-based clients that live under packages/backend/scripts/ (they're
// exercised in-process by packages/backend's own tests) but are sanctioned
// session-side CLIs like the ones above — vendored to the same ~/.claude/scripts/.
// staged-intents-client.mjs is the device-authed create/apply/reject client the
// interactive skills (/groom, /design, /ops) use to stage and apply task-write
// intents from a Remote-Control session; stage-task-intent.mjs remains the
// separate, stage-only transport for unattended orchestrator-launched worktree
// sessions (see packages/backend/src/auth/SessionStageAuth.ts) — it is not
// retired, just no longer what the interactive skills use.
const BACKEND_SCRIPTS = [
  'groom-context-client.mjs',
  'gate-state-client.mjs',
  'seed-state-client.mjs',
  'stage-task-intent.mjs',
  'staged-intents-client.mjs',
];
const SKILLS = [
  'groom',
  'design',
  'ops',
  'deploy',
  'wrap',
  'sync-guidelines',
  'gate',
];

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
for (const s of BACKEND_SCRIPTS)
  copy(
    join(repoRoot, 'packages', 'backend', 'scripts', s),
    join(claudeHome, 'scripts', s),
    `packages/backend/scripts/${s}`,
  );
for (const s of SKILLS)
  copy(
    join(repoRoot, 'skills', s),
    join(claudeHome, 'skills', s),
    `skills/${s}/`,
  );

// Central config tree (outside every repo): the Remote Control SessionStart hook
// (pure mechanism → overwrite). The guideline docs task-writing.md + procedures.md are
// deliberately NOT copied here — they are Class-2 (repo = upstream guideline source, live =
// integrated copy carrying host/project content). Deploying an update to them is a Claude-led
// merge via the /sync-guidelines skill (scripts/sync-guidelines-load.mjs), never a file op.
const configDir = resolveConfigDir(repoRoot);
console.log(`config tree -> ${configDir}`);
copy(
  join(repoRoot, 'config-template', 'hooks', 'load-procedures.mjs'),
  join(configDir, 'hooks', 'load-procedures.mjs'),
  'config/hooks/load-procedures.mjs',
);
console.log(
  '  guideline docs (task-writing.md, procedures.md) are NOT copied here — integrate ' +
    'updates with the /sync-guidelines skill.',
);

console.log(dryRun ? 'dry-run complete (no changes).' : 'deploy complete.');
console.log(
  'Reminder: register the hooks once in ~/.claude/settings.json (manual — see README ' +
    '§ Grooming/design skills): the check-task-status.mjs PreToolUse gate and the ' +
    'load-procedures.mjs SessionStart bootstrap.',
);
