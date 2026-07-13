/**
 * Tests for the seed-state backend store (packages/backend/src/seed/seedStore.ts).
 *
 * AC: the three tables (seed_item, seed_item_source, seed_item_event) are
 * created by a forward migration with the (project, milestone) index; ids
 * are accretion-minted rather than text hashes; an item round-trips with
 * its sources and an appended event (by value); state is a single field
 * (no current_disposition); min_deployed_commit is nullable.
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
  setMinDeployedCommit,
  addSource,
  getAccretionMarker,
  recordAccretionMarker,
  rehomeItemsBySourceTask,
} from '../seedStore.js';

beforeEach(() => {
  db.prepare('DELETE FROM seed_item_event').run();
  db.prepare('DELETE FROM seed_item_source').run();
  db.prepare('DELETE FROM seed_item').run();
  db.prepare('DELETE FROM seed_accretion').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('seed_item schema', () => {
  it('creates the three tables', () => {
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('seed_item','seed_item_source','seed_item_event')`,
      )
      .all() as { name: string }[];
    expect(names.map((r) => r.name).sort()).toEqual([
      'seed_item',
      'seed_item_event',
      'seed_item_source',
    ]);
  });

  it('has the (project, milestone) index on seed_item', () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='seed_item' AND name='idx_seed_item_project_milestone'`,
      )
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_seed_item_project_milestone');
  });
});

describe('seedStore', () => {
  it('mints an accretion id, not a text hash of the content', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Set ALERT_THRESHOLD_MS to 500 in config',
      sources: [{ sourceTaskId: 'notion:abc', sourceTaskTitle: 'Add config' }],
      updatedAt: new Date(0).toISOString(),
    });
    // A text hash (e.g. sha256 hex) is 64 hex chars; a minted id is a UUID.
    expect(item.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('defaults min_deployed_commit to empty (nullable until source-task merge) and state to pending', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Add the new webhook secret',
      sources: [{ sourceTaskId: 'notion:xyz', sourceTaskTitle: 'Add secret' }],
      updatedAt: new Date(0).toISOString(),
    });
    expect(item.minDeployedCommit).toBeUndefined();
    expect(item.state).toBe('pending');
  });

  it('round-trips an item with its sources and an appended event by value', () => {
    const created = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Bump the resolution-review lookback window to 14 days',
      sources: [
        { sourceTaskId: 'notion:s1', sourceTaskTitle: 'Task one' },
        { sourceTaskId: 'notion:s2', sourceTaskTitle: 'Task two' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    appendEvent(created.id, {
      outcome: 'applied',
      evidence: { observed: 'config write succeeded', source: 'manual-run' },
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
      outcome: 'applied',
      operator: 'pedro',
      evidence: { observed: 'config write succeeded', source: 'manual-run' },
    });
  });

  it('advances the single state field (no current_disposition)', () => {
    const created = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Spot-check the new webhook config',
      sources: [{ sourceTaskId: 'notion:w1', sourceTaskTitle: 'Add webhook' }],
      updatedAt: new Date(0).toISOString(),
    });

    advanceState(created.id, 'applied', new Date(2).toISOString());
    let item = getItem(created.id);
    expect(item?.state).toBe('applied');
    expect(item).not.toHaveProperty('currentDisposition');

    advanceState(created.id, 'confirmed', new Date(3).toISOString());
    item = getItem(created.id);
    expect(item?.state).toBe('confirmed');
  });

  it('sets min_deployed_commit at source-task merge time', () => {
    const created = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Verify the migration config change',
      sources: [
        { sourceTaskId: 'notion:m1', sourceTaskTitle: 'Add migration' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    expect(getItem(created.id)?.minDeployedCommit).toBeUndefined();

    setMinDeployedCommit(created.id, 'deadbeef', new Date(1).toISOString());

    expect(getItem(created.id)?.minDeployedCommit).toBe('deadbeef');
  });

  it('fills merge_commit on a source at source-task merge time', () => {
    const created = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Verify the migration ran cleanly',
      sources: [
        { sourceTaskId: 'notion:m1', sourceTaskTitle: 'Add migration' },
      ],
      updatedAt: new Date(0).toISOString(),
    });

    setSourceMergeCommit(created.id, 'notion:m1', 'deadbeef');

    const item = getItem(created.id);
    expect(item?.sources[0].mergeCommit).toBe('deadbeef');
  });

  it('adds a new source to an existing item (re-open path)', () => {
    const created = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Bump the queue concurrency',
      sources: [{ sourceTaskId: 'notion:q1', sourceTaskTitle: 'Original' }],
      updatedAt: new Date(0).toISOString(),
    });

    addSource(
      created.id,
      { sourceTaskId: 'notion:q2', sourceTaskTitle: 'Follow-on fix' },
      new Date(1).toISOString(),
    );

    const item = getItem(created.id);
    expect(item?.sources).toHaveLength(2);
    expect(item?.sources.map((s) => s.sourceTaskId).sort()).toEqual([
      'notion:q1',
      'notion:q2',
    ]);
  });

  it('lists items scoped to a project and milestone', () => {
    insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Item A',
      sources: [{ sourceTaskId: 'notion:a', sourceTaskTitle: 'A' }],
      updatedAt: new Date(0).toISOString(),
    });
    insertItem({
      project: 'polimarket-analyser',
      milestone: 'M13',
      spec: 'Item B',
      sources: [{ sourceTaskId: 'notion:b', sourceTaskTitle: 'B' }],
      updatedAt: new Date(0).toISOString(),
    });

    const m12Items = listByMilestone('polimarket-analyser', 'M12');
    expect(m12Items).toHaveLength(1);
    expect(m12Items[0].spec).toBe('Item A');
  });
});

describe('seedStore.rehomeItemsBySourceTask — moveTask accretion carry', () => {
  it('re-homes every seed_item sourced from the moved task onto the target milestone', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Set ALERT_THRESHOLD_MS to 500 in config',
      sources: [{ sourceTaskId: 'notion:moved', sourceTaskTitle: 'Moved task' }],
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
      spec: 'Add the new webhook secret',
      sources: [{ sourceTaskId: 'notion:moved', sourceTaskTitle: 'Moved task' }],
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

  it('leaves seed_item_source.source_task_id pointing at the original task id', () => {
    const item = insertItem({
      project: 'polimarket-analyser',
      milestone: 'M12',
      spec: 'Add the new webhook secret',
      sources: [{ sourceTaskId: 'notion:moved', sourceTaskTitle: 'Moved task' }],
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
      spec: 'Unrelated item',
      sources: [{ sourceTaskId: 'notion:other', sourceTaskTitle: 'Other task' }],
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

describe('seed_accretion marker', () => {
  it('returns undefined for a source task with no marker recorded', () => {
    expect(getAccretionMarker('notion:untouched')).toBeUndefined();
  });

  it('round-trips a recorded marker', () => {
    recordAccretionMarker({
      sourceTaskId: 'notion:src-1',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'seeds',
      accretedAt: new Date(0).toISOString(),
    });

    const marker = getAccretionMarker('notion:src-1');
    expect(marker).toMatchObject({
      sourceTaskId: 'notion:src-1',
      project: 'polimarket-analyser',
      milestone: 'M12',
      decision: 'seeds',
    });
  });

  it('distinguishes seeds / none / n/a decisions', () => {
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
      decision: 'seeds',
      accretedAt: new Date(1).toISOString(),
    });

    expect(getAccretionMarker('notion:src-2')?.decision).toBe('seeds');
  });
});
