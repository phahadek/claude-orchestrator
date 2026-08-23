import type Database from 'better-sqlite3';

/**
 * Inserts plain rows into `table` before/between runMigrations() calls, for
 * migration tests that need a populated (not empty) database. Column names
 * come from the keys of the first row; every row must share that column set.
 *
 * This is a thin helper, not a fixture — each migration test owns its own
 * realistic seed values for the columns that migration touches. See
 * schema.migration.populatedDatabase.test.ts for the worked example.
 */
export function insertRows(
  db: Database.Database,
  table: string,
  rows: Array<Record<string, unknown>>,
): void {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const placeholders = columns.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
  );
  for (const row of rows) {
    stmt.run(...columns.map((c) => row[c]));
  }
}
