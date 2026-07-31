/**
 * Tests for the gate_item.latest_disposition forward-only backfill in
 * schema.ts: before this column existed, a non-terminal disposition
 * (needs-setup, noted) was recorded only as a pure log entry in
 * gate_item_event, invisible on the item's denormalized row. This backfills
 * the column from each item's most recent disposition-bearing event so
 * pre-existing rows are trustworthy, not just events appended going forward.
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

function seedGateItem(
  db: Database.Database,
  id: string,
  state = 'open',
): void {
  db.prepare(
    `INSERT INTO gate_item
      (id, project, milestone, text, classification, state, updated_at)
     VALUES (?, 'proj-1', 'M12', 'an item', 'Read-Only', ?, ?)`,
  ).run(id, state, new Date(0).toISOString());
}

function seedGateItemEvent(
  db: Database.Database,
  gateItemId: string,
  disposition: string | null,
  at: string,
): void {
  db.prepare(
    `INSERT INTO gate_item_event (gate_item_id, disposition, at) VALUES (?, ?, ?)`,
  ).run(gateItemId, disposition, at);
}

describe('gate_item.latest_disposition backfill', () => {
  it('backfills from the most recent disposition-bearing event', () => {
    const db = freshDb();
    seedGateItem(db, 'item-1');
    seedGateItemEvent(db, 'item-1', 'noted', new Date(1).toISOString());
    seedGateItemEvent(db, 'item-1', 'needs-setup', new Date(2).toISOString());

    runMigrations(db);

    const row = db
      .prepare('SELECT latest_disposition FROM gate_item WHERE id = ?')
      .get('item-1') as { latest_disposition: string | null };
    expect(row.latest_disposition).toBe('needs-setup');
  });

  it('skips a dispositionless (pure evidence) event when picking the latest', () => {
    const db = freshDb();
    seedGateItem(db, 'item-2');
    seedGateItemEvent(db, 'item-2', 'pass', new Date(1).toISOString());
    seedGateItemEvent(db, 'item-2', null, new Date(2).toISOString());

    runMigrations(db);

    const row = db
      .prepare('SELECT latest_disposition FROM gate_item WHERE id = ?')
      .get('item-2') as { latest_disposition: string | null };
    expect(row.latest_disposition).toBe('pass');
  });

  it('leaves an item with no events null', () => {
    const db = freshDb();
    seedGateItem(db, 'item-3');

    runMigrations(db);

    const row = db
      .prepare('SELECT latest_disposition FROM gate_item WHERE id = ?')
      .get('item-3') as { latest_disposition: string | null };
    expect(row.latest_disposition).toBeNull();
  });

  it('is idempotent on repeated runs and never clobbers an already-set value', () => {
    const db = freshDb();
    seedGateItem(db, 'item-4');
    seedGateItemEvent(db, 'item-4', 'needs-setup', new Date(1).toISOString());
    runMigrations(db);

    // A later event lands after the backfill already ran once — a second
    // migration run must not overwrite the column back to the stale value.
    seedGateItemEvent(db, 'item-4', 'pass', new Date(2).toISOString());
    db.prepare(
      `UPDATE gate_item SET latest_disposition = 'pass' WHERE id = 'item-4'`,
    ).run();
    runMigrations(db);

    const row = db
      .prepare('SELECT latest_disposition FROM gate_item WHERE id = ?')
      .get('item-4') as { latest_disposition: string | null };
    expect(row.latest_disposition).toBe('pass');
  });
});
