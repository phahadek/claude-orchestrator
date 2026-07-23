#!/usr/bin/env node
/**
 * backup-database.mjs — online encrypted off-box backup of the orchestrator DB.
 *
 * Models the Polymarket project's proven backup pattern (already stood up and
 * restore-verified): snapshot → encrypt → rclone push to Backblaze B2 →
 * bounded local+remote retention.
 *
 * Pipeline:
 *   1. Snapshot — open a READ connection to the live DB (better-sqlite3) and
 *      call `.backup(destPath)`. This is WAL-safe and does not require
 *      stopping the backend or an idle DB (unlike `VACUUM INTO`, which
 *      scripts/migrate-host.mjs deliberately avoids for the same reason — see
 *      that script's header). Written to a timestamped temp file under
 *      --work-dir so a crash mid-run never clobbers a prior good snapshot.
 *   2. Encrypt — GPG symmetric encryption (AES256, `--batch --passphrase-fd`)
 *      before the file ever leaves disk. Chosen over an rclone crypt remote
 *      because it keeps the encrypted artifact self-contained and restorable
 *      with a single `gpg -d` + passphrase, independent of the transport
 *      config. The DB holds session/permission/token data — plaintext is
 *      never written to the work dir past step 1, and step 1's plaintext
 *      snapshot is removed as soon as encryption succeeds.
 *   3. Transport — `rclone copyto` the encrypted snapshot to a Backblaze B2
 *      bucket. Remote name/path and all credentials come from an off-repo,
 *      mode-600 env file (see --env-file) — nothing is read from the repo or
 *      committed.
 *   4. Retention — prune local temp snapshots and remote objects older than
 *      RETENTION_DAYS (default 14), by filename timestamp. Runs last so a
 *      failed prune never removes the copy this run just made (that upload
 *      is already excluded by age).
 *
 * Idempotency: each run's filename is stamped with the current time, so
 * retries create a new timestamped object rather than clobbering or
 * duplicating a prior *successful* upload; retention prunes by age, not by
 * run, so a retried run's earlier partial artifacts (if any) age out
 * normally rather than accumulating.
 *
 * Intended to run under a systemd timer as the `paulie` runtime user (never
 * root) against the checkout-owned DB, with an `OnFailure=` alerting unit —
 * every failure path below writes a clear message to stderr and exits
 * non-zero. Provisioning the B2 bucket/rclone remote, installing the systemd
 * timer, and running the first restore drill are separate, operator-present
 * follow-ons — out of scope here.
 *
 * Environment (from the process env or --env-file, in that precedence order
 * — process env wins so a timer's `Environment=` can override the file):
 *   DB_PATH            Source DB (default: ./dashboard.db)
 *   BACKUP_WORK_DIR     Local scratch dir for snapshots (default: /tmp/orchestrator-backup)
 *   BACKUP_GPG_PASSPHRASE   REQUIRED. Symmetric-encryption passphrase.
 *   RCLONE_REMOTE       REQUIRED. rclone remote:path to push to, e.g.
 *                       "b2:my-bucket/orchestrator-backups" (or a local dir
 *                       remote for dev testing, e.g. "/tmp/backup-remote").
 *   RCLONE_CONFIG       Optional — path to an rclone config file (passed as
 *                       `--config`) if not using the default `~/.config/rclone/rclone.conf`.
 *   RETENTION_DAYS      Optional — prune window (default: 14).
 *
 * Usage:
 *   node scripts/backup-database.mjs [--env-file <path>] [--dry-run]
 *
 * Options:
 *   --env-file <path>  Off-repo, mode-600 KEY=VALUE env file to load before
 *                       reading the environment variables above. Not
 *                       committed; not required if the process env already
 *                       has everything set (e.g. a systemd unit's Environment=).
 *   --dry-run          Snapshot + encrypt only; skip upload and prune. Local
 *                       temp files are cleaned up before exit.
 */

import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--env-file') args.envFile = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function fail(step, message) {
  console.error(`✗ [${step}] ${message}`);
  process.exit(1);
}

