#!/usr/bin/env node
// Diff-scoped test runner: `node scripts/scoped-tests.mjs <frontend|backend> <repo-relative changed files...>`.
// Runs `vitest related` in that workspace for only its own changed paths and
// always leaves a JUnit report at packages/<pkg>/.test-reports/<pkg>.xml.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [pkg, ...files] = process.argv.slice(2);
if (pkg !== 'frontend' && pkg !== 'backend') {
  console.error('usage: scoped-tests.mjs <frontend|backend> <files...>');
  process.exit(2);
}

const prefix = `packages/${pkg}/`;
const pkgDir = path.resolve('packages', pkg);
const related = files
  .filter((f) => f.startsWith(prefix))
  .map((f) => f.slice(prefix.length));

const reportRel = `.test-reports/${pkg}.xml`;

if (related.length === 0) {
  mkdirSync(path.join(pkgDir, '.test-reports'), { recursive: true });
  writeFileSync(
    path.join(pkgDir, reportRel),
    '<?xml version="1.0" encoding="UTF-8" ?>\n<testsuites name="vitest tests" tests="0" failures="0" errors="0" time="0"></testsuites>\n',
  );
  console.log(`[scoped-tests] no ${pkg} changes; skipping`);
  process.exit(0);
}

const env = { ...process.env };
if (pkg === 'backend') env.NODE_OPTIONS = '--max-old-space-size=8192';

const res = spawnSync(
  'npx',
  [
    'vitest',
    'related',
    '--run',
    '--passWithNoTests',
    '--reporter=junit',
    `--outputFile=${reportRel}`,
    ...related,
  ],
  { cwd: pkgDir, env, stdio: 'inherit' },
);
process.exit(res.status ?? 1);
