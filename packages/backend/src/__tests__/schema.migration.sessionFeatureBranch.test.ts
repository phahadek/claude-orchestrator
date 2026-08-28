import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';

// Tests the sessions.feature_branch migration (schema.ts) — persists the
// branch actually created at worktree-add time (see branchModel.ts's
// resolveAvailableBranchSlug), so a uniquified name survives a re-derivation
// and lookupSessionByBranch can match on it directly.

function tableHasColumn(
  db: Database.Database,
  table: string,
  column: string,
): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((r) => r.name === column);
}

describe('runMigrations() — sessions.feature_branch', () => {
  it('adds the column to a fresh database', () => {
    const mem = new Database(':memory:');
    expect(() => runMigrations(mem)).not.toThrow();
    expect(tableHasColumn(mem, 'sessions', 'feature_branch')).toBe(true);
  });

  it('is idempotent — running twice does not throw and leaves exactly one column', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    expect(() => runMigrations(mem)).not.toThrow();
    const rows = mem.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
      name: string;
    }>;
    expect(rows.filter((r) => r.name === 'feature_branch')).toHaveLength(1);
  });

  it('does not drop or rewrite existing sessions rows — pre-existing data survives untouched', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    // task_id is pre-prefixed ('notion:...') to avoid tripping the unrelated
    // source-prefix backfill (also unconditionally re-run on every boot),
    // which would otherwise rewrite an unprefixed id and confound this
    // assertion with an unrelated migration's behavior.
    mem
      .prepare(
        `INSERT INTO sessions (session_id, task_id, task_name, status, started_at) VALUES (?, ?, ?, 'done', 1000)`,
      )
      .run('sess-pre-existing', 'notion:task-1', 'Pre-existing task');

    // Re-run migrations (as boot would on every start) against the same db.
    runMigrations(mem);

    const row = mem
      .prepare(`SELECT * FROM sessions WHERE session_id = ?`)
      .get('sess-pre-existing') as {
      session_id: string;
      task_id: string;
      task_name: string;
      status: string;
      feature_branch: string | null;
    };
    expect(row.session_id).toBe('sess-pre-existing');
    expect(row.task_id).toBe('notion:task-1');
    expect(row.task_name).toBe('Pre-existing task');
    expect(row.status).toBe('done');
    expect(row.feature_branch).toBeNull();
  });
});
