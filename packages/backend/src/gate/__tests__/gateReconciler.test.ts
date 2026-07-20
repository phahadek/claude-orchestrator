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

const deployServiceMock = vi.hoisted(() => ({
  getProjectDeployedSha: vi.fn(() => null as string | null),
}));
vi.mock('../../deploy/deployService.js', () => deployServiceMock);

import { db } from '../../db/db.js';
import { upsertTaskCache } from '../../db/queries.js';
import {
  insertItem,
  setMinDeployedCommit,
  advanceState,
  getItem,
} from '../gateStore.js';
import { approveGateItem, reconcileGateRunnability } from '../gateService.js';
import {
  runGateReconcilerTick,
  register,
  configureGateVerification,
  getGateVerificationOptions,
  type DeployAdvanceTrigger,
  type GateItemVerifier,
  type FollowupFixTaskFiler,
  type GateVerificationConcurrencyConfig,
} from '../gateReconciler.js';

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM task_cache').run();
  deployServiceMock.getProjectDeployedSha.mockReset().mockReturnValue(null);
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
    const scheduler = {
      register: vi.fn(({ run: r }) => run.mockImplementation(r)),
    };
    register(scheduler as never);
    expect(scheduler.register).toHaveBeenCalledTimes(1);
    const opts = scheduler.register.mock.calls[0][0];
    expect(opts.name).toBe('gate_verification_reconciler');
    await opts.run({ signal: new AbortController().signal });
  });
});

describe('configureGateVerification / getGateVerificationOptions', () => {
  it('returns null before anything has configured verification', () => {
    expect(getGateVerificationOptions()).toBeNull();
  });

  it('round-trips the verifier + followupFiler + concurrency config for the manual-dispatch surface to read back', () => {
    const verifier: GateItemVerifier = { verify: vi.fn() };
    const followupFiler: FollowupFixTaskFiler = {
      fileFollowupFixTask: vi.fn(),
    };
    const concurrency: GateVerificationConcurrencyConfig = {
      maxDispatchAttempts: 5,
      maxFixAttempts: 2,
    };

    configureGateVerification({ verifier, followupFiler, concurrency });

    const stored = getGateVerificationOptions();
    expect(stored?.verifier).toBe(verifier);
    expect(stored?.followupFiler).toBe(followupFiler);
    expect(stored?.concurrency).toEqual(concurrency);
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
    expect(getItem(item.id)?.events.at(-1)).toMatchObject({
      disposition: 'pass',
      operator: 'gate-verifier',
    });
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

  it('never auto-runs needs-triage items', async () => {
    const untriaged = makeRunnableItem({
      text: 'untriaged',
      classification: 'needs-triage',
    });
    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({ disposition: 'pass' })),
    };
    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(getItem(untriaged.id)?.state).toBe('runnable');
  });

  it('auto-runs and auto-disposes an Opportunistic item on pass', async () => {
    const item = makeRunnableItem({
      text: 'opportunistic',
      classification: 'Opportunistic',
    });
    const verifier: GateItemVerifier = {
      verify: async () => ({ disposition: 'pass' }),
    };
    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(getItem(item.id)?.state).toBe('pass');
  });

  it('files a follow-up fix task on failure, attaches it as a new source, and re-opens the item', async () => {
    const item = makeRunnableItem({ classification: 'Read-Only' });
    const verifier: GateItemVerifier = {
      verify: async () => ({ disposition: 'fail', evidence: { log: 'boom' } }),
    };
    const followupFiler: FollowupFixTaskFiler = {
      fileFollowupFixTask: vi.fn(async () => ({
        taskId: 'notion:followup-1',
        taskTitle:
          'Fix gate item: Verify the deploy script writes the new env var',
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

  it('needs-setup leaves the item runnable and the dispatcher skips it on the next pull', async () => {
    const item = makeRunnableItem({ classification: 'Read-Only' });
    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({
        disposition: 'needs-setup',
        evidence: { reason: 'budget exceeded' },
      })),
    };

    const first = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(first.processed).toEqual([
      {
        itemId: item.id,
        classification: 'Read-Only',
        disposition: 'needs-setup',
      },
    ]);
    expect(getItem(item.id)?.state).toBe('runnable');

    const second = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(second.processed).toEqual([]);
  });

  it('fail dedup: skips refiling while a prior filed follow-up is not yet Done', async () => {
    const item = makeRunnableItem({ classification: 'Read-Only' });
    const verifier: GateItemVerifier = {
      verify: async () => ({ disposition: 'fail', evidence: { log: 'boom' } }),
    };
    let callCount = 0;
    const followupFiler: FollowupFixTaskFiler = {
      fileFollowupFixTask: vi.fn(async () => {
        callCount += 1;
        return {
          taskId: `notion:followup-${callCount}`,
          taskTitle: `Fix gate item: attempt ${callCount}`,
        };
      }),
    };

    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
      followupFiler,
    });
    expect(followupFiler.fileFollowupFixTask).toHaveBeenCalledTimes(1);

    // Re-verify while notion:followup-1 is still open (no task_cache row = not Done).
    advanceState(
      item.id,
      'runnable',
      getItem(item.id)!.currentDisposition,
      new Date(2).toISOString(),
    );
    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
      followupFiler,
    });

    expect(followupFiler.fileFollowupFixTask).toHaveBeenCalledTimes(1);
    const updated = getItem(item.id)!;
    expect(updated.sources).toHaveLength(2);
    expect(updated.events.at(-1)).toMatchObject({
      disposition: 'fail',
      filedFollowon: 'notion:followup-1',
    });
  });

  it('fail dedup: refiles once the prior follow-up reaches Done and the item still fails', async () => {
    const item = makeRunnableItem({ classification: 'Read-Only' });
    const verifier: GateItemVerifier = {
      verify: async () => ({ disposition: 'fail', evidence: { log: 'boom' } }),
    };
    let callCount = 0;
    const followupFiler: FollowupFixTaskFiler = {
      fileFollowupFixTask: vi.fn(async () => {
        callCount += 1;
        return {
          taskId: `notion:followup-${callCount}`,
          taskTitle: `Fix gate item: attempt ${callCount}`,
        };
      }),
    };

    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
      followupFiler,
    });
    expect(followupFiler.fileFollowupFixTask).toHaveBeenCalledTimes(1);

    upsertTaskCache('notion:followup-1', JSON.stringify({ status: '✅ Done' }));
    advanceState(
      item.id,
      'runnable',
      getItem(item.id)!.currentDisposition,
      new Date(2).toISOString(),
    );
    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
      followupFiler,
    });

    expect(followupFiler.fileFollowupFixTask).toHaveBeenCalledTimes(2);
    const updated = getItem(item.id)!;
    expect(updated.sources).toHaveLength(3);
    expect(updated.events.at(-1)).toMatchObject({
      disposition: 'fail',
      filedFollowon: 'notion:followup-2',
    });
  });

  it('per-item in-flight guard prevents a duplicate dispatch of a live verify', async () => {
    makeRunnableItem({ classification: 'Read-Only' });
    let concurrentCalls = 0;
    let maxConcurrent = 0;
    const verifier: GateItemVerifier = {
      verify: async () => {
        concurrentCalls += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrentCalls -= 1;
        return { disposition: 'pass' };
      },
    };

    await Promise.all([
      runGateReconcilerTick({
        deployAdvanceTrigger: fixedTrigger('sha1'),
        verifier,
      }),
      runGateReconcilerTick({
        deployAdvanceTrigger: fixedTrigger('sha1'),
        verifier,
      }),
    ]);

    expect(maxConcurrent).toBe(1);
  });

  it('does not advance runnability when the deploy-advance trigger reports no advance', async () => {
    const item = makeItem();
    setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger(null),
    });
    expect(result.deployShaByProject['polimarket-analyser']).toBeNull();
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

