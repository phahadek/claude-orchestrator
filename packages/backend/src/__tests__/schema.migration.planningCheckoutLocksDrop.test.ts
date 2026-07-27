import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema';

// planning_checkout_locks backed the reverted checkout-lockdown mechanism.
// This is a forward-only drop: any rows present at migration time are stale
// by definition once the lockdown is gone (see the 2026-07-27 revert).

describe('runMigrations — drops planning_checkout_locks', () => {
  it('drops the table cleanly when it exists with rows in it', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE planning_checkout_locks (
        session_id   TEXT    PRIMARY KEY,
        project_dir  TEXT    NOT NULL,
        scratch_dir  TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_planning_checkout_locks_project_dir
        ON planning_checkout_locks(project_dir);
      INSERT INTO planning_checkout_locks VALUES
        ('session-a', '/project', '/project/.claude/scratch/session-a', 1),
        ('session-b', '/project', '/project/.claude/scratch/session-b', 2);
    `);

    expect(() => runMigrations(db)).not.toThrow();

    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='planning_checkout_locks'`,
        )
        .get(),
    ).toBeUndefined();
  });

  it('is a no-op against a fresh DB that never had the table', () => {
    const db = new Database(':memory:');
    expect(() => runMigrations(db)).not.toThrow();
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='planning_checkout_locks'`,
        )
        .get(),
    ).toBeUndefined();
  });
});
