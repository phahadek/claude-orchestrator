#!/usr/bin/env node
// scripts/check-doc-paths.mjs
//
// CI-safe check: scans tracked markdown for repo-relative path references —
// in markdown links, inline code spans, fenced code blocks, and plain prose
// alike — and validates each one resolves to a tracked file or directory.
//
// Unlike a conventional link checker, this does not restrict itself to
// markdown link syntax: the regressions that motivated this script (a stale
// `cp` instruction in a fenced shell block, prose describing a deleted
// source file) were never markdown links, so link-syntax-only detection
// would have caught neither.
//
// Precision is the point. A false positive here blocks CI for everyone, so
// candidates are restricted to a known set of top-level repo entries and a
// short, explicit exclusion list for path shapes that are legitimately
// absent from the tree (deployed config, runtime session state, build
// output). A line can also opt out entirely with a `path-check:ignore`
// marker, for illustrative examples and deliberate historical mentions
// (prose naming a removed file to explain its removal) — path existence
// alone cannot distinguish that from rot; the marker is the honest way to
// defer to human judgment rather than guess from surrounding prose.
//
// Exit code 0 = clean; 1 = unresolved paths found.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';

// Lines carrying this marker are exempt from every check below. Placed on
// the line immediately before a fenced code block's opening fence, the
// marker exempts the whole block — a fence's content can't itself carry an
// HTML comment without corrupting the code (e.g. JSON has no comment
// syntax), so block-level exemption has to live outside the fence.
export const EXEMPT_LINE = /<!--\s*path-check:ignore\s*-->/;
const FENCE_LINE = /^\s*```/;

// Files skipped entirely. Empty by default; same shape as
// scan-identifiers.mjs's FILE_ALLOWLIST for a whole-file opt-out.
export const FILE_ALLOWLIST = new Set([]);

// Candidates matching any of these (once resolved to a repo-root-relative
// path) are excluded before existence-checking — never reported as
// failures, even if unresolved. Each entry is a false-positive class
// observed scanning the real tree, not a speculative guard:
export const EXCLUDE_PATTERNS = [
  /^\.claude\//, // runtime session state, correctly absent from the repo
  /(^|\/)\.env$/, // operator-created, correctly absent from the repo
  /(^|\/)dist(\/|$)/, // build output, correctly absent from the repo
  /^config\//, // the deployed config tree, not this repository
];

// A candidate must start with one of these to be treated as a repo path
// worth checking at all. This is what keeps prose slashes (URLs, shell
// flags like `req/res`, "on/off") out of the candidate set — real
// top-level repo entries are specific enough that false hits here are
// vanishingly unlikely. Relative `./` / `../` links are handled
// separately, scoped to actual markdown link syntax (see LINK_PATTERN
// below) since outside that context a bare "../foo" in prose is usually
// a shell example, not a link.
const TOP_LEVEL_ENTRIES = [
  'scripts/',
  'packages/',
  'config-template/',
  'config/',
  'skills/',
  'docs/',
  'installers/',
  'docker/',
  '.github/',
];

// A path-shaped token anywhere in a line's raw text: markdown link target,
// inline code span, fenced code block content, or plain prose — all read
// the same way. Deliberately excludes characters that mark glob syntax,
// placeholders, or URL scheme separators, so those never enter the
// candidate set in the first place.
const TOKEN_PATTERN = /[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)+/g;
const NON_LITERAL_CHARS = /[*?<>{}$]/;

const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function isRelativeLink(candidate) {
  return candidate.startsWith('./') || candidate.startsWith('../');
}

function looksLikeRepoPath(candidate) {
  return TOP_LEVEL_ENTRIES.some((prefix) => candidate.startsWith(prefix));
}

export function isExcluded(candidate) {
  return EXCLUDE_PATTERNS.some((re) => re.test(candidate));
}

// Strips a `:line` / `:start-end` suffix, a `#anchor`, and any run of
// trailing prose punctuation — the decoration a path picks up from being
// embedded in a sentence or a "file.md:101" style reference, none of which
// is part of the path itself.
export function normalizeToken(raw) {
  let c = raw;
  if (c.startsWith('<') && c.endsWith('>')) c = c.slice(1, -1);
  c = c.split('#')[0];
  c = c.replace(/:\d+(-\d+)?$/, '');
  c = c.replace(/[.,;:!?)\]'"]+$/, '');
  return c;
}

export function extractCandidates(line) {
  const candidates = new Set();

  TOKEN_PATTERN.lastIndex = 0;
  let m;
  while ((m = TOKEN_PATTERN.exec(line))) {
    const token = normalizeToken(m[0]);
    if (!token || NON_LITERAL_CHARS.test(token)) continue;
    if (token.includes('..')) continue;
    if (looksLikeRepoPath(token)) candidates.add(token);
  }

  LINK_PATTERN.lastIndex = 0;
  while ((m = LINK_PATTERN.exec(line))) {
    const raw = m[1];
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('mailto:'))
      continue;
    const target = normalizeToken(raw.trim());
    if (!target || NON_LITERAL_CHARS.test(target)) continue;
    if (isRelativeLink(target)) candidates.add(target);
  }

  return [...candidates];
}

// Resolves a candidate to a repo-root-relative path. `./`/`../` candidates
// are relative markdown links, resolved against the referencing file's own
// directory (standard relative-link semantics); everything else already
// starts with a top-level repo entry and is repo-root-relative as written.
export function resolveCandidate(candidate, mdFile) {
  if (!isRelativeLink(candidate)) return candidate;
  const resolved = posix.normalize(posix.join(dirname(mdFile), candidate));
  return resolved === '.' ? '' : resolved;
}

function pathResolves(resolved, trackedSet, trackedDirPrefixes) {
  if (resolved.endsWith('/')) return trackedDirPrefixes.has(resolved);
  return trackedSet.has(resolved) || trackedDirPrefixes.has(resolved + '/');
}

export function checkFile(content, mdFile, trackedSet, trackedDirPrefixes) {
  const failures = [];
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let fenceExempt = false;
  lines.forEach((line, idx) => {
    if (FENCE_LINE.test(line)) {
      if (!inFence) {
        inFence = true;
        fenceExempt = EXEMPT_LINE.test(line);
        if (!fenceExempt) {
          let i = idx - 1;
          while (i >= 0 && lines[i].trim() === '') i--;
          if (i >= 0) fenceExempt = EXEMPT_LINE.test(lines[i]);
        }
      } else {
        inFence = false;
        fenceExempt = false;
      }
      return;
    }
    if (inFence && fenceExempt) return;
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
