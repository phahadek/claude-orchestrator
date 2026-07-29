/**
 * Tests for the seed-application run API (packages/backend/src/seed/seedService.ts).
 *
 * AC: getSeedReadiness is blocked with the blocking set while any seed is
 * not confirmed, and green once all are confirmed; nextApplyableSeedItems
 * returns only deploy-included, not-confirmed seeds, one bounded batch at a
 * time (never the full set); appendSeedItemEvent advances state and requires
 * a filedFollowon on a blocked outcome; the service records operator
 * outcomes and has no auto-apply path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { insertItem, setMinDeployedCommit, getItem } from '../seedStore.js';
import {
  getSeedReadiness,
  nextApplyableSeedItems,
  getSeedItem,
  getSeedItemDetail,
  listSeedItems,
  listSeedMilestoneReadiness,
  appendSeedItemEvent,
} from '../seedService.js';
import type { DeployAncestrySource } from '../../gate/gateService.js';

beforeEach(() => {
  db.prepare('DELETE FROM seed_item_event').run();
  db.prepare('DELETE FROM seed_item_source').run();
  db.prepare('DELETE FROM seed_item').run();
  db.prepare('DELETE FROM audit_log').run();
});

function makeItem(overrides: Partial<Parameters<typeof insertItem>[0]> = {}) {
  return insertItem({
    project: 'polimarket-analyser',
    milestone: 'M12',
    spec: 'Set ALERT_THRESHOLD_MS to 500 in config',
    sources: [{ sourceTaskId: 'notion:abc', sourceTaskTitle: 'Add config' }],
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });
}

/** A total order over sha strings — later strings are "descendants" of earlier ones. */
const orderedAncestry: DeployAncestrySource = {
  isAncestor(ancestor, descendant) {
    return ancestor <= descendant;
  },
};

describe('getSeedReadiness', () => {
  it('is blocked with the blocking set while any seed is not confirmed', () => {
    const item = makeItem({ spec: 'unresolved seed' });
    const readiness = getSeedReadiness('polimarket-analyser', 'M12');
    expect(readiness.status).toBe('blocked');
    expect(readiness.blocking).toHaveLength(1);
    expect(readiness.blocking[0]).toMatchObject({
      id: item.id,
      spec: 'unresolved seed',
    });
  });

  it('is green once every seed is confirmed', () => {
    const item = makeItem();
    appendSeedItemEvent(item.id, { outcome: 'applied' });
    appendSeedItemEvent(item.id, { outcome: 'confirmed' });

    const readiness = getSeedReadiness('polimarket-analyser', 'M12');
    expect(readiness.status).toBe('green');
    expect(readiness.blocking).toEqual([]);
  });

  it('ignores seeds from other milestones', () => {
    makeItem({ milestone: 'M13' });
    expect(getSeedReadiness('polimarket-analyser', 'M12').status).toBe(
      'green',
    );
  });

  it('ignores seeds from another project sharing the same milestone display name', () => {
    makeItem({
      project: 'claude-dashboard',
      milestone: 'M13',
      spec: 'dashboard seed',
    });
    makeItem({
      project: 'polimarket-analyser',
      milestone: 'M13',
      spec: 'polimarket seed',
    });

    const readiness = getSeedReadiness('claude-dashboard', 'M13');
    expect(readiness.blocking).toHaveLength(1);
    expect(readiness.blocking[0]).toMatchObject({
      project: 'claude-dashboard',
      spec: 'dashboard seed',
    });
  });

  it('returns per-state counts summing to the milestone item total', () => {
    const confirmed = makeItem({ spec: 'a' });
    makeItem({ spec: 'b' });
    appendSeedItemEvent(confirmed.id, { outcome: 'applied' });
    appendSeedItemEvent(confirmed.id, { outcome: 'confirmed' });

    const readiness = getSeedReadiness('polimarket-analyser', 'M12');
    expect(readiness.counts).toEqual({ confirmed: 1, pending: 1 });
    expect(Object.values(readiness.counts).reduce((sum, n) => sum + n, 0)).toBe(
      2,
    );
  });
});

