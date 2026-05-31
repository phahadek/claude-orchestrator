#!/usr/bin/env node
/**
 * prune-feature-branches.mjs — Backfill pruner for feature/* branches.
 *
 * Lists all local feature/* branches, checks each against PR state, and
 * deletes those whose PR is merged or closed. Protected branches (dev, main)
 * and branches with open PRs are never deleted.
 *
 * PR-state lookup order:
 *   1. DB (pull_requests.head_branch column)
 *   2. GitHub API fallback (GET /repos/{owner}/{repo}/pulls?head={ref}&state=all)
 *   3. Conservative skip with warning if neither source has a record.
 *
 * Usage:
 *   node scripts/prune-feature-branches.mjs [--dry-run] [--db <path>] [--repo <owner/repo>]
 *
 * Options:
 *   --dry-run   List branches that would be pruned without deleting anything.
 *   --db        Path to SQLite DB (default: packages/backend/dashboard.db).
 *   --repo      GitHub repo slug "owner/repo" (default: $GITHUB_REPO env var).
 *
 * Environment:
 *   GITHUB_TOKEN   Required for GitHub API fallback lookups.
 *   GITHUB_REPO    Fallback repo if --repo is not provided.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { argv, env } from 'node:process';
import Database from 'better-sqlite3';

// ── Arg parsing ────────────────────────────────────────────────────────────

const args = argv.slice(2);
let dryRun = false;
let dbPath = 'packages/backend/dashboard.db';
let repoArg = env.GITHUB_REPO ?? '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') {
    dryRun = true;
  } else if (args[i] === '--db' && args[i + 1]) {
    dbPath = args[++i];
  } else if (args[i] === '--repo' && args[i + 1]) {
    repoArg = args[++i];
  }
}

const GITHUB_TOKEN = env.GITHUB_TOKEN ?? '';
const PROTECTED_BRANCHES = new Set(['dev', 'main', 'master']);

// ── Helpers ────────────────────────────────────────────────────────────────

function listLocalFeatureBranches() {
  const out = execSync('git branch --list "feature/*"', {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((l) => l.replace(/^\*?\s+/, '').trim())
    .filter((l) => l.length > 0);
}

function deleteLocalBranch(branch) {
  execSync(`git branch -D "${branch}"`);
}

function deleteOriginBranch(repo, branch) {
  const url = `https://api.github.com/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`;
  const res = execSync(
    `curl -s -o /dev/null -w "%{http_code}" -X DELETE ` +
      `-H "Authorization: Bearer ${GITHUB_TOKEN}" ` +
      `-H "Accept: application/vnd.github+json" ` +
      `-H "X-GitHub-Api-Version: 2022-11-28" ` +
      `"${url}"`,
    { encoding: 'utf8' },
  );
  const status = parseInt(res.trim(), 10);
  if (status !== 204 && status !== 422) {
    // 422 = ref not found (already deleted) — treat as success
    throw new Error(`DELETE origin branch ${branch} returned HTTP ${status}`);
  }
}

async function fetchPRStateFromGitHub(repo, branch) {
  if (!GITHUB_TOKEN) return null;
  const owner = repo.split('/')[0];
  const url =
    `https://api.github.com/repos/${repo}/pulls` +
    `?head=${encodeURIComponent(owner + ':' + branch)}&state=all&per_page=1`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const pr = data[0];
  if (pr.merged_at) return 'merged';
  return pr.state; // 'open' | 'closed'
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(dbPath)) {
    console.error(`[prune-feature-branches] DB not found: ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const stmtByHeadBranch = db.prepare(
    `SELECT state, pr_url FROM pull_requests WHERE head_branch = ? ORDER BY id DESC LIMIT 1`,
  );

  const branches = listLocalFeatureBranches();
  if (branches.length === 0) {
    console.log('[prune-feature-branches] No local feature/* branches found.');
    return;
  }

  console.log(
    `[prune-feature-branches] Found ${branches.length} local feature/* branch(es).` +
      (dryRun ? ' [DRY RUN]' : ''),
  );

  let pruned = 0;
  let skipped = 0;
  let kept = 0;

  for (const branch of branches) {
    if (PROTECTED_BRANCHES.has(branch)) {
      console.log(`  KEEP  ${branch}  (protected)`);
      kept++;
      continue;
    }

    // DB-first lookup
    let prState = null;
    const dbRow = stmtByHeadBranch.get(branch);
    if (dbRow) {
      prState = dbRow.state; // 'open' | 'merged' | 'closed'
    }

    // GitHub API fallback
    if (!prState && repoArg) {
      prState = await fetchPRStateFromGitHub(repoArg, branch);
      if (prState) {
        console.log(`  ${branch}  [DB miss — GitHub API: ${prState}]`);
      }
    }

    if (!prState) {
      console.warn(
        `  SKIP  ${branch}  (warning: no PR record in DB or GitHub — skipping conservatively)`,
      );
      skipped++;
      continue;
    }

    if (prState === 'open') {
      console.log(`  KEEP  ${branch}  (PR is open)`);
      kept++;
      continue;
    }

    // merged or closed → prune
    console.log(`  PRUNE ${branch}  (PR state: ${prState})`);
    if (!dryRun) {
      if (repoArg) {
        try {
          deleteOriginBranch(repoArg, branch);
        } catch (err) {
          console.warn(`  [warn] deleteOriginBranch ${branch}: ${err.message}`);
        }
      }
      try {
        deleteLocalBranch(branch);
      } catch (err) {
        console.warn(`  [warn] deleteLocalBranch ${branch}: ${err.message}`);
      }
    }
    pruned++;
  }

  db.close();
  console.log(
    `\n[prune-feature-branches] Done.` +
      ` pruned=${pruned} kept=${kept} skipped=${skipped}` +
      (dryRun ? ' [DRY RUN — no branches deleted]' : ''),
  );
}

main().catch((err) => {
  console.error('[prune-feature-branches] Fatal:', err);
  process.exit(1);
});
