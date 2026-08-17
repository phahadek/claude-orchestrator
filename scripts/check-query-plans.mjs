#!/usr/bin/env node
// scripts/check-query-plans.mjs
//
// CI-safe check: extracts every static SQL statement embedded as a backtick
// template literal in packages/backend/src, plans it with
// `EXPLAIN QUERY PLAN` against a fresh empty schema (built by the real
// runMigrations() migration chain, so it always reflects deployed indexes),
// and fails when a statement performs a full table scan that isn't in the
// checked-in accepted baseline below.
//
// Why an empty schema: query plans are structural — they depend on which
// indexes exist, not on how many rows are in a table — so an empty,
// freshly-migrated SQLite database is sufficient to plan every statement and
// keeps this check hermetic (no live/sample database, no seed data). The
// trade-off is that this check cannot weight a scan by real row count; a
// scan on a table that happens to stay small in production still needs an
// ACCEPTED_SCANS entry below (with that reasoning stated), same as any
// other legitimate scan.
//
// Known blind spots (see also the run summary this script prints):
//   - Interpolated SQL (any template literal containing `${`) cannot be
//     planned statically and is invisible to this check. It only catches
//     regressions in static SQL.
//   - Statements whose parameter shape the dummy binder can't satisfy are
//     skipped rather than guessed at. The skip count is printed on every
//     run so a growing count is visible instead of silently swallowed.
//
// Exit code 0 = clean; 1 = a new (unaccepted) table scan was found.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BACKEND_DIR = join(REPO_ROOT, 'packages', 'backend');
export const SRC_DIR = join(BACKEND_DIR, 'src');

// ── Accepted baseline ────────────────────────────────────────────────────
//
// Every table scan detected as of deployed SHA
// efb9abb9bf5ad82a7d63cf453b8cda89b735cccb, keyed by `<file-relative-to-src>:<line>`
// (the line of the opening backtick of the template literal). Each entry
// must carry a `reason` — an entry added without one is a table scan being
// waved through with no stated justification, which fails review on
// inspection (mirrors scan-identifiers.mjs's FILE_ALLOWLIST convention: the
// exemption lives next to the check, not in a separate baseline artifact).
//
// To accept a *new* scan: run `npm run check:query-plans`, copy the
// `file:line` the failure prints, and add an entry here with a reason. This
// goes through ordinary PR review — no separate approval gate.
// Reason strings reused across entries in the same category below.
const REASON_CATALOG =
  "sqlite_master is SQLite's internal schema catalog, not application data — always trivial size.";
const REASON_BOUNDED =
  'Table cardinality is bounded by the number of projects/milestones/devices/branches/PRs/etc. ' +
  'this orchestrator manages (operator/registry scale), not by request volume — a full scan ' +
  'stays cheap as usage grows, unlike the per-event tables behind the cited incidents.';
const REASON_ADMIN =
  'Runs on an infrequent admin, maintenance, or boot-time path (not the per-request hot path ' +
  'behind the cited incidents), so scan cost does not compound with usage.';
const REASON_DEBT =
  'Pre-existing unindexed lookup against a table that grows with usage — the same defect class ' +
  'this check targets, but indexing it is out of scope for this CI-guard task. Accepted into the ' +
  'baseline as tracked debt (not cleared as legitimate) so the guard can ship without blocking on ' +
  'an unrelated index migration; follow-up indexing is tracked separately.';
const REASON_JSON_EACH =
  'json_each() is a table-valued function over an in-row JSON array, not a stored table — there is ' +
  'no index to add, and its "table" only ever has as many rows as that one JSON array.';

