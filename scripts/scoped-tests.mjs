#!/usr/bin/env node
// Diff-scoped test runner: `node scripts/scoped-tests.mjs <frontend|backend> <repo-relative changed files...>`.
// Runs `vitest related` in that workspace for only its own changed paths and
// always leaves a JUnit report at packages/<pkg>/.test-reports/<pkg>.xml.
// The report declares itself to the orchestrator (orchestrator.declares) and
// lists every changed path this command took (orchestrator.claimed_path); zero
// claimed paths means nothing in this package's scope changed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const [pkg, ...files] = process.argv.slice(2);
if (pkg !== 'frontend' && pkg !== 'backend') {
  console.error('usage: scoped-tests.mjs <frontend|backend> <files...>');
  process.exit(2);
}

const prefix = `packages/${pkg}/`;
const pkgDir = path.resolve('packages', pkg);
const claimed = files.filter((f) => f.startsWith(prefix));
const related = claimed.map((f) => f.slice(prefix.length));

const reportRel = `.test-reports/${pkg}.xml`;
const reportPath = path.join(pkgDir, reportRel);

const escapeAttr = (s) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const declarationXml =
  '<properties><property name="orchestrator.declares" value="1"/>' +
  claimed
    .map(
      (f) =>
        `<property name="orchestrator.claimed_path" value="${escapeAttr(f)}"/>`,
    )
    .join('') +
  '</properties>';

if (related.length === 0) {
  mkdirSync(path.join(pkgDir, '.test-reports'), { recursive: true });
  writeFileSync(
    reportPath,
    `<?xml version="1.0" encoding="UTF-8" ?>\n<testsuites name="vitest tests" tests="0" failures="0" errors="0" time="0">${declarationXml}</testsuites>\n`,
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

if (existsSync(reportPath)) {
  const xml = readFileSync(reportPath, 'utf8');
  const withDeclaration = xml.replace(
    /<testsuites\b([^>]*?)(\/)?>/,
    (_m, attrs, selfClose) =>
      selfClose
        ? `<testsuites${attrs}>${declarationXml}</testsuites>`
        : `<testsuites${attrs}>${declarationXml}`,
  );
  if (withDeclaration !== xml) writeFileSync(reportPath, withDeclaration);
}
process.exit(res.status ?? 1);
