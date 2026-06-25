#!/usr/bin/env node
/**
 * migrate-host.mjs — migrate the orchestrator SQLite DB from one host to another
 * (Windows → Linux for the Ubuntu cutover).
 *
 * What it does:
 *   1. Produces a single self-contained DB file via `VACUUM INTO` — folds the
 *      WAL tail into one file, so copying it to the new host can't lose writes
 *      (the live DB is dashboard.db + -wal + -shm; copying dashboard.db alone
 *      while WAL-mode loses the tail).
 *   2. Rewrites `projects.project_dir` from the source host root to the target
 *      host root, canonicalising Windows path forms (`C:\…`, `C:/…`, Git-Bash
 *      `/c/…`) before the prefix swap.
 *   3. Leaves `sessions.worktree_path` AS-IS — worktrees stay on the old host
 *      and nothing should be active at cutover (see the --force gate below).
 *   4. Verifies row-count parity (sessions / session_events / pull_requests) and
 *      that no `project_dir` retains a Windows path. Exits non-zero on failure.
 *
 * Idempotent (re-running reproduces the same dest) and dry-runnable. The source
 * DB is only ever READ — never mutated.
 *
 * Usage:
 *   node scripts/migrate-host.mjs --to-root <linux-projects-root> [options]
 *
 * Options:
 *   --db <path>         Source DB (default: packages/backend/dashboard.db)
 *   --out <path>        Dest DB     (default: <db dir>/dashboard.migrated.db)
 *   --to-root <path>    REQUIRED. Projects root on the target host
 *                       (e.g. /home/orchestrator/IdeaProjects)
 *   --from-root <path>  Source projects root (default: C:/Users/phadek/IdeaProjects)
 *   --dry-run           Report planned changes; write nothing. Read-only — safe
 *                       to run while the orchestrator is up.
 *   --force             Proceed even if the source has active ('running')
 *                       sessions. Without it, the script refuses (the cutover
 *                       must happen with no active sessions).
 */