describe('nextApplyableSeedItems', () => {
  it('returns only deploy-included, not-confirmed seeds', () => {
    const notDeployed = makeItem({ spec: 'no min commit yet' });
    const deployed = makeItem({ spec: 'deploy-included' });
    setMinDeployedCommit(deployed.id, 'sha2', new Date(1).toISOString());
    const notYetDeployed = makeItem({ spec: 'ahead of the deploy' });
    setMinDeployedCommit(notYetDeployed.id, 'sha5', new Date(1).toISOString());

    const applyable = nextApplyableSeedItems('polimarket-analyser', 'M12', 'sha3', {
      ancestrySource: orderedAncestry,
      limit: 10,
    });

    expect(applyable.map((i) => i.id)).toEqual([deployed.id]);
    expect(applyable.map((i) => i.id)).not.toContain(notDeployed.id);
    expect(applyable.map((i) => i.id)).not.toContain(notYetDeployed.id);
  });

  it('never returns another project\'s seed items under the same milestone display name', () => {
    const own = makeItem({ project: 'claude-dashboard', milestone: 'M13' });
    const other = makeItem({ project: 'polimarket-analyser', milestone: 'M13' });
    setMinDeployedCommit(own.id, 'sha1', new Date(1).toISOString());
    setMinDeployedCommit(other.id, 'sha1', new Date(1).toISOString());

    const applyable = nextApplyableSeedItems(
      'claude-dashboard',
      'M13',
      'sha9',
      { ancestrySource: orderedAncestry, limit: 10 },
    );
    expect(applyable.map((i) => i.id)).toEqual([own.id]);
  });

  it('excludes already-confirmed seeds even when deploy-included', () => {
    const item = makeItem();
    setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
    appendSeedItemEvent(item.id, { outcome: 'applied' });
    appendSeedItemEvent(item.id, { outcome: 'confirmed' });

    const applyable = nextApplyableSeedItems('polimarket-analyser', 'M12', 'sha9', {
      ancestrySource: orderedAncestry,
      limit: 10,
    });
    expect(applyable).toEqual([]);
  });

  it('surfaces one bounded batch at a time, never the full applyable set', () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      makeItem({ spec: `seed ${i}` }),
    );
    for (const item of items) {
      setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
    }

    const defaultBatch = nextApplyableSeedItems('polimarket-analyser', 'M12', 'sha9', {
      ancestrySource: orderedAncestry,
    });
    expect(defaultBatch.length).toBe(1);

    const smallBatch = nextApplyableSeedItems('polimarket-analyser', 'M12', 'sha9', {
      ancestrySource: orderedAncestry,
      limit: 3,
    });
    expect(smallBatch.length).toBe(3);
    expect(smallBatch.length).toBeLessThan(items.length);
  });
});

describe('appendSeedItemEvent', () => {
  it('advances state through applied -> confirmed', () => {
    const item = makeItem();
    appendSeedItemEvent(item.id, { outcome: 'applied', operator: 'pedro' });
    expect(getSeedItem(item.id)?.state).toBe('applied');

    appendSeedItemEvent(item.id, { outcome: 'confirmed', operator: 'pedro' });
    expect(getSeedItem(item.id)?.state).toBe('confirmed');
  });

  it('requires a filedFollowon on a blocked outcome', () => {
    const item = makeItem();
    expect(() =>
      appendSeedItemEvent(item.id, { outcome: 'blocked', operator: 'pedro' }),
    ).toThrow();
    expect(getItem(item.id)?.state).toBe('pending');

    appendSeedItemEvent(item.id, {
      outcome: 'blocked',
      operator: 'pedro',
      filedFollowon: 'notion:followon-1',
    });
    expect(getSeedItem(item.id)?.state).toBe('blocked');
  });

  it('records the operator outcome as an event with evidence', () => {
    const item = makeItem();
    appendSeedItemEvent(item.id, {
      outcome: 'applied',
      evidence: { observed: 'config write succeeded' },
      operator: 'pedro',
    });
    const updated = getSeedItem(item.id);
    expect(updated?.events).toHaveLength(1);
    expect(updated?.events[0]).toMatchObject({
      outcome: 'applied',
      operator: 'pedro',
      evidence: { observed: 'config write succeeded' },
    });
  });
});

