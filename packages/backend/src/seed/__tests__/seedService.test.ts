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
    const readiness = getSeedReadiness('M12');
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

    const readiness = getSeedReadiness('M12');
    expect(readiness.status).toBe('green');
    expect(readiness.blocking).toEqual([]);
  });

  it('ignores seeds from other milestones', () => {
    makeItem({ milestone: 'M13' });
    expect(getSeedReadiness('M12').status).toBe('green');
  });
});

describe('nextApplyableSeedItems', () => {
  it('returns only deploy-included, not-confirmed seeds', () => {
    const notDeployed = makeItem({ spec: 'no min commit yet' });
    const deployed = makeItem({ spec: 'deploy-included' });
    setMinDeployedCommit(deployed.id, 'sha2', new Date(1).toISOString());
    const notYetDeployed = makeItem({ spec: 'ahead of the deploy' });
    setMinDeployedCommit(notYetDeployed.id, 'sha5', new Date(1).toISOString());

    const applyable = nextApplyableSeedItems('M12', 'sha3', {
      ancestrySource: orderedAncestry,
      limit: 10,
    });

    expect(applyable.map((i) => i.id)).toEqual([deployed.id]);
    expect(applyable.map((i) => i.id)).not.toContain(notDeployed.id);
    expect(applyable.map((i) => i.id)).not.toContain(notYetDeployed.id);
  });

  it('excludes already-confirmed seeds even when deploy-included', () => {
    const item = makeItem();
    setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
    appendSeedItemEvent(item.id, { outcome: 'applied' });
    appendSeedItemEvent(item.id, { outcome: 'confirmed' });

    const applyable = nextApplyableSeedItems('M12', 'sha9', {
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

    const defaultBatch = nextApplyableSeedItems('M12', 'sha9', {
      ancestrySource: orderedAncestry,
    });
    expect(defaultBatch.length).toBe(1);

    const smallBatch = nextApplyableSeedItems('M12', 'sha9', {
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