import Database from 'better-sqlite3';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { dryRun: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--to-root') args.toRoot = argv[++i];
    else if (a === '--from-root') args.fromRoot = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

/** Canonicalise a Windows-ish path: backslashes → slashes, Git-Bash /c/ → C:/. */
function canonicalizeWin(p) {
  let s = String(p).replace(/\\/g, '/');
  const m = s.match(/^\/([a-zA-Z])\/(.*)$/); // /c/Users/... → C:/Users/...
  if (m) s = `${m[1].toUpperCase()}:/${m[2]}`;
  return s;
}

const stripTrailingSlash = (s) => s.replace(/\/+$/, '');

/** Compute the rewritten project_dir, or null if it doesn't sit under fromRoot. */
function rewriteDir(dir, fromRoot, toRoot) {
  const c = canonicalizeWin(dir);
  const fr = stripTrailingSlash(canonicalizeWin(fromRoot));
  const to = stripTrailingSlash(toRoot);
  const lc = c.toLowerCase();
  const lfr = fr.toLowerCase();
  if (lc === lfr) return to;
  if (lc.startsWith(lfr + '/')) return `${to}/${c.slice(fr.length + 1)}`;
  return null;
}

/** Any remaining Windows drive/Git-Bash prefix after rewrite is a failure. */
const WIN_PATH_RE = /^([a-zA-Z]:[\\/]|\/[a-zA-Z]\/)/;

const TABLES = ['sessions', 'session_events', 'pull_requests'];

function counts(db) {
  const out = {};
  for (const t of TABLES)
    out[t] = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n;
  return out;
}

function main() {
  const args = parseArgs(process.argv);

  const dbPath = args.db ?? 'packages/backend/dashboard.db';
  if (!existsSync(dbPath)) {
    console.error(`Source DB not found: ${dbPath}`);
    process.exit(2);
  }
  if (!args.toRoot) {
    console.error(
      '--to-root is required (e.g. --to-root /home/orchestrator/IdeaProjects)',
    );
    process.exit(2);
  }
  if (/Program Files[\\/]Git[\\/]/i.test(args.toRoot)) {
    console.error(
      `--to-root looks MSYS-mangled by Git Bash: "${args.toRoot}".\n` +
        'A POSIX target path was rewritten with the Git install prefix. Re-run with\n' +
        'MSYS_NO_PATHCONV=1 (or a leading // ), or run from PowerShell, so the literal\n' +
        'Linux path reaches the script.',
    );
    process.exit(2);
  }
  const fromRoot = args.fromRoot ?? 'C:/Users/phadek/IdeaProjects';
  const outPath =
    args.out ?? path.join(path.dirname(dbPath), 'dashboard.migrated.db');

  const src = new Database(dbPath, { readonly: args.dryRun });

  // ── Safety gate: refuse to migrate with active sessions ────────────────────
  const running = src
    .prepare(
      "SELECT session_id, project_id, session_type FROM sessions WHERE status = 'running'",
    )
    .all();
  if (running.length > 0) {
    console.error(
      `\n⚠ ${running.length} active ('running') session(s) in the source DB:`,
    );
    for (const r of running)
      console.error(
        `    ${r.session_id.slice(0, 8)} ${r.project_id} ${r.session_type}`,
      );
    if (!args.force && !args.dryRun) {
      console.error(
        '\nRefusing to migrate with active sessions (worktrees would be orphaned and\n' +
          'the new host would resume them against stale paths). Quiesce the orchestrator\n' +
          'and conclude these sessions first, or pass --force if you know what you are doing.',
      );
      process.exit(1);
    }
    if (!args.dryRun)
      console.error('--force given; proceeding despite active sessions.\n');
  }

  // ── Plan the project_dir rewrites ──────────────────────────────────────────
  const projects = src
    .prepare('SELECT id, name, project_dir FROM projects')
    .all();
  const plan = [];
  for (const p of projects) {
    const next = rewriteDir(p.project_dir, fromRoot, args.toRoot);
    plan.push({ id: p.id, from: p.project_dir, to: next });
  }

  console.log(`Source DB : ${dbPath}`);
  console.log(`From root : ${fromRoot}`);
  console.log(`To root   : ${args.toRoot}`);
  console.log(
    `Dest DB   : ${args.dryRun ? '(dry-run — not written)' : outPath}`,
  );
  console.log(`\nproject_dir rewrites:`);
  for (const r of plan) {
    if (r.to === null)
      console.log(`  • ${r.id}: (unchanged — not under from-root) ${r.from}`);
    else console.log(`  • ${r.id}:\n      ${r.from}\n   →  ${r.to}`);
  }
  const srcCounts = counts(src);
  console.log(`\nrow counts (source): ${JSON.stringify(srcCounts)}`);

  if (args.dryRun) {
    const wouldRemain = plan.filter(
      (r) => r.to === null && WIN_PATH_RE.test(canonicalizeWin(r.from)),
    );
    if (wouldRemain.length) {
      console.log(
        `\n⚠ ${wouldRemain.length} project_dir(s) look like Windows paths but would NOT be ` +
          `rewritten (not under --from-root). Check --from-root: ${wouldRemain.map((r) => r.id).join(', ')}`,
      );
    }
    console.log('\nDry run complete — no changes written.');
    src.close();
    return;
  }

  // ── Produce the self-contained dest via VACUUM INTO ────────────────────────
  if (existsSync(outPath)) rmSync(outPath); // VACUUM INTO requires a non-existent target
  src.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  src.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
  src.close();

  // ── Rewrite project_dir on the dest ────────────────────────────────────────
  const dst = new Database(outPath);
  const upd = dst.prepare(
    'UPDATE projects SET project_dir = @to WHERE id = @id',
  );
  const tx = dst.transaction(() => {
    for (const r of plan)
      if (r.to !== null && r.to !== r.from) upd.run({ id: r.id, to: r.to });
  });
  tx();

  // ── Verify ─────────────────────────────────────────────────────────────────
  const dstCounts = counts(dst);
  const parityOk = TABLES.every((t) => srcCounts[t] === dstCounts[t]);
  const leftover = dst
    .prepare('SELECT id, project_dir FROM projects')
    .all()
    .filter((p) => WIN_PATH_RE.test(canonicalizeWin(p.project_dir)));
  dst.close();

  console.log(`\nrow counts (dest)  : ${JSON.stringify(dstCounts)}`);
  console.log(`parity             : ${parityOk ? 'OK' : 'MISMATCH'}`);
  console.log(
    `windows paths left : ${leftover.length === 0 ? 'none' : leftover.map((p) => p.id).join(', ')}`,
  );

  if (!parityOk || leftover.length > 0) {
    console.error(
      '\n✗ Verification failed — dest DB is NOT safe to cut over to.',
    );
    process.exit(1);
  }
  console.log(`\n✓ Migration complete: ${outPath}`);
  console.log(
    '  Copy it to the target host as the orchestrator DB, then boot there and verify.',
  );
}

main();
