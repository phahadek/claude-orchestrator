#!/usr/bin/env node
/**
 * prune-session-branches.mjs — Backfill pruning of legacy session/<uuid> branches.
 *
 * Lists all local session/* branches in a project git repo, joins each to the
 * sessions DB row by the UUID extracted from the branch name, applies the prune
 * gate, and deletes (or lists with --dry-run) the eligible branches.
 *
 * Gate (mirrors the active-prune logic in SessionManager.ts):
 *   session row status IN (done, error, killed)
 *   AND (no pr_url OR pull_request.state IN (merged, closed))
 *
 * Branches with no matching sessions row are skipped with a warning.
 * dev and main are always guarded (defense-in-depth; pattern shouldn't collide).
 *
 * Usage:
 *   node scripts/prune-session-branches.mjs [options]
 *
 * Options:
 *   --dry-run            List branches that would be deleted without deleting
 *   --project-dir <dir>  Path to the git project root (default: cwd)
 *   --db <path>          Path to dashboard.db (default: packages/backend/dashboard.db)
 */

import Database from 'better-sqlite3';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { argv, cwd, exit } from 'node:process';

// ── Arg parsing ────────────────────────────────────────────────────────────

const args = argv.slice(2);
let dryRun = false;
let projectDir = cwd();
let dbPath = resolve('packages/backend/dashboard.db');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') {
    dryRun = true;
  } else if (args[i] === '--project-dir' && args[i + 1]) {
    projectDir = resolve(args[++i]);
  } else if (args[i] === '--db' && args[i + 1]) {
    dbPath = resolve(args[++i]);
  }
}

console.log(`[prune-session-branches] project-dir=${projectDir}`);
console.log(`[prune-session-branches] db=${dbPath}`);
console.log(`[prune-session-branches] dry-run=${dryRun}`);

// ── Constants ──────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['done', 'error', 'killed']);
const ALWAYS_GUARDED = new Set(['dev', 'main']);

// ── Open DB ────────────────────────────────────────────────────────────────

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (err) {
  console.error(`[prune-session-branches] failed to open DB at ${dbPath}: ${err}`);
  exit(1);
}

// ── Prepared statements ────────────────────────────────────────────────────

const stmtGetSession = db.prepare(
  `SELECT session_id, status, pr_url FROM sessions WHERE session_id = ?`,
);

const stmtGetPRBySessionId = db.prepare(
  `SELECT state FROM pull_requests WHERE session_id = ? LIMIT 1`,
);

// ── List local session/* branches ─────────────────────────────────────────

let branchOutput;
try {
  branchOutput = execSync(`git branch --list "session/*"`, {
    cwd: projectDir,
    encoding: 'utf8',
  });
} catch (err) {
  console.error(`[prune-session-branches] git branch --list failed: ${err}`);
  exit(1);
}

const branches = branchOutput
  .split('\n')
  .map((line) => line.replace(/^\*?\s+/, '').trim())
  .filter((b) => b.startsWith('session/'));

if (branches.length === 0) {
  console.log('[prune-session-branches] no session/* branches found — nothing to do');
  exit(0);
}

console.log(`[prune-session-branches] found ${branches.length} session/* branch(es)`);

// ── Apply gate and prune ───────────────────────────────────────────────────

let pruned = 0;
let kept = 0;
let skipped = 0;

for (const branch of branches) {
  // defense-in-depth: never touch dev or main
  if (ALWAYS_GUARDED.has(branch)) {
    console.log(`[prune-session-branches] guarded — skipping ${branch}`);
    skipped++;
    continue;
  }

  const sessionId = branch.replace(/^session\//, '');

  // Look up sessions row
  const row = stmtGetSession.get(sessionId);
  if (!row) {
    console.warn(`[prune-session-branches] no sessions row for ${branch} — skipping`);
    skipped++;
    continue;
  }

  // Gate: terminal status
  if (!TERMINAL_STATUSES.has(row.status)) {
    console.log(`[prune-session-branches] active session (${row.status}) — keeping ${branch}`);
    kept++;
    continue;
  }

  // Gate: open PR
  if (row.pr_url) {
    const prRow = stmtGetPRBySessionId.get(sessionId);
    if (!prRow || prRow.state === 'open') {
      console.log(`[prune-session-branches] open PR — keeping ${branch}`);
      kept++;
      continue;
    }
  }

  // Eligible for pruning
  if (dryRun) {
    console.log(`[prune-session-branches] would delete ${branch} (status=${row.status})`);
    pruned++;
    continue;
  }

  try {
    execSync(`git branch -D "${branch}"`, { cwd: projectDir });
    console.log(`[prune-session-branches] deleted ${branch}`);
    pruned++;
  } catch (err) {
    console.error(`[prune-session-branches] failed to delete ${branch}: ${err}`);
    skipped++;
  }
}

// ── Summary ────────────────────────────────────────────────────────────────

const action = dryRun ? 'would delete' : 'deleted';
console.log(
  `[prune-session-branches] done — ${action} ${pruned}, kept ${kept}, skipped ${skipped}`,
);
