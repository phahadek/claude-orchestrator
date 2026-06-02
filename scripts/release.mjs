#!/usr/bin/env node
// scripts/release.mjs
//
// Release-prep helper: bumps all workspace package.json versions to the
// target, commits the change, and prints the tag command.
//
// Usage:
//   node scripts/release.mjs <version>    # e.g. 1.5.0 or v1.5.0
//
// What it does:
//   1. Validates the target version is a valid semver string.
//   2. Bumps "version" in package.json (root), packages/backend/package.json,
//      and packages/frontend/package.json.
//   3. Verifies packages/backend/package.json.version === <target> after
//      writing (the field the auto-updater reads).
//   4. Commits with message: chore(release): bump version to X.Y.Z
//   5. Prints the tag + push commands for the human to run.
//
// Exit codes: 0 = success, 1 = error (bad args, version mismatch, git failure)

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function fail(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

// ── Parse + validate target version ─────────────────────────────────────────

const rawArg = process.argv[2];
if (!rawArg) {
  fail('Missing version argument.\n\nUsage: node scripts/release.mjs <version>\nExample: node scripts/release.mjs 1.5.0');
}

const target = rawArg.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(target)) {
  fail(`"${rawArg}" is not a valid semver string (expected X.Y.Z or vX.Y.Z).`);
}

// ── Bump all workspace package.json files ────────────────────────────────────

const PACKAGE_PATHS = [
  resolve(ROOT, 'package.json'),
  resolve(ROOT, 'packages', 'backend', 'package.json'),
  resolve(ROOT, 'packages', 'frontend', 'package.json'),
];

for (const pkgPath of PACKAGE_PATHS) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const prev = pkg.version;
  pkg.version = target;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`  bumped ${pkgPath.replace(ROOT + '/', '')}  ${prev} → ${target}`);
}

// ── Verify the auto-updater source of truth ───────────────────────────────────

const backendPkgPath = PACKAGE_PATHS[1];
const backendVersion = JSON.parse(readFileSync(backendPkgPath, 'utf8')).version;
if (backendVersion !== target) {
  fail(
    `packages/backend/package.json.version is "${backendVersion}" after write — expected "${target}". ` +
      'The auto-updater reads this field; the release cannot proceed with a mismatch.',
  );
}

// ── Commit ────────────────────────────────────────────────────────────────────

try {
  execSync(`git -C "${ROOT}" add package.json packages/backend/package.json packages/frontend/package.json`, { stdio: 'inherit' });
  execSync(`git -C "${ROOT}" commit -m "chore(release): bump version to ${target}"`, { stdio: 'inherit' });
} catch {
  fail('git commit failed — resolve the error above and retry.');
}

// ── Print next steps ──────────────────────────────────────────────────────────

console.log(`
Version bumped and committed to ${target}.

Next steps (run these after merging dev → main):

  git tag v${target} main
  git push origin v${target}

Then create a GitHub Release from the tag to trigger the installer build.
`);