const ACCEPTED_SCANS = new Map([
  ['db/assertDatabaseSchema.ts:19', { reason: REASON_CATALOG }],
  ['db/db.ts:200', { reason: REASON_ADMIN }],
  ['db/queries.ts:420', { reason: REASON_DEBT }],
  ['db/queries.ts:491', { reason: REASON_DEBT }],
  ['db/queries.ts:661', { reason: REASON_DEBT }],
  ['db/queries.ts:844', { reason: REASON_DEBT }],
  ['db/queries.ts:863', { reason: REASON_DEBT }],
  ['db/queries.ts:887', { reason: REASON_DEBT }],
  ['db/queries.ts:963', { reason: REASON_ADMIN }],
  ['db/queries.ts:1021', { reason: REASON_ADMIN }],
  ['db/queries.ts:1056', { reason: REASON_DEBT }],
  ['db/queries.ts:2089', { reason: REASON_ADMIN }],
  ['db/queries.ts:2128', { reason: REASON_ADMIN }],
  ['db/queries.ts:2207', { reason: REASON_ADMIN }],
  ['db/queries.ts:2427', { reason: REASON_ADMIN }],
  ['db/queries.ts:2463', { reason: REASON_DEBT }],
  ['db/queries.ts:3168', { reason: REASON_DEBT }],
  ['db/queries.ts:3230', { reason: REASON_BOUNDED }],
  ['db/queries.ts:3535', { reason: REASON_DEBT }],
  ['db/queries.ts:3560', { reason: REASON_DEBT }],
  ['db/queries.ts:3586', { reason: REASON_DEBT }],
  ['db/queries.ts:3683', { reason: REASON_BOUNDED }],
  ['db/queries.ts:3708', { reason: REASON_DEBT }],
  ['db/queries.ts:3740', { reason: REASON_DEBT }],
  ['db/queries.ts:3760', { reason: REASON_DEBT }],
  ['db/queries.ts:3787', { reason: REASON_DEBT }],
  ['db/queries.ts:3818', { reason: REASON_DEBT }],
  ['db/queries.ts:4143', { reason: REASON_BOUNDED }],
  ['db/queries.ts:4272', { reason: REASON_BOUNDED }],
  ['db/queries.ts:4338', { reason: REASON_BOUNDED }],
  ['db/queries.ts:4439', { reason: REASON_BOUNDED }],
  ['db/queries.ts:4476', { reason: REASON_BOUNDED }],
  ['db/queries.ts:4498', { reason: REASON_BOUNDED }],
  ['db/queries.ts:4561', { reason: REASON_BOUNDED }],
  ['db/queries.ts:4816', { reason: REASON_BOUNDED }],
  ['db/queries.ts:4852', { reason: REASON_BOUNDED }],
  ['db/queries.ts:5219', { reason: REASON_BOUNDED }],
  ['db/queries.ts:5463', { reason: REASON_BOUNDED }],
  ['db/queries.ts:5499', { reason: REASON_BOUNDED }],
  ['db/queries.ts:5952', { reason: REASON_ADMIN }],
  ['db/queries.ts:6173', { reason: REASON_BOUNDED }],
  ['db/queries.ts:6451', { reason: REASON_BOUNDED }],
  ['db/queries.ts:6844', { reason: REASON_BOUNDED }],
  ['db/queries.ts:6874', { reason: REASON_BOUNDED }],
  ['db/queries.ts:7234', { reason: REASON_BOUNDED }],
  ['db/queries.ts:8062', { reason: REASON_DEBT }],
  ['db/queries.ts:8553', { reason: REASON_DEBT }],
  ['db/queries.ts:8735', { reason: REASON_DEBT }],
  ['db/queries.ts:8847', { reason: REASON_DEBT }],
  ['db/queries.ts:8901', { reason: REASON_DEBT }],
  ['db/queries.ts:9140', { reason: REASON_DEBT }],
  ['db/queries.ts:9174', { reason: REASON_DEBT }],
  ['db/queries.ts:9301', { reason: REASON_DEBT }],
  ['db/queries.ts:9326', { reason: REASON_DEBT }],
  ['db/queries.ts:10152', { reason: REASON_BOUNDED + ' ' + REASON_JSON_EACH }],
  ['investigation/investigationReconciler.ts:31', { reason: REASON_ADMIN }],
  ['investigation/reportStore.ts:321', { reason: REASON_ADMIN }],
]);

