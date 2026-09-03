/**
 * Migration test for the additive `dropped_at` column on
 * session_feedback_inbox (enqueue-before-terminal-guard task): mirrors
 * delivered_at's shape so deliverUndeliveredInboxItems' discard path can
 * stamp a distinct terminal state instead of overloading delivered_at.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((c) => c.name);
}

describe('session_feedback_inbox.dropped_at migration', () => {
  it('adds a nullable dropped_at column to session_feedback_inbox', () => {
    const db = freshDb();
    expect(columnNames(db, 'session_feedback_inbox')).toContain('dropped_at');
    db.close();
  });

  it('reads back as NULL for a freshly-enqueued row', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO session_feedback_inbox (session_id, source, payload, enqueued_at)
       VALUES ('sess-1', 'operator:message', 'hello', 0)`,
    ).run();
    const row = db
      .prepare(
        `SELECT delivered_at, dropped_at FROM session_feedback_inbox WHERE session_id = 'sess-1'`,
      )
      .get() as { delivered_at: number | null; dropped_at: number | null };
    expect(row.delivered_at).toBeNull();
    expect(row.dropped_at).toBeNull();
    db.close();
  });

  it('running migrations again on an already-migrated db is a no-op (idempotent)', () => {
    const db = freshDb();
    expect(() => runMigrations(db)).not.toThrow();
    expect(columnNames(db, 'session_feedback_inbox')).toContain('dropped_at');
    db.close();
  });
});
