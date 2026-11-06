#!/usr/bin/env node
// Diff-scoped runner for the test:scripts suites: `node scripts/scoped-script-tests.mjs <repo-relative changed files...>`.
// Runs the node --test suites (same targets as `npm run test:scripts`) only when a
// scripts/** or config-template/hooks/** path changed, and always leaves a JUnit
// report at .test-reports/scripts.xml. The report declares itself to the
// orchestrator (orchestrator.declares) and lists every claimed changed path
// (orchestrator.claimed_path); zero claimed paths means nothing in scope changed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const SCOPE_PREFIXES = ['scripts/', 'config-template/hooks/'];
const TEST_TARGETS = [
  'scripts/__tests__/',
  'scripts/tests/',
  'config-template/hooks/__tests__/',
];

const files = process.argv.slice(2);
const claimed = files.filter((f) =>
  SCOPE_PREFIXES.some((p) => f.startsWith(p)),
);

const reportRel = '.test-reports/scripts.xml';
const reportPath = path.resolve(reportRel);

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

mkdirSync(path.dirname(reportPath), { recursive: true });

if (claimed.length === 0) {
  writeFileSync(
    reportPath,
    `<?xml version="1.0" encoding="UTF-8" ?>\n<testsuites name="node tests" tests="0" failures="0" errors="0" time="0">${declarationXml}</testsuites>\n`,
  );
  console.log('[scoped-script-tests] no scripts/hooks changes; skipping');
  process.exit(0);
}

const res = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-reporter=junit',
    `--test-reporter-destination=${reportRel}`,
    ...TEST_TARGETS,
  ],
  { stdio: 'inherit' },
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