// Whole files excluded from scanning entirely (e.g. one-off migration/backfill
// scripts that intentionally scan a table once, not on the request path).
const FILE_ALLOWLIST = new Set([
  // Migration/backfill SQL runs once, at startup, against whatever data
  // already exists — it is not a request-path lookup, so a scan here isn't
  // the "unindexed lookup against a table that grew" defect class this check
  // targets. Regressions in request-path query indexing are still caught in
  // queries.ts, which every runtime lookup goes through.
  'db/schema.ts',
]);

const TEST_DIR_SEGMENT = `${sep}__tests__${sep}`;

export function isExcludedFile(absPath) {
  if (absPath.includes(TEST_DIR_SEGMENT)) return true;
  if (absPath.endsWith('.test.ts')) return true;
  const relPath = relative(SRC_DIR, absPath).split(sep).join('/');
  if (FILE_ALLOWLIST.has(relPath)) return true;
  return false;
}

export function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs, out);
    } else if (entry.endsWith('.ts') && !isExcludedFile(abs)) {
      out.push(abs);
    }
  }
  return out;
}

const STATEMENT_START = /^(SELECT|UPDATE|DELETE|WITH|INSERT)\b/i;

// Finds backtick template literals in `content` that look like static SQL.
// Returns { sql, line } for each candidate; statements containing `${` are
// dynamic SQL and cannot be planned, so they are omitted here (the caller
// counts them separately as skips).
export function extractStatements(content) {
  const statements = [];
  const dynamicSkips = [];
  const templateRe = /`([^`]*)`/gs;
  let m;
  while ((m = templateRe.exec(content))) {
    const raw = m[1];
    const trimmed = raw.trim();
    if (!STATEMENT_START.test(trimmed)) continue;
    const line = content.slice(0, m.index).split('\n').length;
    if (raw.includes('${')) {
      dynamicSkips.push({ line });
      continue;
    }
    statements.push({ sql: raw, line });
  }
  return { statements, dynamicSkips };
}

// Builds dummy bind parameters for a statement using the prototype's binder
// rules: named `@x` placeholders bind to an object of 1s; positional `?`
// placeholders bind to an array of 1s. Mixed styles aren't supported by
// better-sqlite3 either, so a statement using both is left to fail to plan
// and gets counted as an unplannable skip like any other bind mismatch.
export function buildDummyParams(sql) {
  const named = [...new Set((sql.match(/@\w+/g) || []).map((s) => s.slice(1)))];
  if (named.length > 0) {
    const params = {};
    for (const name of named) params[name] = 1;
    return params;
  }
  const positionalCount = (sql.match(/\?/g) || []).length;
  if (positionalCount > 0) {
    return Array(positionalCount).fill(1);
  }
  return [];
}

const SCAN_RE = /^SCAN\s+(\S+)/;

// Returns the list of plan `detail` lines that are full table scans (a SCAN
// step lacking `USING` — an index-assisted scan carries `USING INDEX`/
// `USING COVERING INDEX` and is not a table scan).
export function findTableScans(planRows) {
  return planRows
    .map((row) => row.detail)
    .filter((detail) => SCAN_RE.test(detail) && !detail.includes('USING'));
}

// Plans one statement. Returns { scans } on success, or { unplannable: true }
// if the dummy params don't satisfy this statement's parameter shape.
export function planStatement(db, sql) {
  const params = buildDummyParams(sql);
  let stmt;
  try {
    stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  } catch {
    return { unplannable: true };
  }
  try {
    const rows = Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
    return { scans: findTableScans(rows) };
  } catch {
    return { unplannable: true };
  }
}

// Builds a fresh, empty in-memory schema by running the real migration chain
// (packages/backend/src/db/schema.ts:runMigrations) via ts-node, then
// replaying the resulting DDL into our own in-memory database. Going through
// the real migration function (rather than re-deriving DDL by hand) means
// this check can never drift from what production actually indexes.
export function buildSchemaDb() {
  const dumpScript = `
    const Database = require('better-sqlite3');
    const { runMigrations } = require('./src/db/schema');
    const db = new Database(':memory:');
    runMigrations(db);
    const rows = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index') AND name != 'sqlite_sequence'",
      )
      .all();
    process.stdout.write(JSON.stringify(rows));
  `;
  const output = execFileSync('npx', ['ts-node', '-e', dumpScript], {
    cwd: BACKEND_DIR,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const rows = JSON.parse(output);
  const db = new Database(':memory:');
  for (const { sql } of rows) {
    db.exec(sql);
  }
  return db;
}

export function baselineKey(relFile, line) {
  return `${relFile}:${line}`;
}

// Every accepted entry must carry a non-empty `reason` — this is the actual
// enforcement behind "an entry added without one fails review": it also
// fails the check itself, immediately, rather than relying purely on a
// reviewer noticing.
export function assertValidAcceptedScans(acceptedScans) {
  for (const [key, entry] of acceptedScans) {
    if (
      !entry ||
      typeof entry.reason !== 'string' ||
      entry.reason.trim() === ''
    ) {
      throw new Error(
        `ACCEPTED_SCANS entry "${key}" is missing a non-empty reason string.`,
      );
    }
  }
}

export function runCheck(
  db,
  files,
  acceptedScans = ACCEPTED_SCANS,
  baseDir = SRC_DIR,
) {
  const newScans = [];
  const acceptedHits = new Set();
  let dynamicSkipCount = 0;
  let unplannableSkipCount = 0;
  let plannedCount = 0;

  for (const absFile of files) {
    const relFile = relative(baseDir, absFile).split(sep).join('/');
    const content = readFileSync(absFile, 'utf-8');
    const { statements, dynamicSkips } = extractStatements(content);
    dynamicSkipCount += dynamicSkips.length;

    for (const { sql, line } of statements) {
      const result = planStatement(db, sql);
      if (result.unplannable) {
        unplannableSkipCount++;
        continue;
      }
      plannedCount++;
      if (result.scans.length === 0) continue;

      const key = baselineKey(relFile, line);
      if (acceptedScans.has(key)) {
        acceptedHits.add(key);
        continue;
      }
      newScans.push({ key, scans: result.scans });
    }
  }

  return {
    newScans,
    acceptedHits,
    dynamicSkipCount,
    unplannableSkipCount,
    plannedCount,
  };
}

function main() {
  assertValidAcceptedScans(ACCEPTED_SCANS);
  const files = walk(SRC_DIR);
  const db = buildSchemaDb();
  const result = runCheck(db, files);
  db.close();

  const totalSkips = result.dynamicSkipCount + result.unplannableSkipCount;
  console.log(
    `Planned ${result.plannedCount} statement(s); skipped ${totalSkips} ` +
      `(${result.dynamicSkipCount} dynamic SQL, ${result.unplannableSkipCount} unplannable).`,
  );
  console.log(
    `${result.acceptedHits.size}/${ACCEPTED_SCANS.size} accepted-baseline scan(s) matched.`,
  );

  const staleAccepted = [...ACCEPTED_SCANS.keys()].filter(
    (key) => !result.acceptedHits.has(key),
  );
  if (staleAccepted.length > 0) {
    console.log(
      `Note: ${staleAccepted.length} accepted-baseline entr${staleAccepted.length === 1 ? 'y is' : 'ies are'} ` +
        `no longer detected as a scan (statement moved, removed, or now index-assisted) — ` +
        `safe to delete from ACCEPTED_SCANS: ${staleAccepted.join(', ')}`,
    );
  }

  if (result.newScans.length > 0) {
    console.error(
      `\nFound ${result.newScans.length} table scan(s) not in the accepted baseline:`,
    );
    for (const { key, scans } of result.newScans) {
      console.error(`  ${key}`);
      for (const detail of scans) console.error(`    ${detail}`);
    }
    console.error(
      '\nIf this scan is intentional, add an entry to ACCEPTED_SCANS in ' +
        'scripts/check-query-plans.mjs with a reason and re-run.',
    );
    process.exit(1);
  }

  console.log('No new table scans found.');
}

if (process.argv[1] === __filename) {
  main();
}