/** Parse a simple KEY=VALUE env file (no interpolation, no export keyword). */
function loadEnvFile(filePath) {
  if (!existsSync(filePath)) fail('env-file', `not found: ${filePath}`);
  const mode = statSync(filePath).mode & 0o777;
  if (mode & 0o077) {
    fail(
      'env-file',
      `${filePath} must be mode 600 (found ${mode.toString(8)}) — ` +
        `it holds credentials. Run: chmod 600 ${filePath}`,
    );
  }
  const text = readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** yyyymmdd-hhmmss-derived-safe timestamp for filenames, UTC. */
function timestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function runOrFail(step, cmd, cmdArgs, opts = {}) {
  const result = spawnSync(cmd, cmdArgs, { encoding: 'utf8', ...opts });
  if (result.error)
    fail(step, `${cmd} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      step,
      `${cmd} exited ${result.status}: ${result.stderr || result.stdout || '(no output)'}`,
    );
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.envFile) loadEnvFile(args.envFile);

  const dbPath = process.env.DB_PATH ?? './dashboard.db';
  const workDir = process.env.BACKUP_WORK_DIR ?? '/tmp/orchestrator-backup';
  const passphrase = process.env.BACKUP_GPG_PASSPHRASE;
  const remote = process.env.RCLONE_REMOTE;
  const rcloneConfig = process.env.RCLONE_CONFIG;
  const retentionDays = Number(process.env.RETENTION_DAYS ?? '14');

  if (!existsSync(dbPath)) fail('snapshot', `source DB not found: ${dbPath}`);
  if (!passphrase) fail('config', 'BACKUP_GPG_PASSPHRASE is required');
  if (!args.dryRun && !remote)
    fail('config', 'RCLONE_REMOTE is required (unless --dry-run)');
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    fail(
      'config',
      `RETENTION_DAYS must be a positive number, got: ${process.env.RETENTION_DAYS}`,
    );
  }

  mkdirSync(workDir, { recursive: true });

  const now = new Date();
  const stamp = timestamp(now);
  const snapshotName = `dashboard-${stamp}.db`;
  const snapshotPath = path.join(workDir, snapshotName);
  const encryptedName = `${snapshotName}.gpg`;
  const encryptedPath = path.join(workDir, encryptedName);

  // ── 1. Snapshot ──────────────────────────────────────────────────────────
  console.log(`[snapshot] ${dbPath} -> ${snapshotPath}`);
  try {
    const src = new Database(dbPath, { readonly: true });
    await src.backup(snapshotPath);
    src.close();
  } catch (err) {
    rmSync(snapshotPath, { force: true });
    fail('snapshot', err.message);
  }
  if (!existsSync(snapshotPath))
    fail('snapshot', 'backup() completed but no file was produced');

  // ── 2. Encrypt ───────────────────────────────────────────────────────────
  console.log(`[encrypt] ${snapshotPath} -> ${encryptedPath}`);
  rmSync(encryptedPath, { force: true });
  try {
    runOrFail(
      'encrypt',
      'gpg',
      [
        '--batch',
        '--yes',
        '--quiet',
        '--pinentry-mode',
        'loopback',
        '--passphrase-fd',
        '0',
        '--symmetric',
        '--cipher-algo',
        'AES256',
        '--output',
        encryptedPath,
        snapshotPath,
      ],
      { input: passphrase },
    );
  } finally {
    // Plaintext snapshot never survives past this step, success or failure.
    rmSync(snapshotPath, { force: true });
  }
  if (!existsSync(encryptedPath))
    fail('encrypt', 'gpg completed but no output file was produced');

  if (args.dryRun) {
    console.log(
      `[dry-run] encrypted snapshot left at ${encryptedPath} (upload/prune skipped)`,
    );
    return;
  }

  // ── 3. Transport ─────────────────────────────────────────────────────────
  const rcloneBaseArgs = rcloneConfig ? ['--config', rcloneConfig] : [];
  console.log(`[upload] ${encryptedPath} -> ${remote}/${encryptedName}`);
  runOrFail('upload', 'rclone', [
    ...rcloneBaseArgs,
    'copyto',
    encryptedPath,
    `${remote}/${encryptedName}`,
  ]);
  rmSync(encryptedPath, { force: true });

  // ── 4. Retention ─────────────────────────────────────────────────────────
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const isBackupFile = (name) => /^dashboard-.*\.db\.gpg$/.test(name);

  console.log(
    `[prune] local ${workDir}, remote ${remote} — older than ${retentionDays}d`,
  );
  for (const name of readdirSync(workDir)) {
    if (!isBackupFile(name)) continue;
    const filePath = path.join(workDir, name);
    if (statSync(filePath).mtimeMs < cutoff) {
      console.log(`[prune] removing stale local file ${name}`);
      rmSync(filePath, { force: true });
    }
  }

  const lsResult = runOrFail('prune', 'rclone', [
    ...rcloneBaseArgs,
    'lsjson',
    remote,
  ]);
  let remoteFiles;
  try {
    remoteFiles = JSON.parse(lsResult.stdout);
  } catch (err) {
    fail('prune', `could not parse rclone lsjson output: ${err.message}`);
  }
  for (const entry of remoteFiles) {
    if (!isBackupFile(entry.Name)) continue;
    const modTime = Date.parse(entry.ModTime);
    if (Number.isFinite(modTime) && modTime < cutoff) {
      console.log(`[prune] removing stale remote object ${entry.Name}`);
      runOrFail('prune', 'rclone', [
        ...rcloneBaseArgs,
        'deletefile',
        `${remote}/${entry.Name}`,
      ]);
    }
  }

  console.log(`✓ backup complete: ${encryptedName}`);
}

main().catch((err) => fail('unhandled', err.stack ?? String(err)));
