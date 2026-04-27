#!/usr/bin/env node
// scripts/scan-identifiers.mjs
//
// Pre-release check: scans tracked files for personal identifiers that should
// not leak into the running app or its source. Legitimate references (GitHub
// clone URLs, the GitHub no-reply email used in author fields) are exempt.
//
// Exit code 0 = clean; 1 = hits found.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const NAME_PATTERN = /\b(?:Pedro|Hadek|phahadek|phadek)\b/i;

// Lines matching this regex are exempt — legitimate uses of the GitHub
// identity (clone URLs, no-reply email, this script's own pattern definitions).
const EXEMPT_LINE = /github\.com\/phahadek|phahadek@users\.noreply\.github\.com|NAME_PATTERN|EXEMPT_LINE/;

// Files where the personal identifier appears for legitimate reasons (clone
// URL examples in user-facing docs). The full file is skipped.
const FILE_ALLOWLIST = new Set([
  'README.md',
  'docs/install.md',
  'LICENSE',
  'scripts/scan-identifiers.mjs',
]);

const tracked = execSync('git ls-files', { encoding: 'utf-8' })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((f) => !FILE_ALLOWLIST.has(f));

const hits = [];
for (const file of tracked) {
  let content;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    continue; // binary or unreadable file
  }
  if (!NAME_PATTERN.test(content)) continue;

  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (NAME_PATTERN.test(line) && !EXEMPT_LINE.test(line)) {
      hits.push(`${file}:${idx + 1}: ${line.trim()}`);
    }
  });
}

if (hits.length > 0) {
  console.error(`Personal identifiers found in ${hits.length} location(s):`);
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log('No personal identifiers found in tracked files (allowlist + line exemptions applied).');
