/**
 * Tests for the corrective milestones.canonical_short_id re-backfill in
 * schema.ts: the original backfill derived canonical_short_id source_id-
 * first, leaving Notion-synced milestones keyed on their hex source_id
 * instead of the M<n> token that gate_item/seed_item key on. The
 * corrective migration re-derives token-first for rows it itself
 * mis-populated (canonical_short_id === source_id), without disturbing
 * the unique index or token-less names.
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

function seedProject(db: Database.Database, id: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, task_source, created_at, updated_at)
     VALUES (?, ?, ?, 'notion', ?, ?)`,
  ).run(id, id, `/tmp/${id}`, now, now);
}

function seedMisbackfilledMilestone(
  db: Database.Database,
  opts: {
    id: string;
    projectId: string;
    name: string;
    sourceIdHex: string;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO milestones (id, project_id, name, source_id, canonical_short_id, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    opts.id,
    opts.projectId,
    opts.name,
    opts.sourceIdHex,
    opts.sourceIdHex, // simulates the original source_id-first backfill's output
    now,
    now,
  );
}

describe('milestone canonical_short_id corrective re-backfill', () => {
  it('recomputes a hex-valued canonical_short_id to the M<n> token on re-run', () => {
    const db = freshDb();
    seedProject(db, 'proj-1');
    seedMisbackfilledMilestone(db, {
      id: 'ms-11',
      projectId: 'proj-1',
      name: 'M11 — Orchestrator-Owned Planning',
      sourceIdHex: 'e4a105a2-1234-4abc-9def-000000000000',
    });
    seedMisbackfilledMilestone(db, {
      id: 'ms-12',
      projectId: 'proj-1',
      name: 'M12 — Something Else',
      sourceIdHex: '6614adb5-5678-4abc-9def-000000000000',
    });

    // Re-run migrations, as happens on every server boot.
    runMigrations(db);

    const rows = db
      .prepare(
        `SELECT id, canonical_short_id FROM milestones WHERE project_id = ? ORDER BY id`,
      )
      .all('proj-1') as { id: string; canonical_short_id: string }[];
    expect(rows).toEqual([
      { id: 'ms-11', canonical_short_id: 'M11' },
      { id: 'ms-12', canonical_short_id: 'M12' },
    ]);
  });

  it('leaves a token-less name (e.g. MVP) on its source_id fallback', () => {
    const db = freshDb();
    seedProject(db, 'proj-2');
    seedMisbackfilledMilestone(db, {
      id: 'ms-mvp',
      projectId: 'proj-2',
      name: 'MVP',
      sourceIdHex: 'abcd1234-0000-4abc-9def-000000000000',
    });

    runMigrations(db);

    const row = db
      .prepare(`SELECT canonical_short_id FROM milestones WHERE id = ?`)
      .get('ms-mvp') as { canonical_short_id: string };
    expect(row.canonical_short_id).toBe('abcd1234-0000-4abc-9def-000000000000');
  });

  it('preserves the per-project unique index after recompute', () => {
    const db = freshDb();
    seedProject(db, 'proj-3');
    seedMisbackfilledMilestone(db, {
      id: 'ms-a',
      projectId: 'proj-3',
      name: 'M1 — First',
      sourceIdHex: '11111111-0000-4abc-9def-000000000000',
    });
    seedMisbackfilledMilestone(db, {
      id: 'ms-b',
      projectId: 'proj-3',
      name: 'M2 — Second',
      sourceIdHex: '22222222-0000-4abc-9def-000000000000',
    });

    runMigrations(db);

    const indexInfo = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_milestones_project_canonical_short_id'`,
      )
      .get();
    expect(indexInfo).toBeTruthy();

    // Inserting a genuine duplicate token in the same project must still fail.
    expect(() =>
      db
        .prepare(
          `INSERT INTO milestones (id, project_id, name, canonical_short_id, display_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          'ms-dup',
          'proj-3',
          'M1 — Duplicate',
          'M1',
          Date.now(),
          Date.now(),
        ),
    ).toThrow();
  });

  it('does not overwrite a canonical_short_id that already diverges from source_id', () => {
    const db = freshDb();
    seedProject(db, 'proj-4');
    const now = Date.now();
    db.prepare(
      `INSERT INTO milestones (id, project_id, name, source_id, canonical_short_id, display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      'ms-already-token',
      'proj-4',
      'M9 — Already Correct',
      '99999999-0000-4abc-9def-000000000000',
      'M9',
      now,
      now,
    );

    runMigrations(db);

    const row = db
      .prepare(`SELECT canonical_short_id FROM milestones WHERE id = ?`)
      .get('ms-already-token') as { canonical_short_id: string };
    expect(row.canonical_short_id).toBe('M9');
  });
});
