# Orchestrator DB Backup & Restore Runbook

Off-box backups of the orchestrator database (`dashboard.db`, SQLite/WAL) so the
architecture-information store and all orchestrator state survive host loss.

Modeled directly on the Polymarket backup pattern (already stood up and
restore-verified): a nightly, WAL-safe SQLite `.backup` snapshot, gzipped and
shipped to Backblaze B2 via `rclone`, driven by a jittered systemd timer, with a
bounded retention window pruned local + remote.

**Design invariants**

- Runs under the **paulie** runtime user — **never root**. The script refuses uid 0.
- Uses SQLite's `.backup` (a read-consistent snapshot), which is **safe against the
  live WAL** and does **not** require stopping the backend.
- The B2 application key lives only in an **off-repo, mode-600 env file**. Nothing
  secret is committed — the repo carries the script, units, and `backup.env.example`.

## Components (in this repo)

| Path | Purpose |
| --- | --- |
| `scripts/backup/backup-orchestrator-db.sh` | Snapshot → integrity-check → gzip → ship to B2 → prune local + remote. |
| `scripts/backup/orchestrator-db-backup.service` | systemd `--user` oneshot that runs the script. |
| `scripts/backup/orchestrator-db-backup.timer` | Nightly, jittered (±30 min), `Persistent=true`. |
| `scripts/backup/backup.env.example` | Template for the off-repo `backup.env` (B2 key, paths, retention). |

## One-time setup (on the prod host, as paulie)

### 1. Create the B2 bucket + a scoped application key

In the Backblaze B2 console:

- Create a private bucket, e.g. `orchestrator-db-backups`.
- Create an **application key scoped to that bucket** (not the master key). Note the
  `keyID` and `applicationKey`.

### 2. Install the off-repo env file (mode 600)

```bash
mkdir -p ~/.config/orchestrator-backup
cp scripts/backup/backup.env.example ~/.config/orchestrator-backup/backup.env
chmod 600 ~/.config/orchestrator-backup/backup.env
$EDITOR ~/.config/orchestrator-backup/backup.env   # fill in the B2 keyID + key
```

Confirm the credentials work end-to-end before wiring the timer:

```bash
set -a; source ~/.config/orchestrator-backup/backup.env; set +a
rclone lsd "${B2_REMOTE}:${B2_BUCKET}"     # should list (empty) without error
```

### 3. Install the systemd user timer (under paulie, never root)

User units keep the backup running as paulie without any root-owned unit. Enable
lingering once so the timer fires even when paulie is not logged in.

```bash
loginctl enable-linger paulie              # one-time; may prompt for admin auth

mkdir -p ~/.config/systemd/user
ln -sf /srv/orchestrator/projects/claude-orchestrator/scripts/backup/orchestrator-db-backup.service ~/.config/systemd/user/
ln -sf /srv/orchestrator/projects/claude-orchestrator/scripts/backup/orchestrator-db-backup.timer   ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now orchestrator-db-backup.timer
systemctl --user list-timers orchestrator-db-backup.timer   # confirm NEXT/LAST
```

### 4. Prove it works (reconcile + capture — authoring is not "done")

```bash
# Fire the backup immediately, out of schedule:
systemctl --user start orchestrator-db-backup.service
journalctl --user -u orchestrator-db-backup.service -n 40 --no-pager

# Confirm a dump actually LANDED off-box (verify by listing, by size):
set -a; source ~/.config/orchestrator-backup/backup.env; set +a
rclone ls "${B2_REMOTE}:${B2_BUCKET}/${B2_PREFIX}"
```

A run is only real when a `dashboard-<UTC>.db.gz` object appears in B2 with a
non-zero size that matches the local archive (the script already asserts this and
exits non-zero on mismatch).

## Restore drill (round-trip into a scratch DB)

Run this at setup and re-verify periodically. It restores the newest off-box dump
into a **scratch** database — it never touches the live `dashboard.db`.

```bash
set -a; source ~/.config/orchestrator-backup/backup.env; set +a
SCRATCH="$(mktemp -d)/restore-check"
mkdir -p "$SCRATCH"

# 1. Pull the newest off-box archive.
NEWEST="$(rclone lsf "${B2_REMOTE}:${B2_BUCKET}/${B2_PREFIX}" --include 'dashboard-*.db.gz' | sort | tail -1)"
echo "restoring: $NEWEST"
rclone copyto "${B2_REMOTE}:${B2_BUCKET}/${B2_PREFIX}/${NEWEST}" "$SCRATCH/${NEWEST}"

# 2. Decompress into a scratch DB.
gunzip -c "$SCRATCH/${NEWEST}" > "$SCRATCH/dashboard.db"

# 3. Verify: integrity + a real table read.
sqlite3 "$SCRATCH/dashboard.db" 'PRAGMA integrity_check;'          # expect: ok
sqlite3 "$SCRATCH/dashboard.db" "SELECT count(*) FROM sqlite_master WHERE type='table';"

# 4. Clean up the scratch copy.
rm -rf "$SCRATCH"
```

The drill passes when `integrity_check` returns `ok` and the table count is
plausible (matches the live schema). To recover for real, stop the backend, copy
the restored `dashboard.db` over `packages/backend/dashboard.db` (removing any
stale `-wal`/`-shm` sidecars), and restart.

## Retention

`RETENTION_DAYS` (default 14) is enforced on **both** sides every run:

- Local: `find … -mtime +N -delete` on `dashboard-*.db.gz` in `BACKUP_LOCAL_DIR`.
- Remote: `rclone delete --min-age Nd` on the bucket prefix.

## Operational notes

- **Verify by size, not just presence.** The script asserts the B2 object size
  equals the local archive and exits non-zero otherwise; the timer surfaces
  failures via `systemctl --user status` / `journalctl --user`.
- **Never root.** Both the unit (`--user`) and the script (uid-0 guard) enforce this.
- **Live WAL is fine.** `.backup` snapshots consistently while writers continue; do
  not stop the backend to back up.
- **"Done ≠ deployed ≠ working."** A committed script/timer is not a backup — a dump
  must land in B2, retention must prune, and a restore must round-trip clean.
