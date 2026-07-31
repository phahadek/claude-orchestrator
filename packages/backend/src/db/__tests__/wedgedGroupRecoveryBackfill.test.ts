/**
 * Tests for the wedged-group-recovery backfill in schema.ts: before the
 * operator-usable recovery path existed, a grouped staged_intent member
 * stuck in needs_revision/pending_verification had no route off that
 * state — every group holding one was permanently uncommittable. This
 * migration declines every such member outright (the operator-usable exit
 * routes/stagedIntents.ts now exposes going forward), never touching a
 * live (staged/approved) sibling.
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

function seedStagedIntent(
  db: Database.Database,
  opts: {
    id: string;
    groupId: string | null;
    state: string;
    dispositionReason: string | null;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO staged_intent
      (id, kind, payload, payload_hash, task_id, project_id, session_id,
       group_id, state, disposition_reason, created_at, updated_at)
     VALUES (?, 'task.updateBody', '{}', 'hash', 'task-1', 'proj-1', NULL,
       ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.groupId,
    opts.state,
    opts.dispositionReason,
    now,
    now,
  );
}

describe('wedged-group-recovery backfill', () => {
  it('declines a grouped needs_revision member with no recorded reason, substituting an explanatory one', () => {
    const db = freshDb();
    seedStagedIntent(db, {
      id: 'wedged-1',
      groupId: 'g-wedged-1',
      state: 'needs_revision',
      dispositionReason: null,
    });

    runMigrations(db);

    const row = db
      .prepare('SELECT state, disposition_reason FROM staged_intent WHERE id = ?')
      .get('wedged-1') as { state: string; disposition_reason: string };
    expect(row.state).toBe('rejected');
    expect(row.disposition_reason).toContain('Auto-resolved');
  });

  it('declines a grouped pending_verification member the same way', () => {
    const db = freshDb();
    seedStagedIntent(db, {
      id: 'wedged-2',
      groupId: 'g-wedged-2',
      state: 'pending_verification',
      dispositionReason: null,
    });

    runMigrations(db);

    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get('wedged-2') as { state: string };
    expect(row.state).toBe('rejected');
  });

  it('scrubs a previously recorded commit-refusal message rather than preserving it as the reason', () => {
    const db = freshDb();
    seedStagedIntent(db, {
      id: 'wedged-3',
      groupId: 'g-wedged-3',
      state: 'needs_revision',
      dispositionReason:
        'group "g-wedged-3" has a blocked member ("wedged-3", state "needs_revision") ' +
        '— it must be recovered or resolved before this group can commit',
    });

    runMigrations(db);

    const row = db
      .prepare('SELECT disposition_reason FROM staged_intent WHERE id = ?')
      .get('wedged-3') as { disposition_reason: string };
    expect(row.disposition_reason).not.toContain(
      'it must be recovered or resolved before this group can commit',
    );
    expect(row.disposition_reason).toContain('Auto-resolved');
  });

  it('preserves a genuine apply-time-failure reason rather than overwriting it', () => {
    const db = freshDb();
    seedStagedIntent(db, {
      id: 'wedged-4',
      groupId: 'g-wedged-4',
      state: 'needs_revision',
      dispositionReason: 'invalid status transition for t-4: Done -> Ready',
    });

    runMigrations(db);

    const row = db
      .prepare('SELECT disposition_reason FROM staged_intent WHERE id = ?')
      .get('wedged-4') as { disposition_reason: string };
    expect(row.disposition_reason).toBe(
      'invalid status transition for t-4: Done -> Ready',
    );
  });

  it('never touches a live (staged/approved) sibling in the same group', () => {
    const db = freshDb();
    seedStagedIntent(db, {
      id: 'live-sibling',
      groupId: 'g-mixed',
      state: 'approved',
      dispositionReason: null,
    });
    seedStagedIntent(db, {
      id: 'blocked-sibling',
      groupId: 'g-mixed',
      state: 'needs_revision',
      dispositionReason: null,
    });

    runMigrations(db);

    const live = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get('live-sibling') as { state: string };
    const blocked = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get('blocked-sibling') as { state: string };
    expect(live.state).toBe('approved');
    expect(blocked.state).toBe('rejected');
  });

  it('leaves an ungrouped needs_revision row untouched — only grouped members are in scope', () => {
    const db = freshDb();
    seedStagedIntent(db, {
      id: 'ungrouped-1',
      groupId: null,
      state: 'needs_revision',
      dispositionReason: null,
    });

    runMigrations(db);

    const row = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get('ungrouped-1') as { state: string };
    expect(row.state).toBe('needs_revision');
  });

  it('is idempotent — a second run touches nothing further once every blocked member is resolved', () => {
    const db = freshDb();
    seedStagedIntent(db, {
      id: 'wedged-5',
      groupId: 'g-wedged-5',
      state: 'needs_revision',
      dispositionReason: null,
    });

    runMigrations(db);
    const firstReason = (
      db
        .prepare('SELECT disposition_reason FROM staged_intent WHERE id = ?')
        .get('wedged-5') as { disposition_reason: string }
    ).disposition_reason;

    runMigrations(db);
    const secondReason = (
      db
        .prepare('SELECT disposition_reason FROM staged_intent WHERE id = ?')
        .get('wedged-5') as { disposition_reason: string }
    ).disposition_reason;

    expect(secondReason).toBe(firstReason);
  });
});