describe('getSeedItemDetail', () => {
  it('returns the item, its sources, and its full event history, by value', () => {
    const item = makeItem();
    appendSeedItemEvent(item.id, { outcome: 'applied', operator: 'pedro' });
    appendSeedItemEvent(item.id, { outcome: 'confirmed', operator: 'pedro' });

    const detail = getSeedItemDetail(item.id);
    expect(detail?.item).toMatchObject({ id: item.id, state: 'confirmed' });
    expect(detail?.sources).toHaveLength(1);
    expect(detail?.sources[0]).toMatchObject({ sourceTaskId: 'notion:abc' });
    expect(detail?.events.map((e) => e.outcome)).toEqual([
      'applied',
      'confirmed',
    ]);
  });

  it('returns undefined for a missing item', () => {
    expect(getSeedItemDetail('missing')).toBeUndefined();
  });
});

describe('listSeedItems', () => {
  it('filters by project, milestone, and state', () => {
    makeItem({ project: 'p1', milestone: 'M12', spec: 'a' });
    const other = makeItem({ project: 'p2', milestone: 'M12', spec: 'b' });
    makeItem({ project: 'p1', milestone: 'M13', spec: 'c' });

    const result = listSeedItems({ project: 'p2', milestone: 'M12' });
    expect(result.items.map((i) => i.id)).toEqual([other.id]);
    expect(result.total).toBe(1);
    expect(result.page).toBe(1);
  });

  it('paginates instead of returning an unbounded load', () => {
    for (let i = 0; i < 5; i++) {
      makeItem({ spec: `seed ${i}` });
    }

    const page1 = listSeedItems({ limit: 2, page: 1 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = listSeedItems({ limit: 2, page: 2 });
    expect(page2.items).toHaveLength(2);
    expect(page2.items.map((i) => i.id)).not.toEqual(
      page1.items.map((i) => i.id),
    );
  });

  it('caps the limit and never returns an unbounded set', () => {
    for (let i = 0; i < 3; i++) {
      makeItem({ spec: `seed ${i}` });
    }
    const result = listSeedItems({ limit: 10000 });
    expect(result.items).toHaveLength(3);
  });

  it('order: not-done-first sorts unconfirmed seeds ahead of confirmed ones', () => {
    const confirmed = makeItem({ spec: 'confirmed' });
    const pending = makeItem({ spec: 'pending' });
    appendSeedItemEvent(confirmed.id, { outcome: 'applied' });
    appendSeedItemEvent(confirmed.id, { outcome: 'confirmed' });

    const result = listSeedItems({ order: 'not-done-first' });
    expect(result.items.map((i) => i.id)).toEqual([pending.id, confirmed.id]);
  });
});

describe('listSeedMilestoneReadiness', () => {
  it('rolls up per-milestone green/blocked within a project', () => {
    const greenItem = makeItem({
      project: 'p1',
      milestone: 'M-green',
      spec: 'a',
    });
    appendSeedItemEvent(greenItem.id, { outcome: 'applied' });
    appendSeedItemEvent(greenItem.id, { outcome: 'confirmed' });
    makeItem({ project: 'p1', milestone: 'M-blocked', spec: 'b' });

    const result = listSeedMilestoneReadiness({ project: 'p1' });
    expect(result).toEqual([
      {
        project: 'p1',
        milestone: 'M-blocked',
        status: 'blocked',
        blockingCount: 1,
      },
      {
        project: 'p1',
        milestone: 'M-green',
        status: 'green',
        blockingCount: 0,
      },
    ]);
  });

  it('rolls up across projects when no project filter is given', () => {
    makeItem({ project: 'p1', milestone: 'M12', spec: 'a' });
    makeItem({ project: 'p2', milestone: 'M12', spec: 'b' });

    const result = listSeedMilestoneReadiness();
    expect(result.map((r) => r.project)).toEqual(['p1', 'p2']);
    expect(result.every((r) => r.status === 'blocked')).toBe(true);
  });
});

describe('no auto-apply path', () => {
  it("exposes no function that applies config on the seed item's behalf", async () => {
    const seedService = await import('../seedService.js');
    const exportNames = Object.keys(seedService);
    const applyLike = exportNames.filter(
      (name) => /apply/i.test(name) && name !== 'nextApplyableSeedItems',
    );
    expect(applyLike).toEqual([]);
  });
});
