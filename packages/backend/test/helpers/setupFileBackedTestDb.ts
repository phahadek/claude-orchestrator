import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/schema.js';

export interface FileBackedTestDb {
  db: Database.Database;
  /** Temp directory holding the db file — caller is responsible for rmSync-ing it once done. */
  dir: string;
}

/**
 * setupTestDb's file-backed counterpart — a real on-disk database instead of
 * `:memory:`, for a test that needs a second connection (typically a worker
 * thread spawned via a db/*OffMainThread dispatcher) to open the same file.
 * WAL + a nonzero busy_timeout mirror db.ts's own startup pragmas: without
 * them, this connection and a worker's competing for the single rollback-
 * journal write lock would surface as an intermittent SQLITE_BUSY failure
 * under host contention rather than a deterministic result — see
 * flakyTestRollupOffMainThread.test.ts's matching comment.
 */
export function setupFileBackedTestDb(): FileBackedTestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-backed-test-db-'));
  const file = path.join(dir, 'test.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return { db, dir };
}
