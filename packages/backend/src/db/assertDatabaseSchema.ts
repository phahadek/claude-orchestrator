import type Database from 'better-sqlite3';

/**
 * A database file that already existed before this process opened it, but
 * carries no application schema, is never a genuine first run — first runs
 * have no file at all. It means db.path resolved to the wrong place (e.g. an
 * empty file some other process created there) or the schema was wiped.
 * Opening it and quietly building a fresh schema on top of it — the
 * 2026-07-30 failure mode — must fail loudly instead.
 */
export function assertDatabaseSchema(
  db: Database.Database,
  dbPath: string,
  fileExistedBeforeOpen: boolean,
): void {
  if (!fileExistedBeforeOpen) return;
  const hasSettingsTable = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'`,
    )
    .get();
  if (!hasSettingsTable) {
    throw new Error(
      `[db] Database file at "${dbPath}" already existed but has no application schema ` +
        `(missing "settings" table). This is not a first-run install — refusing to silently ` +
        `build a fresh schema on top of it. If db.path is meant to point elsewhere, fix it and ` +
        `restart; if this file is genuinely disposable, delete it first.`,
    );
  }
}
