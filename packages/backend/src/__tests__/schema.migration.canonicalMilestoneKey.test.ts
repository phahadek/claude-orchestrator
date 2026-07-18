import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/schema';

// Tests the migration that re-keys gate_item/seed_item/gate_accretion/
// seed_accretion rows minted under the full Notion milestone title (a
// stopgap written while resolveMilestoneForProject returned match.name
// instead of the short M<n> token) to the short form every other
// write/read/loader/row uses, plus the source_task_id raw-vs-prefixed
// normalization for seed_item_source/gate_accretion/seed_accretion that
// aligns the gate_accretion and seed_accretion marker keys.

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function milestones(
  db: InstanceType<typeof Database>,
  table: string,
): string[] {
  return (
    db
      .prepare(`SELECT DISTINCT milestone FROM ${table} ORDER BY milestone`)
      .all() as { milestone: string }[]
  ).map((r) => r.milestone);
}

describe('canonical milestone key + source_task_id migration', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
  });

  it('re-keys gate_item rows stored under the full Notion title to the short form', () => {
    db.prepare(
      `INSERT INTO gate_item (id, project, milestone, text, classification, state, updated_at)
       VALUES ('gi-1', 'p1', 'M11 — Orchestrator-Owned Planning', 'text', 'needs-triage', 'open', '2026-01-01')`,
    ).run();
    runMigrations(db);
    expect(milestones(db, 'gate_item')).toEqual(['M11']);
  });

  it('re-keys seed_item rows stored under the full Notion title to the short form', () => {
    db.prepare(
      `INSERT INTO seed_item (id, project, milestone, spec, state, updated_at)
       VALUES ('si-1', 'p1', 'M13 — Some Title', 'spec', 'pending', '2026-01-01')`,
    ).run();
    runMigrations(db);
    expect(milestones(db, 'seed_item')).toEqual(['M13']);
  });

  it('leaves already-short milestone keys unchanged', () => {
    db.prepare(
      `INSERT INTO gate_item (id, project, milestone, text, classification, state, updated_at)
       VALUES ('gi-1', 'p1', 'M11', 'text', 'needs-triage', 'open', '2026-01-01')`,
    ).run();
    runMigrations(db);
    expect(milestones(db, 'gate_item')).toEqual(['M11']);
  });

  it('leaves a milestone name with no leading M<n> token unchanged', () => {
    db.prepare(
      `INSERT INTO gate_item (id, project, milestone, text, classification, state, updated_at)
       VALUES ('gi-1', 'p1', 'Backlog Cleanup', 'text', 'needs-triage', 'open', '2026-01-01')`,
    ).run();
    runMigrations(db);
    expect(milestones(db, 'gate_item')).toEqual(['Backlog Cleanup']);
  });

  it('normalizes seed_item_source.source_task_id from raw to prefixed', () => {
    db.prepare(
      `INSERT INTO seed_item (id, project, milestone, spec, state, updated_at)
       VALUES ('si-1', 'p1', 'M11', 'spec', 'pending', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO seed_item_source (seed_item_id, source_task_id, source_task_title, added_at)
       VALUES ('si-1', 'abc123', 'Task A', '2026-01-01')`,
    ).run();
    runMigrations(db);
    const rows = db
      .prepare('SELECT source_task_id FROM seed_item_source')
      .all() as { source_task_id: string }[];
    expect(rows.map((r) => r.source_task_id)).toEqual(['notion:abc123']);
  });

  it('normalizes gate_accretion.source_task_id from raw to prefixed', () => {
    db.prepare(
      `INSERT INTO gate_accretion (source_task_id, project, milestone, decision, accreted_at)
       VALUES ('abc123', 'p1', 'M11', 'items', '2026-01-01')`,
    ).run();
    runMigrations(db);
    const row = db.prepare('SELECT * FROM gate_accretion').get() as {
      source_task_id: string;
    };
    expect(row.source_task_id).toBe('notion:abc123');
  });

  it('normalizes seed_accretion.source_task_id from raw to prefixed', () => {
    db.prepare(
      `INSERT INTO seed_accretion (source_task_id, project, milestone, decision, accreted_at)
       VALUES ('abc123', 'p1', 'M11', 'seeds', '2026-01-01')`,
    ).run();
    runMigrations(db);
    const row = db.prepare('SELECT * FROM seed_accretion').get() as {
      source_task_id: string;
    };
    expect(row.source_task_id).toBe('notion:abc123');
  });

  it('merges a raw-keyed gate_accretion marker into an existing prefixed one, keeping the newer decision', () => {
    db.prepare(
      `INSERT INTO gate_accretion (source_task_id, project, milestone, decision, accreted_at)
       VALUES ('notion:abc123', 'p1', 'M11', 'none', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO gate_accretion (source_task_id, project, milestone, decision, accreted_at)
       VALUES ('abc123', 'p1', 'M11', 'items', '2026-02-01')`,
    ).run();
    runMigrations(db);
    const rows = db.prepare('SELECT * FROM gate_accretion').all() as {
      source_task_id: string;
      decision: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].source_task_id).toBe('notion:abc123');
    expect(rows[0].decision).toBe('items');
  });

  it('idempotent — running twice produces the same result', () => {
    db.prepare(
      `INSERT INTO gate_item (id, project, milestone, text, classification, state, updated_at)
       VALUES ('gi-1', 'p1', 'M11 — Orchestrator-Owned Planning', 'text', 'needs-triage', 'open', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO gate_accretion (source_task_id, project, milestone, decision, accreted_at)
       VALUES ('abc123', 'p1', 'M11', 'items', '2026-01-01')`,
    ).run();
    runMigrations(db);
    const after1 = {
      milestones: milestones(db, 'gate_item'),
      accretion: db.prepare('SELECT * FROM gate_accretion').all(),
    };
    runMigrations(db);
    const after2 = {
      milestones: milestones(db, 'gate_item'),
      accretion: db.prepare('SELECT * FROM gate_accretion').all(),
    };
    expect(after2).toEqual(after1);
  });
});
