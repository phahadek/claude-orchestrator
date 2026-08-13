#!/usr/bin/env node
// scripts/check-markdown-paths.mjs
//
// CI-safe check: scans tracked markdown for repo-relative path references
// (markdown link targets and inline code spans that look like repo paths)
// and validates each one resolves to a tracked file or directory. Catches
// stale links left behind by renames/deletes without flagging deployed or
// generated paths, glob/placeholder syntax, or illustrative examples that
// were never meant to resolve.
//
// Exit code 0 = clean; 1 = unresolved paths found.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';

// Lines carrying this marker are exempt — used for illustrative example
// paths in worked examples, and for prose that deliberately references a
// removed file to explain its removal.
export const EXEMPT_LINE = /<!--\s*path-check:ignore\s*-->/;

// Files skipped entirely. Empty by default; same shape as
// scan-identifiers.mjs's FILE_ALLOWLIST for a whole-file opt-out.
export const FILE_ALLOWLIST = new Set([]);

// Candidates matching any of these (once resolved to a repo-root-relative
// path) are excluded before existence-checking — never reported as
// failures, even if unresolved.
export const EXCLUDE_PATTERNS = [
  /^\.claude\//, // runtime session state, correctly absent from the repo
  /(^|\/)\.env$/, // operator-created, correctly absent from the repo
  /(^|\/)dist\//, // build output, correctly absent from the repo
  /^config\//, // the deployed config tree, not this repository
];

// A candidate must start with one of these (or be `./`/`../`-relative) to be
// treated as a repo path worth checking. Keeps prose mentions of unrelated
// slash-separated text (URLs, shell flags, etc.) out of the candidate set.
const TOP_LEVEL_ENTRIES = [
  'scripts/',
  'packages/',
  'config-template/',
  'skills/',
  'docs/',
  '.github/',
];

// Candidates containing any of these are glob syntax or a `<placeholder>`,
// never a literal path — skip rather than false-positive on them.
const NON_LITERAL_CHARS = /[*{}<>]/;

const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CODE_SPAN_PATTERN = /`([^`\n]+)`/g;

function isRelative(candidate) {
  return candidate.startsWith('./') || candidate.startsWith('../');
}

function looksLikeRepoPath(candidate) {
  if (isRelative(candidate)) return true;
  return TOP_LEVEL_ENTRIES.some((prefix) => candidate.startsWith(prefix));
}

export function isExcluded(candidate) {
  return EXCLUDE_PATTERNS.some((re) => re.test(candidate));
}

function stripDecoration(raw) {
  let c = raw.trim();
  if (c.startsWith('<') && c.endsWith('>')) c = c.slice(1, -1);
  c = c.split('#')[0]; // drop in-doc anchor
  c = c.split('?')[0]; // drop query string
  return c;
}

export function extractCandidates(line) {
  const candidates = new Set();

  LINK_PATTERN.lastIndex = 0;
  let m;
  while ((m = LINK_PATTERN.exec(line))) {
    const raw = m[1];
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('mailto:'))
      continue;
    const decorated = stripDecoration(raw);
    if (!decorated || NON_LITERAL_CHARS.test(decorated)) continue;
    if (looksLikeRepoPath(decorated)) candidates.add(decorated);
  }

  CODE_SPAN_PATTERN.lastIndex = 0;
  while ((m = CODE_SPAN_PATTERN.exec(line))) {
    const raw = m[1].trim();
    if (!raw || /\s/.test(raw)) continue;
    const decorated = stripDecoration(raw);
    if (!decorated || NON_LITERAL_CHARS.test(decorated)) continue;
    if (looksLikeRepoPath(decorated)) candidates.add(decorated);
  }

  return [...candidates];
}

// Resolves a candidate to a repo-root-relative path. `./`/`../` candidates
// are relative markdown links, resolved against the referencing file's own
// directory (standard relative-link semantics); everything else already
// starts with a top-level repo entry and is repo-root-relative as written.
export function resolveCandidate(candidate, mdFile) {
  if (!isRelative(candidate)) return candidate;
  const resolved = posix.normalize(posix.join(dirname(mdFile), candidate));
  return resolved === '.' ? '' : resolved;
}

function pathResolves(resolved, trackedSet, trackedDirPrefixes) {
  if (resolved.endsWith('/')) return trackedDirPrefixes.has(resolved);
  return trackedSet.has(resolved);
}

export function checkFile(content, mdFile, trackedSet, trackedDirPrefixes) {
  const failures = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (EXEMPT_LINE.test(line)) return;
    for (const candidate of extractCandidates(line)) {
      const resolved = resolveCandidate(candidate, mdFile);
      if (!resolved || isExcluded(resolved)) continue;
      if (pathResolves(resolved, trackedSet, trackedDirPrefixes)) continue;
      failures.push({ line: idx + 1, path: candidate });
    }
  });
  return failures;
}

export function filterMarkdownFiles(tracked) {
  return tracked
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !FILE_ALLOWLIST.has(f));
}

export function buildDirPrefixes(tracked) {
  const prefixes = new Set();
  for (const file of tracked) {
    const parts = file.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      prefix += parts[i] + '/';
      prefixes.add(prefix);
    }
  }
  return prefixes;
}

function main() {
  const tracked = execSync('git ls-files', { encoding: 'utf-8' })
    .split(/\r?\n/)
    .filter(Boolean);
  const trackedSet = new Set(tracked);
  const trackedDirPrefixes = buildDirPrefixes(tracked);
  const markdownFiles = filterMarkdownFiles(tracked);

  const hits = [];
  for (const file of markdownFiles) {
    let content;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue; // unreadable file
    }
    for (const failure of checkFile(
      content,
      file,
      trackedSet,
      trackedDirPrefixes,
    )) {
      hits.push(`${file}:${failure.line}: ${failure.path}`);
    }
  }

  if (hits.length > 0) {
    console.error(
      `Unresolved repo-relative paths found in ${hits.length} location(s):`,
    );
    for (const h of hits) console.error('  ' + h);
    process.exit(1);
  }
  console.log(
    'All repo-relative paths referenced in tracked markdown resolve to tracked files.',
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
