import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema';

// Tests the forward-only migration that adds milestones.canonical_short_id
// and backfills every existing row: yaml-sourced rows (source_id set) keep
// their source_id; everything else falls back to the leading M<n> token, or
// the full name when it has none. Mirrors the registration-time derivation
// in ProjectService so resolved keys stay identical post-cutover.

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  for (const id of ['p1', 'p2']) {
    db.prepare(
      `INSERT INTO projects (id, name, project_dir, task_source, created_at, updated_at)
       VALUES (?, ?, ?, 'notion', 0, 0)`,
    ).run(id, id, `/tmp/${id}`);
  }
  return db;
}

function insertRawMilestone(
  db: InstanceType<typeof Database>,
  row: { id: string; project_id: string; name: string; source_id: string | null },
) {
  db.prepare(
    `INSERT INTO milestones (id, project_id, name, source_id, display_order, created_at, updated_at)
     VALUES (@id, @project_id, @name, @source_id, 0, 0, 0)`,
  ).run(row);
}

function canonicalShortId(
  db: InstanceType<typeof Database>,
  id: string,
): string | null {
  const row = db
    .prepare('SELECT canonical_short_id FROM milestones WHERE id = ?')
    .get(id) as { canonical_short_id: string | null };
  return row.canonical_short_id;
}

describe('milestones.canonical_short_id backfill migration', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
  });

  it('backfills a yaml-sourced row (source_id set) to its source_id', () => {
    insertRawMilestone(db, {
      id: 'm-1',
      project_id: 'p1',
      name: 'Sprint 1',
      source_id: 'ms-1',
    });
    runMigrations(db);
    expect(canonicalShortId(db, 'm-1')).toBe('ms-1');
  });

  it('backfills a Notion/GitHub/Jira-sourced row to its leading M<n> token', () => {
    insertRawMilestone(db, {
      id: 'm-2',
      project_id: 'p1',
      name: 'M11 — Orchestrator-Owned Planning',
      source_id: null,
    });
    runMigrations(db);
    expect(canonicalShortId(db, 'm-2')).toBe('M11');
  });

  it('falls back to the full name when there is no leading M<n> token', () => {
    insertRawMilestone(db, {
      id: 'm-3',
      project_id: 'p1',
      name: 'Backlog Cleanup',
      source_id: null,
    });
    runMigrations(db);
    expect(canonicalShortId(db, 'm-3')).toBe('Backlog Cleanup');
  });

  it('every existing row is non-null after backfill', () => {
    insertRawMilestone(db, {
      id: 'm-4',
      project_id: 'p1',
      name: 'M2a',
      source_id: null,
    });
    runMigrations(db);
    const rows = db
      .prepare('SELECT canonical_short_id FROM milestones')
      .all() as { canonical_short_id: string | null }[];
    expect(rows.every((r) => r.canonical_short_id !== null)).toBe(true);
  });

  it('is idempotent — does not overwrite an already-backfilled value on re-run', () => {
    insertRawMilestone(db, {
      id: 'm-5',
      project_id: 'p1',
      name: 'M12 — Some Title',
      source_id: null,
    });
    runMigrations(db);
    // Operator override after backfill must survive a second migration run.
    db.prepare(
      `UPDATE milestones SET canonical_short_id = 'M12-custom' WHERE id = 'm-5'`,
    ).run();
    runMigrations(db);
    expect(canonicalShortId(db, 'm-5')).toBe('M12-custom');
  });

  it('enforces per-project canonical_short_id uniqueness (case-insensitive)', () => {
    db.prepare(
      `INSERT INTO milestones (id, project_id, name, source_id, canonical_short_id, display_order, created_at, updated_at)
       VALUES ('m-6', 'p1', 'M11', NULL, 'M11', 0, 0, 0)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO milestones (id, project_id, name, source_id, canonical_short_id, display_order, created_at, updated_at)
           VALUES ('m-7', 'p1', 'm11 — dup', NULL, 'm11', 0, 0, 0)`,
        )
        .run(),
    ).toThrow();
  });

  it('allows the same canonical_short_id across different projects', () => {
    db.prepare(
      `INSERT INTO milestones (id, project_id, name, source_id, canonical_short_id, display_order, created_at, updated_at)
       VALUES ('m-8', 'p1', 'M11', NULL, 'M11', 0, 0, 0)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO milestones (id, project_id, name, source_id, canonical_short_id, display_order, created_at, updated_at)
           VALUES ('m-9', 'p2', 'M11', NULL, 'M11', 0, 0, 0)`,
        )
        .run(),
    ).not.toThrow();
  });
});
