/**
 * Tests for the gate_item_source(source_task_id)/seed_item_source(source_task_id)
 * indexes.
 *
 * getAutoGrantDisagreementRate (queries.ts) issues one
 * `SELECT DISTINCT gate_item_id FROM gate_item_source WHERE source_task_id = ?`
 * (or the seed_item_source equivalent) per auto-approved committed intent.
 * Both tables were indexed only by their own item id — never by
 * source_task_id — so this lookup fell back to a full scan. These assert
 * the access path, not timing, so a regression shows up as a plan change
 * rather than a flaky benchmark.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';

function planFor(sql: string, params: unknown[]): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
      detail: string;
    }[]
  )
    .map((r) => r.detail)
    .join(' | ');
}

const GATE_ITEM_SOURCE_SQL = `
  SELECT DISTINCT gate_item_id FROM gate_item_source WHERE source_task_id = ?
`;
const SEED_ITEM_SOURCE_SQL = `
  SELECT DISTINCT seed_item_id FROM seed_item_source WHERE source_task_id = ?
`;

describe('gate_item_source(source_task_id) index', () => {
  it('is created by the schema', () => {
    const idx = db.prepare(`PRAGMA index_list(gate_item_source)`).all() as {
      name: string;
    }[];
    expect(idx.map((i) => i.name)).toContain(
      'idx_gate_item_source_source_task_id',
    );
  });

  it('resolves the gate.accrete disagreement-rate lookup by source_task_id without scanning the table', () => {
    const plan = planFor(GATE_ITEM_SOURCE_SQL, ['task-1']);
    expect(plan).toMatch(
      /SEARCH gate_item_source USING INDEX idx_gate_item_source_source_task_id/,
    );
    expect(plan).not.toMatch(/SCAN gate_item_source/);
  });
});

describe('seed_item_source(source_task_id) index', () => {
  it('is created by the schema', () => {
    const idx = db.prepare(`PRAGMA index_list(seed_item_source)`).all() as {
      name: string;
    }[];
    expect(idx.map((i) => i.name)).toContain(
      'idx_seed_item_source_source_task_id',
    );
  });

  it('resolves the seed.stage disagreement-rate lookup by source_task_id without scanning the table', () => {
    const plan = planFor(SEED_ITEM_SOURCE_SQL, ['task-1']);
    expect(plan).toMatch(
      /SEARCH seed_item_source USING INDEX idx_seed_item_source_source_task_id/,
    );
    expect(plan).not.toMatch(/SCAN seed_item_source/);
  });
});
