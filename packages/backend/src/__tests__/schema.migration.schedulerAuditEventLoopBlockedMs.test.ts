import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';

function getColumnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

describe('runMigrations() — scheduler_audit.event_loop_blocked_ms', () => {
  it('adds the column to a fresh database', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    const columns = getColumnNames(mem, 'scheduler_audit');
    expect(columns).toContain('event_loop_blocked_ms');
    // duration_ms retains its existing wall-clock column — additive only.
    expect(columns).toContain('duration_ms');
  });

  it('running runMigrations twice does not throw', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    expect(() => runMigrations(mem)).not.toThrow();
    const columns = getColumnNames(mem, 'scheduler_audit');
    expect(columns).toContain('event_loop_blocked_ms');
  });
});
