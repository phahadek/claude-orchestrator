#!/usr/bin/env node
/**
 * migrate-orchestrator-config.mjs — Translate `.claude/orchestrator.json` →
 * `.claude-orchestrator.yml` across every managed project listed in the
 * orchestrator's SQLite DB.
 *
 * Background: the orchestrator-config loader was rewritten to read only
 * `.claude-orchestrator.yml`. Projects that still have a `.claude/orchestrator.json`
 * are silently using empty defaults until they're migrated.
 *
 * Usage:
 *   node scripts/migrate-orchestrator-config.mjs [options]
 *
 * Options:
 *   --db <path>     Path to the dashboard SQLite DB. Default: packages/backend/dashboard.db
 *   --dry-run       Print what would happen without writing or deleting anything.
 *
 * Behavior per project (enumerated from `projects.project_dir`):
 *   - If `.claude-orchestrator.yml` already exists → skip (idempotent).
 *   - If `.claude/orchestrator.json` exists → translate, write YAML, delete JSON.
 *   - If neither exists → skip silently (project uses defaults).
 *
 * Field translation (see Per-project build command config Notion task):
 *   allowedTools          → allowed_tools
 *   bashRules             → bash_rules
 *   bootstrapScript       → bootstrap_script
 *   prGate.typeCheck      → first entry in verify
 *   prGate.build          → second entry in verify
 *   (new fields autofix / ci_check_name are left empty — fill per project after migration)
 *
 * Failure handling:
 *   - Per-project failures are logged with the project name; the script continues
 *     with the next project. The JSON file is only deleted after the YAML write
 *     succeeds.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const Database = require('better-sqlite3');

// ── Arg parsing ───────────────────────────────────────────────────────
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
  const val = args[i + 1];
  args.splice(i, 2);
  return val;
}

// ── Pure translation function (exported for tests) ────────────────────
/**
 * Translate the old `.claude/orchestrator.json` shape to the new
 * `.claude-orchestrator.yml` shape. Pure — no I/O.
 *
 * @param {object} jsonConfig — parsed contents of `.claude/orchestrator.json`
 * @returns {object} — config object ready to be `yaml.dump`'d
 */
export function translate(jsonConfig) {
  const verify = [];
  if (jsonConfig?.prGate?.typeCheck) verify.push(jsonConfig.prGate.typeCheck);
  if (jsonConfig?.prGate?.build) verify.push(jsonConfig.prGate.build);

  return {
    autofix: [],
    verify,
    ci_check_name: [],
    allowed_tools: Array.isArray(jsonConfig?.allowedTools)
      ? jsonConfig.allowedTools
      : [],
    bash_rules: Array.isArray(jsonConfig?.bashRules)
      ? jsonConfig.bashRules
      : [],
    bootstrap_script:
      typeof jsonConfig?.bootstrapScript === 'string'
        ? jsonConfig.bootstrapScript
        : '',
  };
}

// ── Per-project migration ─────────────────────────────────────────────
/**
 * Migrate a single project's config. Returns one of:
 *   { status: 'skipped-already-migrated' }
 *   { status: 'skipped-no-config' }
 *   { status: 'migrated', verifyCount, allowedToolsCount, bashRulesCount, bootstrapScript }
 *   { status: 'error', error }
 */
function migrateProject(projectDir, { dryRun }) {
  const jsonPath = join(projectDir, '.claude', 'orchestrator.json');
  const yamlPath = join(projectDir, '.claude-orchestrator.yml');

  if (existsSync(yamlPath)) {
    return { status: 'skipped-already-migrated' };
  }
  if (!existsSync(jsonPath)) {
    return { status: 'skipped-no-config' };
  }

  let jsonConfig;
  try {
    jsonConfig = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  } catch (err) {
    return { status: 'error', error: `failed to parse JSON: ${err.message}` };
  }

  const newConfig = translate(jsonConfig);
  const yamlContent = yaml.dump(newConfig, { lineWidth: -1, noRefs: true });

  if (dryRun) {
    return {
      status: 'would-migrate',
      verifyCount: newConfig.verify.length,
      allowedToolsCount: newConfig.allowed_tools.length,
      bashRulesCount: newConfig.bash_rules.length,
      bootstrapScript: newConfig.bootstrap_script || '(none)',
    };
  }

  try {
    writeFileSync(yamlPath, yamlContent, 'utf-8');
  } catch (err) {
    return {
      status: 'error',
      error: `failed to write YAML at ${yamlPath}: ${err.message}`,
    };
  }

  try {
    unlinkSync(jsonPath);
  } catch (err) {
    return {
      status: 'error',
      error: `wrote YAML but failed to delete JSON at ${jsonPath}: ${err.message}`,
    };
  }

  return {
    status: 'migrated',
    verifyCount: newConfig.verify.length,
    allowedToolsCount: newConfig.allowed_tools.length,
    bashRulesCount: newConfig.bash_rules.length,
    bootstrapScript: newConfig.bootstrap_script || '(none)',
  };
}

// ── Main ──────────────────────────────────────────────────────────────
function main() {
  const dryRun = flag('--dry-run');
  const dbPath = option('--db') ?? 'packages/backend/dashboard.db';

  const resolvedDbPath = resolve(dbPath);
  if (!existsSync(resolvedDbPath)) {
    console.error(`error: SQLite DB not found at ${resolvedDbPath}`);
    process.exit(1);
  }

  const db = new Database(resolvedDbPath, { readonly: true });
  const projects = db
    .prepare('SELECT id, name, project_dir FROM projects')
    .all();
  db.close();

  console.log(
    `${dryRun ? '[DRY-RUN] ' : ''}Found ${projects.length} managed project(s) in ${resolvedDbPath}.\n`,
  );

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const project of projects) {
    const result = migrateProject(project.project_dir, { dryRun });

    switch (result.status) {
      case 'migrated':
      case 'would-migrate':
        migrated++;
        console.log(
          `  ${dryRun ? 'WOULD MIGRATE' : 'MIGRATED'} ${project.name} (${project.project_dir})`,
        );
        console.log(
          `    verify=${result.verifyCount} allowed_tools=${result.allowedToolsCount} bash_rules=${result.bashRulesCount} bootstrap_script=${result.bootstrapScript}`,
        );
        break;
      case 'skipped-already-migrated':
        skipped++;
        console.log(
          `  SKIPPED (already has .claude-orchestrator.yml) ${project.name}`,
        );
        break;
      case 'skipped-no-config':
        skipped++;
        console.log(`  SKIPPED (no .claude/orchestrator.json) ${project.name}`);
        break;
      case 'error':
        errors++;
        console.error(`  ERROR ${project.name}: ${result.error}`);
        break;
    }
  }

  console.log(
    `\n${dryRun ? '[DRY-RUN] ' : ''}Done. ${migrated} migrated, ${skipped} skipped, ${errors} error(s).`,
  );

  if (errors > 0) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
