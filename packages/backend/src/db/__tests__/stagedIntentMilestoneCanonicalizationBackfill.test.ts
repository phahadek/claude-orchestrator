/**
 * Tests for the staged_intent.milestone canonicalization backfill in
 * schema.ts: rows written before stageIntent's caller-side
 * resolveMilestoneForProject normalization existed may carry a milestone's
 * DB id (UUID) or full display name instead of the canonical short id every
 * read (listStagedIntentsByMilestone, GET /staged-intents?milestone=)
 * matches on literally. This backfill rewrites those rows in place so the
 * column carries exactly one key space going forward.
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

function seedStagedIntent(
  db: Database.Database,
  id: string,
  projectId: string,
  milestone: string | null,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO staged_intent
      (id, kind, payload, payload_hash, project_id, state, milestone, created_at, updated_at)
     VALUES (?, 'task.setStatus', '{}', 'hash', ?, 'staged', ?, ?, ?)`,
  ).run(id, projectId, milestone, now, now);
}

describe('staged_intent.milestone canonicalization backfill', () => {
  it('rewrites a row keyed on the milestone DB id (UUID) to the canonical short id', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-13', 'M13 full name', 'M13');
    seedStagedIntent(db, 'intent-1', 'proj-1', 'ms-uuid-13');

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone FROM staged_intent WHERE id = ?')
      .get('intent-1') as { milestone: string | null };
    expect(row.milestone).toBe('M13');
  });

  it('rewrites a row keyed on the milestone full display name to the canonical short id', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-13', 'M13 full name', 'M13');
    seedStagedIntent(db, 'intent-2', 'proj-1', 'M13 full name');

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone FROM staged_intent WHERE id = ?')
      .get('intent-2') as { milestone: string | null };
    expect(row.milestone).toBe('M13');
  });

  it('matches the display name case-insensitively', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-13', 'M13 Full Name', 'M13');
    seedStagedIntent(db, 'intent-2b', 'proj-1', 'm13 full name');

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone FROM staged_intent WHERE id = ?')
      .get('intent-2b') as { milestone: string | null };
    expect(row.milestone).toBe('M13');
  });

  it('falls back to the display name when the milestone has no M<n>-shaped short token', () => {
    const db = freshDb();
    // The separate canonical_short_id backfill (schema.ts, above this
    // migration) derives a short token from an "M<n>" prefix or falls back
    // to the full name — a name with neither shape ends up with
    // canonical_short_id equal to its own name, exercising this migration's
    // COALESCE(canonical_short_id, name) fallback with the same value on
    // both sides.
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-14', 'Sprint Fourteen', null);
    seedStagedIntent(db, 'intent-3', 'proj-1', 'ms-uuid-14');

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone FROM staged_intent WHERE id = ?')
      .get('intent-3') as { milestone: string | null };
    expect(row.milestone).toBe('Sprint Fourteen');
  });

  it('leaves an already-canonical row unchanged', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-13', 'M13 full name', 'M13');
    seedStagedIntent(db, 'intent-4', 'proj-1', 'M13');

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone FROM staged_intent WHERE id = ?')
      .get('intent-4') as { milestone: string | null };
    expect(row.milestone).toBe('M13');
  });

  it('leaves a NULL milestone row untouched — deliberately retained, handled by the separate task-id-based backfill', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-13', 'M13 full name', 'M13');
    seedStagedIntent(db, 'intent-5', 'proj-1', null);

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone FROM staged_intent WHERE id = ?')
      .get('intent-5') as { milestone: string | null };
    expect(row.milestone).toBeNull();
  });

  it('leaves a value that matches no known milestone in the row\'s project untouched', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-13', 'M13 full name', 'M13');
    seedStagedIntent(db, 'intent-6', 'proj-1', 'some-other-projects-milestone');

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone FROM staged_intent WHERE id = ?')
      .get('intent-6') as { milestone: string | null };
    expect(row.milestone).toBe('some-other-projects-milestone');
  });

  it('does not cross-canonicalize into a same-named milestone from a different project', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-13a', 'Shared Name', 'M13');
    seedProjectAndMilestone(db, 'proj-2', 'ms-uuid-13b', 'Shared Name', 'X13');
    seedStagedIntent(db, 'intent-7', 'proj-2', 'Shared Name');

    runMigrations(db);

    const row = db
      .prepare('SELECT milestone FROM staged_intent WHERE id = ?')
      .get('intent-7') as { milestone: string | null };
    expect(row.milestone).toBe('X13');
  });

  it('is idempotent on repeated runs', () => {
    const db = freshDb();
    seedProjectAndMilestone(db, 'proj-1', 'ms-uuid-13', 'M13 full name', 'M13');
    seedStagedIntent(db, 'intent-8', 'proj-1', 'ms-uuid-13');
    runMigrations(db);
    runMigrations(db);

    const row = db
      .prepare('SELECT milestone FROM staged_intent WHERE id = ?')
      .get('intent-8') as { milestone: string | null };
    expect(row.milestone).toBe('M13');
  });
});
