import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';
import { setupTestDb } from '../../test/helpers/setupTestDb.js';

const EXPECTED_TABLES = new Set([
  'sessions',
  'session_events',
  'permission_events',
  'permission_rules',
  'permission_denials',
  'task_cache',
  'settings',
  'session_audits',
  'projects',
  'milestones',
  'local_branches',
  'audit_log',
  'devices',
  'pull_requests',
  'pr_review_comments_routed',
  'orchestrator_autofix_shas',
  'orchestrator_test_results',
  'task_no_op_attempts',
  'pending_review_sync',
  'session_pause_intervals',
  'stuck_session_timers',
]);

function getTableNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe('runMigrations', () => {
  it('accepts an optional Database and defaults to the singleton', () => {
    const mem = new Database(':memory:');
    expect(() => runMigrations(mem)).not.toThrow();
  });

  it('creates the full production table set on a fresh :memory: DB', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    const tables = getTableNames(mem);
    for (const table of EXPECTED_TABLES) {
      expect(tables, `expected table "${table}" to exist`).toContain(table);
    }
  });
});

describe('setupTestDb', () => {
  it('returns a DB whose table set matches the production schema', () => {
    const db = setupTestDb();
    const tables = getTableNames(db);
    for (const table of EXPECTED_TABLES) {
      expect(tables, `expected table "${table}" to exist`).toContain(table);
    }
  });

  it('returns an independent :memory: DB each call', () => {
    const db1 = setupTestDb();
    const db2 = setupTestDb();
    db1
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('k', 'v');
    const count = (
      db2.prepare('SELECT COUNT(*) as c FROM settings').get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });
});
