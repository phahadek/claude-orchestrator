import Database from 'better-sqlite3';
import fs from 'fs';

// Tables checked to decide whether a candidate database file is "populated"
// (has real operator data worth refusing to hide) versus merely present —
// an empty file some tool touched, or a genuine unused database, must never
// trigger the legacy-refusal below.
const CORE_TABLES = ['sessions', 'projects', 'pull_requests', 'session_events'];

function isPopulatedDatabaseFile(candidatePath: string): boolean {
  if (!fs.existsSync(candidatePath)) return false;
  let db: Database.Database;
  try {
    db = new Database(candidatePath, { readonly: true, fileMustExist: true });
  } catch {
    return false;
  }
  try {
    const hasSettingsTable = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'`,
      )
      .get();
    if (!hasSettingsTable) return false;
    for (const table of CORE_TABLES) {
      const hasTable = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        )
        .get(table);
      if (!hasTable) continue;
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as
        | { c: number }
        | undefined;
      if ((row?.c ?? 0) > 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * A database file that already existed before this process opened it, but
 * carries no application schema, is never a genuine first run — first runs
 * have no file at all. It means db.path resolved to the wrong place (e.g. an
 * empty file some other process created there) or the schema was wiped.
 * Opening it and quietly building a fresh schema on top of it — the
 * 2026-07-30 failure mode — must fail loudly instead.
 *
 * The inverse case — no file at all at the resolved path — is not
 * automatically a genuine first run either: it is also what a v2.x upgrade
 * looks like when db.path's relative-path resolution changed and the
 * operator's real database was left behind at its pre-upgrade location. If
 * one of `legacyCandidatePaths` holds a populated database, refuse to boot
 * rather than silently create and populate an empty one at the new path.
 */
export function assertDatabaseSchema(
  db: Database.Database,
  dbPath: string,
  fileExistedBeforeOpen: boolean,
  legacyCandidatePaths: string[] = [],
): void {
  if (!fileExistedBeforeOpen) {
    const populatedLegacyPath = legacyCandidatePaths.find(
      isPopulatedDatabaseFile,
    );
    if (populatedLegacyPath) {
      throw new Error(
        `[db] No database found at "${dbPath}", but a populated database exists at the ` +
          `legacy location "${populatedLegacyPath}". This looks like an upgrade where db.path's ` +
          `relative-path resolution changed and the real database was left behind — refusing to ` +
          `create a fresh, empty database at "${dbPath}" and hide it. Copy or move ` +
          `"${populatedLegacyPath}" to "${dbPath}" and restart if that is the real database; ` +
          `otherwise delete it to accept a genuine fresh install.`,
      );
    }
    return;
  }
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
