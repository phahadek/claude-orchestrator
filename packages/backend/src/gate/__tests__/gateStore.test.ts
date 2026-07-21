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
  setClassification,
  setSourceMergeCommit,
  setMinDeployedCommit,
  getAccretionMarker,
  recordAccretionMarker,
  rehomeItemsBySourceTask,
  rollbackContribution,
} from '../gateStore.js';

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM gate_accretion').run();
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

  it('reclassifies a needs-triage item into a resolved tier and records an event', () => {
    const created = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Check the new gate reconciler tier',
      classification: 'needs-triage',
      sources: [{ sourceTaskId: 'notion:r1', sourceTaskTitle: 'Add tier' }],
      updatedAt: new Date(0).toISOString(),
    });

    const updated = setClassification(
      created.id,
      'Read-Only',
      new Date(1).toISOString(),
      'pedro',
    );

    expect(updated.classification).toBe('Read-Only');
    expect(updated.events).toHaveLength(1);
    expect(updated.events[0]).toMatchObject({
      disposition: 'reclassified',
      operator: 'pedro',
      evidence: { from: 'needs-triage', to: 'Read-Only' },
    });
  });

  it('rejects an invalid reclassification target', () => {
    const created = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Check the new gate reconciler tier',
      classification: 'needs-triage',
      sources: [{ sourceTaskId: 'notion:r2', sourceTaskTitle: 'Add tier' }],
      updatedAt: new Date(0).toISOString(),
    });

    expect(() =>
      setClassification(
        created.id,
        'bogus-tier' as never,
        new Date(1).toISOString(),
      ),
    ).toThrow(/invalid reclassification target/);
  });
});

describe('gateStore.rehomeItemsBySourceTask — moveTask accretion carry', () => {
  it('re-homes every gate_item sourced from the moved task onto the target milestone', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Verify the deploy script writes the new env var',
      classification: 'needs-triage',
      sources: [
        { sourceTaskId: 'notion:moved', sourceTaskTitle: 'Moved task' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    const rehomed = rehomeItemsBySourceTask(
      'polimarket-analyser',
      'notion:moved',
      'M13',
      new Date(1).toISOString(),
    );

    expect(rehomed).toEqual([item.id]);
    expect(getItem(item.id)?.milestone).toBe('M13');
  });

  it('leaves min_deployed_commit unchanged — commit-based and project-scoped, no recompute on a move', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Check the alert threshold',
      classification: 'Read-Only',
      sources: [
        { sourceTaskId: 'notion:moved', sourceTaskTitle: 'Moved task' },
      ],
      updatedAt: new Date(0).toISOString(),
    });
    setMinDeployedCommit(item.id, 'deadbeef', new Date(0).toISOString());

    rehomeItemsBySourceTask(
      'polimarket-analyser',
      'notion:moved',
      'M13',
      new Date(1).toISOString(),
    );

    expect(getItem(item.id)?.minDeployedCommit).toBe('deadbeef');
  });

  it('leaves gate_item_source.source_task_id pointing at the original task id', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Spot-check the new webhook',
      classification: 'Prod-Mutating',
      sources: [
        { sourceTaskId: 'notion:moved', sourceTaskTitle: 'Moved task' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    rehomeItemsBySourceTask(
      'polimarket-analyser',
      'notion:moved',
      'M13',
      new Date(1).toISOString(),
    );

    expect(getItem(item.id)?.sources[0].sourceTaskId).toBe('notion:moved');
  });

  it('does not touch items from other projects or unrelated source tasks', () => {
    const other = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Unrelated item',
      classification: 'needs-triage',
      sources: [
        { sourceTaskId: 'notion:other', sourceTaskTitle: 'Other task' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    const rehomed = rehomeItemsBySourceTask(
      'polimarket-analyser',
      'notion:moved',
      'M13',
      new Date(1).toISOString(),
    );

    expect(rehomed).toEqual([]);
    expect(getItem(other.id)?.milestone).toBe('M12');
  });
});

describe('gate_accretion marker', () => {
  it('returns undefined for a source task with no marker recorded', () => {
    expect(getAccretionMarker('notion:untouched')).toBeUndefined();
  });

  it('round-trips a recorded marker', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:src-1',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'items',
      accretedAt: new Date(0).toISOString(),
    });

    const marker = getAccretionMarker('notion:src-1');
    expect(marker).toMatchObject({
      sourceTaskId: 'notion:src-1',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'items',
    });
  });

  it('distinguishes items / none / n/a decisions', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:none-src',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'none',
      accretedAt: new Date(0).toISOString(),
    });
    recordAccretionMarker({
      sourceTaskId: 'notion:na-src',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'n/a',
      accretedAt: new Date(0).toISOString(),
    });

    expect(getAccretionMarker('notion:none-src')?.decision).toBe('none');
    expect(getAccretionMarker('notion:na-src')?.decision).toBe('n/a');
  });

  it('replaces an existing marker for the same source task', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:src-2',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'none',
      accretedAt: new Date(0).toISOString(),
    });
    recordAccretionMarker({
      sourceTaskId: 'notion:src-2',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'items',
      accretedAt: new Date(1).toISOString(),
    });

    expect(getAccretionMarker('notion:src-2')?.decision).toBe('items');
  });
});

describe('gateStore.rollbackContribution', () => {
  it('deletes the minted gate_item rows and the source task marker, leaving no orphan', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Verify the webhook fires',
      classification: 'Read-Only',
      sources: [
        { sourceTaskId: 'notion:src-1', sourceTaskTitle: 'Add the webhook' },
      ],
      updatedAt: new Date(0).toISOString(),
    });
    recordAccretionMarker({
      sourceTaskId: 'notion:src-1',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'items',
      accretedAt: new Date(0).toISOString(),
    });

    rollbackContribution([item.id], 'notion:src-1');

    expect(getItem(item.id)).toBeUndefined();
    expect(getAccretionMarker('notion:src-1')).toBeUndefined();
  });

  it('leaves other source tasks\' items and markers untouched', () => {
    const rolledBack = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Rolled back item',
      classification: 'Read-Only',
      sources: [
        { sourceTaskId: 'notion:src-1', sourceTaskTitle: 'Add the webhook' },
      ],
      updatedAt: new Date(0).toISOString(),
    });
    const untouched = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      text: 'Untouched item',
      classification: 'Read-Only',
      sources: [
        { sourceTaskId: 'notion:src-2', sourceTaskTitle: 'Add retries' },
      ],
      updatedAt: new Date(0).toISOString(),
    });
    recordAccretionMarker({
      sourceTaskId: 'notion:src-2',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'items',
      accretedAt: new Date(0).toISOString(),
    });

    rollbackContribution([rolledBack.id], 'notion:src-1');

    expect(getItem(rolledBack.id)).toBeUndefined();
    expect(getItem(untouched.id)).toBeDefined();
    expect(getAccretionMarker('notion:src-2')?.decision).toBe('items');
  });
});
