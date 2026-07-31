import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { assertDatabaseSchema } from '../assertDatabaseSchema.js';

describe('assertDatabaseSchema', () => {
  it('does nothing when the file did not exist before open (genuine first run)', () => {
    const db = new Database(':memory:');
    expect(() =>
      assertDatabaseSchema(db, '/some/fresh/dashboard.db', false),
    ).not.toThrow();
  });

  it('throws when a pre-existing file has no settings table (not a first run)', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY)`);
    expect(() =>
      assertDatabaseSchema(db, '/srv/orchestrator/dashboard.db', true),
    ).toThrow(/no application schema/);
  });

  it('does not throw when a pre-existing file already has the settings table', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
    expect(() =>
      assertDatabaseSchema(db, '/srv/orchestrator/dashboard.db', true),
    ).not.toThrow();
  });
});
