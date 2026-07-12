/**
 * Tests for the gate-state backend store (packages/backend/src/gate/gateStore.ts).
 *
 * AC: the three tables (gate_item, gate_item_source, gate_item_event) are
 * created by a forward migration with the (project, milestone) index; ids
 * are accretion-minted rather than text hashes; an item round-trips with
 * its sources and an appended event (by value); min_deployed_commit is
 * nullable and defaults empty.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  getItem,
  listByMilestone,
  insertItem,
  appendEvent,
  advanceState,
  setSourceMergeCommit,
} from '../gateStore.js';

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('gate_item schema', () => {
  it('creates the three tables', () => {
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('gate_item','gate_item_source','gate_item_event')`,
      )
      .all() as { name: string }[];
    expect(names.map((r) => r.name).sort()).toEqual([
      'gate_item',
      'gate_item_event',
      'gate_item_source',
    ]);
  });

  it('has the (project, milestone) index on gate_item', () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='gate_item' AND name='idx_gate_item_project_milestone'`,
      )
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_gate_item_project_milestone');
  });
});

describe('gateStore', () => {
  it('mints an accretion id, not a text hash of the content', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Verify the deploy script writes the new env var',
      classification: 'needs-triage',
      sources: [{ sourceTaskId: 'notion:abc', sourceTaskTitle: 'Add env var' }],
      updatedAt: new Date(0).toISOString(),
    });
    // A text hash (e.g. sha256 hex) is 64 hex chars; a minted id is a UUID.
    expect(item.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('defaults min_deployed_commit to empty (nullable until source-task merge)', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Check the alert threshold',
      classification: 'Read-Only',
      sources: [{ sourceTaskId: 'notion:xyz', sourceTaskTitle: 'Add alert' }],
      updatedAt: new Date(0).toISOString(),
    });
    expect(item.minDeployedCommit).toBeUndefined();
  });

  it('round-trips an item with its sources and an appended event by value', () => {
    const created = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Confirm resolution review flags stale entries',
      classification: 'Opportunistic',
      sources: [
        { sourceTaskId: 'notion:s1', sourceTaskTitle: 'Task one' },
        { sourceTaskId: 'notion:s2', sourceTaskTitle: 'Task two' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    appendEvent(created.id, {
      disposition: 'pass',
      evidence: { observed: 'threshold fired correctly', source: 'manual-run' },
      operator: 'pedro',
      at: new Date(1).toISOString(),
    });

    const item = getItem(created.id);
    expect(item?.sources).toHaveLength(2);
    expect(item?.sources.map((s) => s.sourceTaskId).sort()).toEqual([
      'notion:s1',
      'notion:s2',
    ]);
    expect(item?.events).toHaveLength(1);
    expect(item?.events[0]).toMatchObject({
      disposition: 'pass',
      operator: 'pedro',
      evidence: { observed: 'threshold fired correctly', source: 'manual-run' },
    });
  });

  it('advances the denormalized state and current_disposition', () => {
    const created = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Spot-check the new webhook',
      classification: 'Prod-Mutating',
      sources: [{ sourceTaskId: 'notion:w1', sourceTaskTitle: 'Add webhook' }],
      updatedAt: new Date(0).toISOString(),
    });

    advanceState(created.id, 'closed', 'pass', new Date(2).toISOString());

    const item = getItem(created.id);
    expect(item?.state).toBe('closed');
    expect(item?.currentDisposition).toBe('pass');
  });

  it('fills min_deployed_commit style merge_commit on a source at source-task merge time', () => {
    const created = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Verify the migration ran cleanly',
      classification: 'needs-triage',
      sources: [
        { sourceTaskId: 'notion:m1', sourceTaskTitle: 'Add migration' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    setSourceMergeCommit(created.id, 'notion:m1', 'deadbeef');

    const item = getItem(created.id);
    expect(item?.sources[0].mergeCommit).toBe('deadbeef');
  });

  it('lists items scoped to a project and milestone', () => {
    insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Item A',
      classification: 'needs-triage',
      sources: [{ sourceTaskId: 'notion:a', sourceTaskTitle: 'A' }],
      updatedAt: new Date(0).toISOString(),
    });
    insertItem({
      project: 'polimarket-analyser',
      milestone: 'M13',
      text: 'Item B',
      classification: 'needs-triage',
      sources: [{ sourceTaskId: 'notion:b', sourceTaskTitle: 'B' }],
      updatedAt: new Date(0).toISOString(),
    });

    const m12Items = listByMilestone('polimarket-analyser', 'M12');
    expect(m12Items).toHaveLength(1);
    expect(m12Items[0].text).toBe('Item A');
  });
});
