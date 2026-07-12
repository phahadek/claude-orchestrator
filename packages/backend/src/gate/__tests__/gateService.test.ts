/**
 * Tests for the gate-state API (packages/backend/src/gate/gateService.ts).
 *
 * AC: getGateReadiness is blocked while any item is unresolved and green once
 * all items are pass/deferred; reconcileGateRunnability marks items runnable
 * only when the injected deploy SHA contains min_deployed_commit (via the
 * injected ancestry source) and re-opens a pass superseded by a later-commit
 * source; nextRunnableGateItems returns a bounded, single-tier batch;
 * appendGateItemEvent advances denormalized state; approveGateItem releases a
 * Prod-Mutating item held at pending-approval.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { insertItem, setMinDeployedCommit } from '../gateStore.js';
import {
  getGateReadiness,
  reconcileGateRunnability,
  nextRunnableGateItems,
  getGateItem,
  appendGateItemEvent,
  approveGateItem,
  type DeployAncestrySource,
} from '../gateService.js';

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM audit_log').run();
});

function makeItem(overrides: Partial<Parameters<typeof insertItem>[0]> = {}) {
  return insertItem({
    project: 'polimarket-analyser',
    milestone: 'M12',
    text: 'Verify the deploy script writes the new env var',
    classification: 'Read-Only',
    sources: [{ sourceTaskId: 'notion:abc', sourceTaskTitle: 'Add env var' }],
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

describe('getGateReadiness', () => {
  it('is blocked while any item is unresolved', () => {
    makeItem({ text: 'unresolved item' });
    const readiness = getGateReadiness('M12');
    expect(readiness.status).toBe('blocked');
    expect(readiness.blocking).toHaveLength(1);
    expect(readiness.blocking[0]).toMatchObject({ text: 'unresolved item' });
  });

  it('is green once every item is pass or deferred', () => {
    const passed = makeItem({ text: 'a' });
    const deferred = makeItem({ text: 'b' });
    appendGateItemEvent(passed.id, { disposition: 'pass' });
    appendGateItemEvent(deferred.id, { disposition: 'deferred' });

    const readiness = getGateReadiness('M12');
    expect(readiness.status).toBe('green');
    expect(readiness.blocking).toEqual([]);
  });

  it('ignores items from other milestones', () => {
    makeItem({ milestone: 'M13' });
    expect(getGateReadiness('M12').status).toBe('green');
  });
});

describe('reconcileGateRunnability', () => {
  it('marks an item runnable only when deploySha contains min_deployed_commit', () => {
    const item = makeItem();
    setMinDeployedCommit(item.id, 'sha3', new Date(1).toISOString());

    const notYet = reconcileGateRunnability('sha2', {
      ancestrySource: orderedAncestry,
    });
    expect(notYet.markedRunnable).toEqual([]);
    expect(getGateItem(item.id)?.state).toBe('open');

    const now = reconcileGateRunnability('sha3', {
      ancestrySource: orderedAncestry,
    });
    expect(now.markedRunnable).toEqual([item.id]);
    expect(getGateItem(item.id)?.state).toBe('runnable');
  });

  it('re-opens a pass superseded by a later-commit source', () => {
    const item = makeItem();
    setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
    reconcileGateRunnability('sha1', { ancestrySource: orderedAncestry });
    appendGateItemEvent(item.id, { disposition: 'pass', deploySha: 'sha1' });
    expect(getGateItem(item.id)?.state).toBe('pass');

    // A later source lands, pushing min_deployed_commit past what was deployed at pass-time.
    setMinDeployedCommit(item.id, 'sha2', new Date(2).toISOString());

    const stillOnSha1 = reconcileGateRunnability('sha1', {
      ancestrySource: orderedAncestry,
    });
    expect(stillOnSha1.reopened).toEqual([item.id]);
    expect(getGateItem(item.id)?.state).toBe('open');

    const advanced = reconcileGateRunnability('sha2', {
      ancestrySource: orderedAncestry,
    });
    expect(advanced.markedRunnable).toEqual([item.id]);
    expect(getGateItem(item.id)?.state).toBe('runnable');
  });

  it('leaves a still-valid pass alone', () => {
    const item = makeItem();
    setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
    reconcileGateRunnability('sha1', { ancestrySource: orderedAncestry });
    appendGateItemEvent(item.id, { disposition: 'pass', deploySha: 'sha1' });

    const result = reconcileGateRunnability('sha1', {
      ancestrySource: orderedAncestry,
    });
    expect(result.reopened).toEqual([]);
    expect(getGateItem(item.id)?.state).toBe('pass');
  });
});

describe('nextRunnableGateItems', () => {
  it('returns a bounded batch scoped to a single classification tier', () => {
    const items = Array.from({ length: 3 }, (_, i) =>
      makeItem({ text: `read-only ${i}`, classification: 'Read-Only' }),
    );
    const prodItem = makeItem({
      text: 'prod-mutating',
      classification: 'Prod-Mutating',
    });
    for (const it of [...items, prodItem]) {
      setMinDeployedCommit(it.id, 'sha1', new Date(1).toISOString());
    }
    reconcileGateRunnability('sha1', { ancestrySource: orderedAncestry });

    const batch = nextRunnableGateItems('M12', {
      classification: 'Read-Only',
      limit: 2,
    });
    expect(batch).toHaveLength(2);
    expect(batch.every((it) => it.classification === 'Read-Only')).toBe(true);
  });

  it('never returns the full runnable set across tiers when classification is omitted', () => {
    const readOnly = makeItem({ text: 'ro', classification: 'Read-Only' });
    const prod = makeItem({ text: 'pm', classification: 'Prod-Mutating' });
    for (const it of [readOnly, prod]) {
      setMinDeployedCommit(it.id, 'sha1', new Date(1).toISOString());
    }
    reconcileGateRunnability('sha1', { ancestrySource: orderedAncestry });

    const batch = nextRunnableGateItems('M12');
    const tiers = new Set(batch.map((it) => it.classification));
    expect(tiers.size).toBe(1);
  });
});

describe('appendGateItemEvent', () => {
  it('advances the denormalized state for a non-Prod-Mutating pass', () => {
    const item = makeItem({ classification: 'Read-Only' });
    const updated = appendGateItemEvent(item.id, { disposition: 'pass' });
    expect(updated.state).toBe('pass');
    expect(updated.currentDisposition).toBe('pass');
    expect(updated.events).toHaveLength(1);
  });

  it('routes a Prod-Mutating pass to pending-approval instead of resolving it', () => {
    const item = makeItem({ classification: 'Prod-Mutating' });
    const updated = appendGateItemEvent(item.id, { disposition: 'pass' });
    expect(updated.state).toBe('pending-approval');
  });
});

describe('approveGateItem', () => {
  it('releases a Prod-Mutating item held at pending-approval to pass', () => {
    const item = makeItem({ classification: 'Prod-Mutating' });
    appendGateItemEvent(item.id, { disposition: 'pass' });
    expect(getGateItem(item.id)?.state).toBe('pending-approval');

    const approved = approveGateItem(item.id, 'pedro');
    expect(approved.state).toBe('pass');
    expect(approved.currentDisposition).toBe('pass');
  });

  it('rejects approval for a non-Prod-Mutating item', () => {
    const item = makeItem({ classification: 'Read-Only' });
    expect(() => approveGateItem(item.id)).toThrow();
  });

  it('rejects approval when not pending-approval', () => {
    const item = makeItem({ classification: 'Prod-Mutating' });
    expect(() => approveGateItem(item.id)).toThrow();
  });
});
