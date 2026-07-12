/**
 * Tests for the gate-verification reconciler
 * (packages/backend/src/gate/gateReconciler.ts).
 *
 * AC: the reconciler registers with the Scheduler and runs on tick; a
 * Read-Only item auto-runs + auto-disposes; a Prod-Mutating item is held
 * (pending-approval) until approveGateItem; a failing verification files a
 * follow-up fix task attached as a new gate_item_source and re-opens the
 * item; the deploy-advance trigger is injected behind an interface, not
 * hard-coded.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { insertItem, setMinDeployedCommit, getItem } from '../gateStore.js';
import { approveGateItem, reconcileGateRunnability } from '../gateService.js';
import {
  runGateReconcilerTick,
  register,
  type DeployAdvanceTrigger,
  type GateItemVerifier,
  type FollowupFixTaskFiler,
} from '../gateReconciler.js';

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

function makeRunnableItem(
  overrides: Partial<Parameters<typeof insertItem>[0]> = {},
) {
  const item = makeItem(overrides);
  setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
  reconcileGateRunnability('sha1');
  return item;
}

const fixedTrigger = (sha: string | null): DeployAdvanceTrigger => ({
  latestDeploySha: () => sha,
});

describe('register', () => {
  it('registers a job with the Scheduler that runs on tick', async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = { register: vi.fn(({ run: r }) => run.mockImplementation(r)) };
    register(scheduler as never);
    expect(scheduler.register).toHaveBeenCalledTimes(1);
    const opts = scheduler.register.mock.calls[0][0];
    expect(opts.name).toBe('gate_verification_reconciler');
    await opts.run({ signal: new AbortController().signal });
  });
});

describe('runGateReconcilerTick', () => {
  it('skips auto-run entirely when no verifier is injected', async () => {
    const item = makeRunnableItem();
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
    });
    expect(result.processed).toEqual([]);
    expect(getItem(item.id)?.state).toBe('runnable');
  });

  it('auto-runs and auto-disposes a Read-Only item on pass', async () => {
    const item = makeRunnableItem({ classification: 'Read-Only' });
    const verifier: GateItemVerifier = {
      verify: async () => ({ disposition: 'pass' }),
    };
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(result.processed).toEqual([
      { itemId: item.id, classification: 'Read-Only', disposition: 'pass' },
    ]);
    expect(getItem(item.id)?.state).toBe('pass');
    expect(result.readiness['M12'].status).toBe('green');
  });

  it('holds a Prod-Mutating item for operator consent until approveGateItem', async () => {
    const item = makeRunnableItem({ classification: 'Prod-Mutating' });
    const verifier: GateItemVerifier = {
      verify: async () => ({ disposition: 'pass' }),
    };
    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(getItem(item.id)?.state).toBe('pending-approval');

    const approved = approveGateItem(item.id, 'pedro');
    expect(approved.state).toBe('pass');
  });

  it('never auto-runs Opportunistic or needs-triage items', async () => {
    const opportunistic = makeRunnableItem({
      text: 'opportunistic',
      classification: 'Opportunistic',
    });
    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({ disposition: 'pass' })),
    };
    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(getItem(opportunistic.id)?.state).toBe('runnable');
  });

  it('files a follow-up fix task on failure, attaches it as a new source, and re-opens the item', async () => {
    const item = makeRunnableItem({ classification: 'Read-Only' });
    const verifier: GateItemVerifier = {
      verify: async () => ({ disposition: 'fail', evidence: { log: 'boom' } }),
    };
    const followupFiler: FollowupFixTaskFiler = {
      fileFollowupFixTask: vi.fn(async () => ({
        taskId: 'notion:followup-1',
        taskTitle: 'Fix gate item: Verify the deploy script writes the new env var',
      })),
    };
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
      followupFiler,
    });

    expect(followupFiler.fileFollowupFixTask).toHaveBeenCalledTimes(1);
    expect(result.processed).toEqual([
      { itemId: item.id, classification: 'Read-Only', disposition: 'fail' },
    ]);

    const updated = getItem(item.id)!;
    expect(updated.state).toBe('open');
    expect(updated.sources).toHaveLength(2);
    expect(updated.sources[1]).toMatchObject({
      sourceTaskId: 'notion:followup-1',
      sourceTaskTitle:
        'Fix gate item: Verify the deploy script writes the new env var',
    });
    expect(updated.events.at(-1)).toMatchObject({
      disposition: 'fail',
      filedFollowon: 'notion:followup-1',
    });
  });

  it('does not advance runnability when the deploy-advance trigger reports no advance', async () => {
    const item = makeItem();
    setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger(null),
    });
    expect(result.deploySha).toBeNull();
    expect(result.reconciled).toBeNull();
    expect(getItem(item.id)?.state).toBe('open');
  });

  it('rolls per-milestone readiness into the completion signal', async () => {
    makeItem({ milestone: 'M20', text: 'still open' });
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger(null),
    });
    expect(result.readiness['M20'].status).toBe('blocked');
  });
});
