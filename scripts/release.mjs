#!/usr/bin/env node
/**
 * Release preparation script.
 *
 * Usage:  node scripts/release.mjs <version>
 * Example: node scripts/release.mjs 1.5.0
 *
 * What it does:
 *   1. Validates the version argument is a valid semver (X.Y.Z, optionally prefixed with "v").
 *   2. Bumps the version field in all three package.json files to the target version.
 *   3. Asserts packages/backend/package.json.version === target (guard against future drift).
 *   4. Commits: "chore(release): bump version to X.Y.Z"
 *   5. Prints the tag command for the human to run.
 *
 * The human then runs: git tag vX.Y.Z && git push && git push --tags
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const rawVersion = process.argv[2];

if (!rawVersion) {
  console.error('Usage: node scripts/release.mjs <version>');
  console.error('Example: node scripts/release.mjs 1.5.0');
  process.exit(1);
}

const version = rawVersion.replace(/^v/, '');

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    `Invalid version: "${rawVersion}". Must be X.Y.Z (e.g. 1.5.0).`,
  );
  process.exit(1);
}

const PACKAGE_PATHS = [
  join(ROOT, 'package.json'),
  join(ROOT, 'packages', 'backend', 'package.json'),
  join(ROOT, 'packages', 'frontend', 'package.json'),
];

for (const pkgPath of PACKAGE_PATHS) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`  bumped ${pkgPath.replace(ROOT, '.')} → ${version}`);
}

// Guard: assert backend package.json reflects the target version
const backendPkg = JSON.parse(
  readFileSync(join(ROOT, 'packages', 'backend', 'package.json'), 'utf8'),
);
if (backendPkg.version !== version) {
  console.error(
    `Assertion failed: packages/backend/package.json.version is "${backendPkg.version}", expected "${version}".`,
  );
  process.exit(1);
}

// Commit the version bump
const files = PACKAGE_PATHS.map((p) => p.replace(ROOT + '/', '')).join(' ');
execSync(`git add ${files}`, { cwd: ROOT, stdio: 'inherit' });
execSync(`git commit -m "chore(release): bump version to ${version}"`, {
  cwd: ROOT,
  stdio: 'inherit',
});

console.log('');
console.log('Version bump committed. Now run:');
console.log('');
console.log(`  git tag v${version}`);
console.log(`  git push`);
console.log(`  git push origin v${version}`);
console.log('');
