import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema.js';

// Tests the sessions.parked_at migration (schema.ts) — the occupancy marker
// replacing archiveSession(id, 'machine_park') for a session left idle and
// resumable by a machine path whose process was reclaimed or died without a
// result. See "Stop archiving idle sessions when their process is reclaimed
// or dies" task.

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

function insertSession(
  db: Database.Database,
  overrides: {
    session_id: string;
    status: string;
    archived?: number;
    archive_kind?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, task_url, project_context_url,
       status, started_at, session_type, archived, archive_kind)
     VALUES (@session_id, 'notion:task-1', 'https://notion.so/task', 'https://notion.so/ctx',
       @status, 1000, 'standard', @archived, @archive_kind)`,
  ).run({
    session_id: overrides.session_id,
    status: overrides.status,
    archived: overrides.archived ?? 0,
    archive_kind: overrides.archive_kind ?? null,
  });
}

describe('runMigrations() — sessions.parked_at', () => {
  it('adds the column to a fresh database', () => {
    const mem = new Database(':memory:');
    expect(() => runMigrations(mem)).not.toThrow();
    expect(tableHasColumn(mem, 'sessions', 'parked_at')).toBe(true);
  });

  it('is idempotent — running twice does not throw and leaves exactly one column', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    expect(() => runMigrations(mem)).not.toThrow();
    const rows = mem.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
      name: string;
    }>;
    expect(rows.filter((r) => r.name === 'parked_at')).toHaveLength(1);
  });

  it('leaves parked_at NULL for an ordinary idle session', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    insertSession(mem, { session_id: 'sess-idle', status: 'idle' });

    runMigrations(mem);

    const row = mem
      .prepare(`SELECT archived, parked_at FROM sessions WHERE session_id = ?`)
      .get('sess-idle') as { archived: number; parked_at: number | null };
    expect(row.archived).toBe(0);
    expect(row.parked_at).toBeNull();
  });

  it('unarchives and parks an existing non-terminal machine_park row, backdating parked_at to its recorded legacy archived signal', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    insertSession(mem, {
      session_id: 'sess-machine-park',
      status: 'idle',
      archived: 1,
      archive_kind: 'machine_park',
    });
    const signalTs = 5000;
    mem
      .prepare(
        `INSERT INTO completing_signal_ledger
           (session_id, task_id, session_type, signal_class, signal_value, recorded_at)
         VALUES ('sess-machine-park', 'notion:task-1', 'standard', 'legacy_status_write', 'archived', ?)`,
      )
      .run(signalTs);

    runMigrations(mem);

    const row = mem
      .prepare(
        `SELECT status, archived, archive_kind, parked_at FROM sessions WHERE session_id = ?`,
      )
      .get('sess-machine-park') as {
      status: string;
      archived: number;
      archive_kind: string | null;
      parked_at: number | null;
    };
    expect(row.status).toBe('idle');
    expect(row.archived).toBe(0);
    expect(row.parked_at).toBe(signalTs);
  });

  it('falls back to the migration run time when no legacy archived signal is recorded for the row', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    insertSession(mem, {
      session_id: 'sess-machine-park-no-signal',
      status: 'idle',
      archived: 1,
      archive_kind: 'machine_park',
    });

    const before = Date.now();
    runMigrations(mem);
    const after = Date.now();

    const row = mem
      .prepare(`SELECT archived, parked_at FROM sessions WHERE session_id = ?`)
      .get('sess-machine-park-no-signal') as {
      archived: number;
      parked_at: number | null;
    };
    expect(row.archived).toBe(0);
    expect(row.parked_at).not.toBeNull();
    expect(row.parked_at as number).toBeGreaterThanOrEqual(before);
    expect(row.parked_at as number).toBeLessThanOrEqual(after);
  });

  it('does not touch a terminal machine_park row (status=done)', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    insertSession(mem, {
      session_id: 'sess-terminal-machine-park',
      status: 'done',
      archived: 1,
      archive_kind: 'machine_park',
    });

    runMigrations(mem);

    const row = mem
      .prepare(`SELECT archived, parked_at FROM sessions WHERE session_id = ?`)
      .get('sess-terminal-machine-park') as {
      archived: number;
      parked_at: number | null;
    };
    expect(row.archived).toBe(1);
    expect(row.parked_at).toBeNull();
  });

  it('does not touch an operator-archived row', () => {
    const mem = new Database(':memory:');
    runMigrations(mem);
    insertSession(mem, {
      session_id: 'sess-operator-archived',
      status: 'idle',
      archived: 1,
      archive_kind: 'operator',
    });

    runMigrations(mem);

    const row = mem
      .prepare(`SELECT archived, parked_at FROM sessions WHERE session_id = ?`)
      .get('sess-operator-archived') as {
      archived: number;
      parked_at: number | null;
    };
    expect(row.archived).toBe(1);
    expect(row.parked_at).toBeNull();
  });
});
