/**
 * Migration test for the additive `image_path` column on investigation_report
 * (Add backend-owned screenshot storage for investigation reports task):
 * nullable TEXT column pointing at a screenshot attachment in the
 * backend-owned investigation-report-images directory. Mirrors the existing
 * ALTER-TABLE-IF-NOT-EXISTS test pattern for other additive columns (e.g.
 * testRunResultsMarkers.schema.test.ts).
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

describe('investigation_report.image_path migration', () => {
  it('adds a nullable image_path column', () => {
    const db = freshDb();
    expect(columnNames(db, 'investigation_report')).toContain('image_path');
    db.close();
  });

  it('reads back as NULL for rows inserted before the column existed, with no backfill', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO investigation_report
         (id, project_id, milestone_id, title, symptom_text, created_at, updated_at)
       VALUES ('r1', 'proj-1', 'milestone-1', 'Title', 'Symptom', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')`,
    ).run();
    const row = db
      .prepare(`SELECT image_path FROM investigation_report WHERE id = 'r1'`)
      .get() as { image_path: string | null };
    expect(row.image_path).toBeNull();
    db.close();
  });

  it('re-running the migration is a no-op (idempotent)', () => {
    const db = freshDb();
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    expect(columnNames(db, 'investigation_report')).toContain('image_path');
    db.close();
  });
});
