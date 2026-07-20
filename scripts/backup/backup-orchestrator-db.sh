#!/usr/bin/env bash
#
# backup-orchestrator-db.sh
#
# Off-box backup of the orchestrator SQLite database (dashboard.db).
#
# Modeled on the Polymarket backup pattern (already stood up and restore-verified):
#   1. take a WAL-safe, read-consistent SQLite `.backup` snapshot of the live DB,
#   2. integrity-check and gzip it,
#   3. ship it off-box to Backblaze B2 via rclone,
#   4. prune both the local staging copy and the remote copy beyond RETENTION_DAYS.
#
# Runs under the paulie runtime user — never root — against the checkout-owned DB.
# `sqlite3 .backup` is safe against the live WAL and does not require stopping the
# backend: it copies a read-consistent snapshot page-by-page while writers continue.
#
# All tunables come from an off-repo, mode-600 env file (see backup.env.example).
# Nothing secret is baked into this script; it is safe to commit.

set -euo pipefail

log() { printf '%s [backup-orchestrator-db] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Config — load the off-repo env file, then apply defaults.
# `set -a` exports everything the env file sets so rclone picks up any
# RCLONE_CONFIG_* connection-string vars defined there.
# ---------------------------------------------------------------------------
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-$HOME/.config/orchestrator-backup/backup.env}"
if [[ -f "$BACKUP_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$BACKUP_ENV_FILE"; set +a
else
  die "env file not found: $BACKUP_ENV_FILE (copy scripts/backup/backup.env.example, chmod 600)"
fi

DB_PATH="${DB_PATH:-/srv/orchestrator/projects/claude-orchestrator/packages/backend/dashboard.db}"
BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-/srv/orchestrator/backups/orchestrator-db}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
B2_REMOTE="${B2_REMOTE:?B2_REMOTE not set in $BACKUP_ENV_FILE}"
B2_BUCKET="${B2_BUCKET:?B2_BUCKET not set in $BACKUP_ENV_FILE}"
B2_PREFIX="${B2_PREFIX:-dashboard-db}"

REMOTE_DEST="${B2_REMOTE}:${B2_BUCKET}/${B2_PREFIX}"

# ---------------------------------------------------------------------------
# Preflight.
# ---------------------------------------------------------------------------
command -v sqlite3 >/dev/null || die "sqlite3 not found on PATH"
command -v rclone  >/dev/null || die "rclone not found on PATH"
command -v gzip    >/dev/null || die "gzip not found on PATH"
[[ -f "$DB_PATH" ]] || die "source DB not found: $DB_PATH"
[[ "$(id -u)" -ne 0 ]] || die "refusing to run as root — run as the paulie runtime user"

mkdir -p "$BACKUP_LOCAL_DIR"

# Single-run lock so a slow upload never overlaps the next timer firing.
exec 9>"$BACKUP_LOCAL_DIR/.backup.lock"
flock -n 9 || die "another backup run holds the lock — skipping this firing"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$BACKUP_LOCAL_DIR/dashboard-${STAMP}.db"
ARCHIVE="${DUMP}.gz"

cleanup() { rm -f "$DUMP"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. WAL-safe consistent snapshot.
# ---------------------------------------------------------------------------
log "snapshotting $DB_PATH -> $DUMP"
sqlite3 "$DB_PATH" ".backup '$DUMP'" || die "sqlite3 .backup failed"

# 2. Verify the snapshot before we trust it off-box.
log "integrity check"
result="$(sqlite3 "$DUMP" 'PRAGMA integrity_check;')"
[[ "$result" == "ok" ]] || die "integrity_check failed: $result"

# 3. Compress.
log "compressing -> $ARCHIVE"
gzip -f "$DUMP"                 # produces $ARCHIVE, removes $DUMP
trap 'rm -f "$DUMP" "$ARCHIVE"' EXIT   # keep the archive only until it ships
bytes="$(stat -c %s "$ARCHIVE")"
log "archive ready: $ARCHIVE (${bytes} bytes)"

# ---------------------------------------------------------------------------
# 4. Ship off-box.
# ---------------------------------------------------------------------------
log "uploading to ${REMOTE_DEST}/"
rclone copyto "$ARCHIVE" "${REMOTE_DEST}/$(basename "$ARCHIVE")" \
  --b2-hard-delete --no-traverse || die "rclone upload failed"

# Confirm it actually landed (verify by listing + size).
remote_bytes="$(rclone size "${REMOTE_DEST}/$(basename "$ARCHIVE")" --json 2>/dev/null | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"
[[ "$remote_bytes" == "$bytes" ]] || die "remote size mismatch (local=$bytes remote=${remote_bytes:-missing})"
log "verified off-box copy: ${REMOTE_DEST}/$(basename "$ARCHIVE") (${remote_bytes} bytes)"

# The archive is safely off-box; keep local copies only for the retention window.
trap - EXIT

# ---------------------------------------------------------------------------
# 5. Retention — prune local and remote beyond the window.
# ---------------------------------------------------------------------------
log "pruning local dumps older than ${RETENTION_DAYS}d"
find "$BACKUP_LOCAL_DIR" -maxdepth 1 -name 'dashboard-*.db.gz' -type f \
  -mtime "+${RETENTION_DAYS}" -print -delete || true

log "pruning remote copies older than ${RETENTION_DAYS}d"
rclone delete "${REMOTE_DEST}/" --min-age "${RETENTION_DAYS}d" \
  --b2-hard-delete --include 'dashboard-*.db.gz' || die "remote prune failed"

log "done"
