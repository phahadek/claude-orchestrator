/**
 * Tests for the investigation_report.milestone_id UUID-key-space backfill
 * in schema.ts: rows written before createReport/updateDraftReport's
 * write-path resolveMilestoneRowForProject normalization existed carry the
 * gate_item/seed_item display-name form instead of the milestones.id UUID
 * that flow_arm.milestone_id and every UUID-keyed reader (convergence,
 * investigationReconciler) match on. This backfill rewrites those rows in
 * place, scoped by project_id, so the column carries exactly one key space
 * going forward.
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

function seedProjectAndMilestone(
  db: Database.Database,
  projectId: string,
  milestoneId: string,
  name: string,
  canonicalShortId: string | null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects (id, name, project_dir, task_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(projectId, projectId, `/tmp/${projectId}`, 'notion', now, now);
  db.prepare(
    `INSERT INTO milestones (id, project_id, name, canonical_short_id, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(milestoneId, projectId, name, canonicalShortId, 0, now, now);
}

function seedReport(
  db: Database.Database,
  id: string,
  projectId: string,
  milestoneId: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO investigation_report
       (id, project_id, milestone_id, title, symptom_text, state, source, created_at, updated_at)
     VALUES (?, ?, ?, 'title', 'symptom', 'draft', 'operator', ?, ?)`,
  ).run(id, projectId, milestoneId, now, now);
}

describe('investigation_report.milestone_id UUID backfill', () => {
  it('rewrites a row keyed on the display-name (canonical short id) form to the milestone UUID', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-15', 'M15 full name', 'M15');
    seedReport(db, 'report-1', 'proj-1', 'M15');

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone_id FROM investigation_report WHERE id = ?')
      .get('report-1') as { milestone_id: string };
    expect(row.milestone_id).toBe('ms-uuid-15');
  });

  it('rewrites a row keyed on the full board name to the milestone UUID', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-15', 'M15 full name', 'M15');
    seedReport(db, 'report-2', 'proj-1', 'M15 full name');

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone_id FROM investigation_report WHERE id = ?')
      .get('report-2') as { milestone_id: string };
    expect(row.milestone_id).toBe('ms-uuid-15');
  });

  it('matches the display name case-insensitively', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-15', 'M15 Full Name', 'M15');
    seedReport(db, 'report-3', 'proj-1', 'm15');

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone_id FROM investigation_report WHERE id = ?')
      .get('report-3') as { milestone_id: string };
    expect(row.milestone_id).toBe('ms-uuid-15');
  });

  it('leaves an already-canonical (UUID) row unchanged', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-15', 'M15 full name', 'M15');
    seedReport(db, 'report-4', 'proj-1', 'ms-uuid-15');

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone_id FROM investigation_report WHERE id = ?')
      .get('report-4') as { milestone_id: string };
    expect(row.milestone_id).toBe('ms-uuid-15');
  });

  it('leaves an empty milestone_id row untouched — the "no milestone yet" draft sentinel', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-15', 'M15 full name', 'M15');
    seedReport(db, 'report-5', 'proj-1', '');

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone_id FROM investigation_report WHERE id = ?')
      .get('report-5') as { milestone_id: string };
    expect(row.milestone_id).toBe('');
  });

  it('does not cross-canonicalize into a same-named milestone from a different project', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-15a', 'Shared Name', 'M15');
    seedProjectAndMilestone(db, 'proj-2', 'ms-uuid-15b', 'Shared Name', 'X15');
    seedReport(db, 'report-6', 'proj-2', 'Shared Name');

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone_id FROM investigation_report WHERE id = ?')
      .get('report-6') as { milestone_id: string };
    expect(row.milestone_id).toBe('ms-uuid-15b');
  });

  it('is idempotent on repeated runs', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-15', 'M15 full name', 'M15');
    seedReport(db, 'report-7', 'proj-1', 'M15');
    runMigrations(db);
    runMigrations(db);

    const row = db
      .prepare('SELECT milestone_id FROM investigation_report WHERE id = ?')
      .get('report-7') as { milestone_id: string };
    expect(row.milestone_id).toBe('ms-uuid-15');
  });
});
