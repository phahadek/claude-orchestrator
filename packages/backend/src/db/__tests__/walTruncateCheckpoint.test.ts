import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runWalTruncateCheckpoint } from '../db.js';

describe('runWalTruncateCheckpoint', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function openFileBackedWalDb(): { db: Database.Database; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-checkpoint-test-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'test.db');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    return { db, file };
  }

  // Opens a real file-backed WAL sqlite db under a fresh tmpdir; not
  // millisecond-bounded under disk contention.
  it(
    'checkpoints and truncates the WAL, reporting sizes and the busy/log/checkpointed triple',
    () => {
      const { db, file } = openFileBackedWalDb();
      try {
        db.exec("INSERT INTO t (val) VALUES ('a'), ('b'), ('c')");

        const result = runWalTruncateCheckpoint(db, file);

        expect(result.busy).toBe(0);
        expect(result.walSizeAfterBytes).toBe(0);
        expect(result.walSizeBeforeBytes).toBeGreaterThanOrEqual(
          result.walSizeAfterBytes,
        );
        expect(result.checkpointed).toBeGreaterThanOrEqual(0);
        expect(result.log).toBeGreaterThanOrEqual(0);
      } finally {
        db.close();
      }
    },
    10000,
  );

  // Opens a real file-backed WAL sqlite db under a fresh tmpdir; not
  // millisecond-bounded under disk contention.
  it(
    'reports busy=1 without throwing when the checkpoint pragma reports a blocked truncate',
    () => {
      const { db, file } = openFileBackedWalDb();
      try {
        db.exec("INSERT INTO t (val) VALUES ('a')");

        // Simulates SQLite's own response when a reader holds the WAL open and
        // a TRUNCATE checkpoint can't proceed — the pragma never throws for
        // this case, it just reports busy=1 with 0 pages checkpointed.
        const original = db.pragma.bind(db);
        db.pragma = ((sql: string, opts?: unknown) => {
          if (sql === 'wal_checkpoint(TRUNCATE)') {
            return [{ busy: 1, log: 3, checkpointed: 0 }];
          }
          return original(sql, opts as never);
        }) as typeof db.pragma;

        const result = runWalTruncateCheckpoint(db, file);

        expect(result.busy).toBe(1);
        expect(result.checkpointed).toBe(0);
      } finally {
        db.close();
      }
    },
    10000,
  );

  it('returns zeroed sizes for an in-memory database without touching the filesystem', () => {
    const db = new Database(':memory:');
    try {
      const result = runWalTruncateCheckpoint(db, ':memory:');
      expect(result.walSizeBeforeBytes).toBe(0);
      expect(result.walSizeAfterBytes).toBe(0);
    } finally {
      db.close();
    }
  });
});