describe('runGateReconcilerTick — default deploy-advance trigger (getProjectDeployedSha)', () => {
  const exactMatchAncestrySource = () => ({
    isAncestor: (ancestorSha: string, descendantSha: string) =>
      ancestorSha === descendantSha,
  });

  it('leaves a commit-gated item blocked when the project has never reported a deployed sha', async () => {
    deployServiceMock.getProjectDeployedSha.mockReturnValue(null);
    const gated = makeItem();
    setMinDeployedCommit(gated.id, 'sha1', new Date(1).toISOString());

    const result = await runGateReconcilerTick({
      ancestrySourceForProject: exactMatchAncestrySource,
    });

    expect(deployServiceMock.getProjectDeployedSha).toHaveBeenCalledWith(
      'polimarket-analyser',
    );
    expect(result.deployShaByProject['polimarket-analyser']).toBeNull();
    expect(getItem(gated.id)?.state).toBe('open');
  });

  it('still auto-runs an un-gated (null min-commit) item that is already runnable, even with no deployed sha', async () => {
    deployServiceMock.getProjectDeployedSha.mockReturnValue(null);
    const ungated = makeItem({ classification: 'Read-Only' });
    advanceState(ungated.id, 'runnable', undefined, new Date(1).toISOString());
    const verifier: GateItemVerifier = {
      verify: async () => ({ disposition: 'pass' }),
    };

    await runGateReconcilerTick({
      ancestrySourceForProject: exactMatchAncestrySource,
      verifier,
    });

    expect(getItem(ungated.id)?.state).toBe('pass');
  });

  it('marks a commit-gated item runnable once getProjectDeployedSha reports a covering sha', async () => {
    deployServiceMock.getProjectDeployedSha.mockReturnValue('sha1');
    const gated = makeItem();
    setMinDeployedCommit(gated.id, 'sha1', new Date(1).toISOString());

    const result = await runGateReconcilerTick({
      ancestrySourceForProject: exactMatchAncestrySource,
    });

    expect(result.deployShaByProject['polimarket-analyser']).toBe('sha1');
    expect(getItem(gated.id)?.state).toBe('runnable');
  });
});
