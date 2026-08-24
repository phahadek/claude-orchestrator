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

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

const deployServiceMock = vi.hoisted(() => ({
  getProjectDeployedSha: vi.fn(() => null as string | null),
}));
vi.mock('../../deploy/deployService.js', () => deployServiceMock);

import { db } from '../../db/db.js';
import {
  upsertTaskCache,
  upsertArm,
  archiveSession,
} from '../../db/queries.js';
import { typedSetSetting } from '../../config/settings.js';
import { ProjectService } from '../../projects/ProjectService.js';
import { logger } from '../../logger.js';
import {
  insertItem,
  setMinDeployedCommit,
  setSourceMergeCommit,
  advanceState,
  getItem,
  schedulePendingAttempt,
} from '../gateStore.js';
import {
  approveGateItem,
  appendGateItemEvent,
  reconcileGateRunnability,
  getGateReadiness,
} from '../gateService.js';
import { catchUpMergeCommits } from '../gateMergeConsumer.js';
import {
  runGateReconcilerTick,
  register,
  configureGateVerification,
  getGateVerificationOptions,
  dispatchGateItemVerification,
  reattachOutstandingGateVerifications,
  type DeployAdvanceTrigger,
  type GateItemVerifier,
  type FollowupFixTaskFiler,
  type GateVerificationConcurrencyConfig,
  type ReattachableGateItemVerifier,
} from '../gateReconciler.js';

// The reconciler resolves the gate item's milestone display name (what
// gate_item.milestone stores) to its milestone-table row id (what
// flow_arm.milestone_id keys on) before checking the arm — see
// resolveMilestoneRowForProject in gateReconciler.ts. M12's row is seeded
// once here so every test's flow_arm writes below key on the same id the
// reconciler resolves to.
let m12Id: string;
// A second, wrapped (closed-out) milestone in the same project — used by
// the wrapped-milestone-scoping tests below. Its gate_item rows exist in
// the same tables as M12's, so scoping must key off milestones.wrapped_at,
// not off some other project-level or table-level split.
let m11Id: string;

beforeAll(() => {
  ProjectService.create({
    id: 'polimarket-analyser',
    name: 'Polimarket Analyser',
    projectDir: '/tmp/polimarket-analyser',
  });
  m12Id = ProjectService.createMilestone({
    id: 'ms-uuid-m12',
    projectId: 'polimarket-analyser',
    name: 'M12',
    canonicalShortId: 'M12',
  }).id;
  m11Id = ProjectService.createMilestone({
    id: 'ms-uuid-m11',
    projectId: 'polimarket-analyser',
    name: 'M11',
    canonicalShortId: 'M11',
  }).id;
  ProjectService.updateMilestone(m11Id, { wrapped_at: 1 });
});

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM task_cache').run();
  db.prepare('DELETE FROM flow_arm').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM staged_intent').run();
  deployServiceMock.getProjectDeployedSha.mockReset().mockReturnValue(null);
  // Most tests below exercise auto-run behavior, which needs M12's
  // gate-verify arm on (DEFAULT_ARM is disarmed) — tests exercising the
  // disarmed/default/unresolvable paths explicitly override this.
  upsertArm(m12Id, 'gate-verify', true, 1);
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

/** Marks the item's (default, single) source as merged — the coverage computation in reconcileGateRunnability keys off the source's merge_commit, not min_deployed_commit directly. */
function mergeSource(
  itemId: string,
  sha: string,
  at: string,
  sourceTaskId = 'notion:abc',
) {
  setSourceMergeCommit(itemId, sourceTaskId, sha);
  setMinDeployedCommit(itemId, sha, at);
}

async function makeRunnableItem(
  overrides: Partial<Parameters<typeof insertItem>[0]> = {},
) {
  const item = makeItem(overrides);
  mergeSource(item.id, 'sha1', new Date(1).toISOString());
  await reconcileGateRunnability('sha1');
  return item;
}

const fixedTrigger = (sha: string | null): DeployAdvanceTrigger => ({
  latestDeploySha: () => sha,
});

/** Seeds a `sessions` row for a gate item, bypassing the real SessionManager — for exercising the DB-backed live-session guard directly, including the process-restart case where inFlightVerifications would be empty. */
function insertVerifySession(
  itemId: string,
  opts: { sessionId: string; status: string; startedAt?: number },
) {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, status, started_at)
     VALUES (@sessionId, @taskId, @status, @startedAt)`,
  ).run({
    sessionId: opts.sessionId,
    taskId: `gate-item:${itemId}`,
    status: opts.status,
    startedAt: opts.startedAt ?? 0,
  });
}

/** Seeds a pending `session.requestCapability` staged_intent for a session — the durable check `hasActiveCapabilityRequestForSession`/`getGateItemsWithPendingCapabilityRequest` key off. */
function insertPendingCapabilityRequest(sessionId: string) {
  db.prepare(
    `INSERT INTO staged_intent
       (id, kind, payload, payload_hash, project_id, session_id, state, created_at, updated_at)
     VALUES (@id, 'session.requestCapability', '{}', 'hash', 'polimarket-analyser', @sessionId, 'staged', 0, 0)`,
  ).run({ id: `intent-${sessionId}`, sessionId });
}

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

  it('reports items_processed as a negative count when the tick is skipped entirely for want of budget, distinct from a genuinely idle tick', async () => {
    // Exhaust the verify sub-limit specifically (rather than the planning
    // pool) so this test doesn't mutate max_concurrent_planning_sessions/
    // human_reserve — settings persist across tests in this file (see the
    // other describe blocks below), and doing so would leak into later
    // tests that rely on the default planning budget.
    typedSetSetting('max_concurrent_verify_sessions', 1);
    db.prepare(
      `INSERT INTO sessions (session_id, task_id, session_type, status, started_at)
       VALUES ('live-verify-1', 'gate-item:already-live', 'ops', 'running', 0)`,
    ).run();
    await makeRunnableItem({ classification: 'Read-Only' });

    const run = vi.fn(async () => undefined);
    const scheduler = {
      register: vi.fn(({ run: r }) => run.mockImplementation(r)),
    };
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    register(scheduler as never, {
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });
    const opts = scheduler.register.mock.calls[0][0];
    const result = await opts.run({ signal: new AbortController().signal });

    expect(verify).not.toHaveBeenCalled();
    expect(result.items_processed).toBe(-1);

    // Restore the default so later tests in this file that don't set their
    // own max_concurrent_verify_sessions aren't affected by this one.
    typedSetSetting('max_concurrent_verify_sessions', 5);
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

describe('dispatchGateItemVerification', () => {
  it('dispatches a verify for a runnable item and records the resulting disposition', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    configureGateVerification({
      verifier: { verify },
      deployAdvanceTrigger: fixedTrigger('sha1'),
    });

    const result = dispatchGateItemVerification([item.id]);
    expect(result.dispatched).toEqual([item.id]);
    expect(result.skipped).toEqual([]);

    await vi.waitFor(() => {
      expect(getItem(item.id)?.state).toBe('pass');
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(getItem(item.id)?.events.at(-1)).toMatchObject({
      disposition: 'pass',
      operator: 'gate-verifier',
      unattended: false,
    });
  });

  it('skips unknown item ids', () => {
    configureGateVerification({
      verifier: { verify: vi.fn() },
      deployAdvanceTrigger: fixedTrigger('sha1'),
    });
    const result = dispatchGateItemVerification(['no-such-item']);
    expect(result.dispatched).toEqual([]);
    expect(result.skipped).toEqual([
      { itemId: 'no-such-item', reason: 'not found' },
    ]);
  });

  it('a manually dispatched verifier pass on a Human-Observation item still cannot resolve it', async () => {
    const item = await makeRunnableItem({
      classification: 'Human-Observation',
    });
    const verify = vi.fn(async () => ({
      disposition: 'pass' as const,
      evidence: { basis: 'operational', note: 'audit_log shows it deployed' },
    }));
    configureGateVerification({
      verifier: { verify },
      deployAdvanceTrigger: fixedTrigger('sha1'),
    });

    dispatchGateItemVerification([item.id]);

    await vi.waitFor(() => {
      expect(verify).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(getItem(item.id)?.events.at(-1)).toMatchObject({
        disposition: 'pass',
        operator: 'gate-verifier',
      });
    });
    expect(getItem(item.id)?.state).toBe('runnable');
  });

  it('dispatches an explicit operator re-verify even though the item already has a live verify session', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    insertVerifySession(item.id, { sessionId: 'sess-live', status: 'running' });
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    configureGateVerification({
      verifier: { verify },
      deployAdvanceTrigger: fixedTrigger('sha1'),
    });

    const result = dispatchGateItemVerification([item.id]);

    expect(result.dispatched).toEqual([item.id]);
    await vi.waitFor(() => {
      expect(verify).toHaveBeenCalledTimes(1);
    });
  });

  it('skips an item already mid-verify rather than double-dispatching', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    let resolveVerify: (() => void) | undefined;
    const verify = vi.fn(
      () =>
        new Promise<{ disposition: 'pass' }>((resolve) => {
          resolveVerify = () => resolve({ disposition: 'pass' });
        }),
    );
    configureGateVerification({
      verifier: { verify },
      deployAdvanceTrigger: fixedTrigger('sha1'),
    });

    const first = dispatchGateItemVerification([item.id]);
    expect(first.dispatched).toEqual([item.id]);

    await vi.waitFor(() => {
      expect(verify).toHaveBeenCalledTimes(1);
    });

    const second = dispatchGateItemVerification([item.id]);
    expect(second.dispatched).toEqual([]);
    expect(second.skipped).toEqual([
      { itemId: item.id, reason: 'already in flight' },
    ]);

    resolveVerify?.();
    await vi.waitFor(() => {
      expect(getItem(item.id)?.state).toBe('pass');
    });
  });
});

describe('runGateReconcilerTick', () => {
  it('skips auto-run entirely when no verifier is injected', async () => {
    const item = await makeRunnableItem();
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
    });
    expect(result.processed).toEqual([]);
    expect(getItem(item.id)?.state).toBe('runnable');
  });

  it('auto-runs a runnable item when the milestone gate-verify arm is on', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    upsertArm(m12Id, 'gate-verify', true, 1);
    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({ disposition: 'pass' })),
    };
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(result.processed).toEqual([
      { itemId: item.id, classification: 'Read-Only', disposition: 'pass' },
    ]);
  });

  it('does not auto-run when the milestone gate-verify arm is off, even with gate_verification_enabled', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    upsertArm(m12Id, 'gate-verify', false, 1);
    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({ disposition: 'pass' })),
    };
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(result.processed).toEqual([]);
    expect(getItem(item.id)?.state).toBe('runnable');
  });

  it('falls back to DEFAULT_ARM[flow] when no flow_arm row exists for the milestone', async () => {
    db.prepare('DELETE FROM flow_arm').run();
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({ disposition: 'pass' })),
    };
    // DEFAULT_ARM['gate-verify'] is false, so with no row present at all,
    // auto-run stays off — same as before this milestone id-space fix.
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(result.processed).toEqual([]);
    expect(getItem(item.id)?.state).toBe('runnable');
  });

  it('skips (with a warning) a milestone display name that does not resolve to a milestone row, rather than falling through to DEFAULT_ARM', async () => {
    const item = await makeRunnableItem({
      milestone: 'M-unregistered',
      classification: 'Read-Only',
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({ disposition: 'pass' })),
    };
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(result.processed).toEqual([]);
    expect(getItem(item.id)?.state).toBe('runnable');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('M-unregistered'),
    );
    warnSpy.mockRestore();
  });

  it('auto-runs and auto-disposes a Read-Only item on pass', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
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
    expect(result.readiness['polimarket-analyser::M12'].status).toBe('green');
    expect(getItem(item.id)?.events.at(-1)).toMatchObject({
      disposition: 'pass',
      operator: 'gate-verifier',
      unattended: true,
    });
  });

  it('holds a Prod-Mutating item for operator consent until approveGateItem', async () => {
    const item = await makeRunnableItem({ classification: 'Prod-Mutating' });
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
    const untriaged = await makeRunnableItem({
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

  it('never auto-runs Human-Observation items — they stay for human /gate disposition', async () => {
    const item = await makeRunnableItem({
      text: 'panel renders a compact rollup header with a segmented progress bar',
      classification: 'Human-Observation',
    });
    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({
        disposition: 'pass',
        evidence: { basis: 'operational' },
      })),
    };
    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(getItem(item.id)?.state).toBe('runnable');
  });

  it('pulls a backoff-elapsed pending item via nextPendingGateItems and dispatches it through the same tick', async () => {
    const item = await makeRunnableItem({
      text: 'not yet triggerable, now elapsed',
      classification: 'Read-Only',
    });
    appendGateItemEvent(item.id, {
      disposition: 'not-yet-triggerable',
      evidence: 'still waiting',
    });
    expect(getItem(item.id)?.state).toBe('pending');
    schedulePendingAttempt(
      item.id,
      new Date(Date.now() - 1000).toISOString(),
      1,
      new Date().toISOString(),
    );

    const verifier: GateItemVerifier = {
      verify: async () => ({ disposition: 'pass' }),
    };
    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(getItem(item.id)?.state).toBe('pass');
  });

  it('does not dispatch a pending item whose backoff has not elapsed yet', async () => {
    const item = await makeRunnableItem({
      text: 'not yet triggerable, still backing off',
      classification: 'Read-Only',
    });
    appendGateItemEvent(item.id, {
      disposition: 'not-yet-triggerable',
      evidence: 'still waiting',
    });
    expect(getItem(item.id)?.state).toBe('pending');

    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({ disposition: 'pass' })),
    };
    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(getItem(item.id)?.state).toBe('pending');
  });

  it('still pulls and processes a backoff-elapsed pending item even when the runnable tiers alone would consume the entire dispatch budget', async () => {
    typedSetSetting('max_concurrent_planning_sessions', 1);
    typedSetSetting('human_reserve', 0);
    typedSetSetting('max_concurrent_verify_sessions', 1);
    // available = 1 — exactly enough for one dispatch this tick. A runnable
    // item alone would consume all of it if the runnable tiers were pulled
    // first, as they were before pending got first claim on the budget.
    const runnable = await makeRunnableItem({
      text: 'freshly runnable, competing for the same budget',
      classification: 'Read-Only',
    });
    const pending = await makeRunnableItem({
      text: 'not yet triggerable, now elapsed',
      classification: 'Read-Only',
    });
    appendGateItemEvent(pending.id, {
      disposition: 'not-yet-triggerable',
      evidence: 'still waiting',
    });
    expect(getItem(pending.id)?.state).toBe('pending');
    schedulePendingAttempt(
      pending.id,
      new Date(Date.now() - 1000).toISOString(),
      1,
      new Date().toISOString(),
    );

    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(getItem(pending.id)?.state).toBe('pass');
    expect(getItem(runnable.id)?.state).toBe('runnable');
    expect(result.skippedForBudget).toBe(1);
  });

  it('files a follow-up fix task on failure, attaches it as a new source, and re-opens the item', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
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
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    expect(getItem(item.id)?.events ?? []).toHaveLength(0);
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
    // A non-resolving needs-setup attempt still records an event (and stamps
    // updated_at), so it stays distinguishable from a never-dispatched item.
    expect(getItem(item.id)?.events).toHaveLength(1);
    expect(getItem(item.id)?.events[0]).toMatchObject({
      disposition: 'needs-setup',
    });

    const second = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(second.processed).toEqual([]);
  });

  it("a verifier's own not-yet-triggerable result parks the item at pending with next_attempt_at, not a plain pass", async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({
        disposition: 'not-yet-triggerable',
        evidence: { reason: 'the described job has not run yet' },
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
        disposition: 'not-yet-triggerable',
      },
    ]);
    const parked = getItem(item.id);
    expect(parked?.state).toBe('pending');
    expect(parked?.latestDisposition).toBe('not-yet-triggerable');
    expect(parked?.nextAttemptAt).toBeTruthy();
    expect(parked?.pendingAttemptCount).toBe(1);

    // Still parked (backoff unelapsed) — the item does not re-enter the
    // Read-Only auto-run tier on the very next tick.
    const second = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(second.processed).toEqual([]);
    expect(getItem(item.id)?.state).toBe('pending');
  });

  it('a dispatch failure (dispatchFailed:true) leaves latest_disposition unchanged and the item still runnable on the next pull', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    upsertArm(m12Id, 'gate-verify', true, 1);
    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({
        disposition: 'needs-setup' as const,
        dispatchFailed: true,
        evidence: {
          reason: 'failed to dispatch verification session',
          error: 'Max concurrent planning sessions (20) reached',
        },
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
    expect(getItem(item.id)?.latestDisposition).toBeUndefined();

    // Still eligible for the next tick's dispatch — a dispatch failure never
    // occupies latest_disposition, so isAwaitingSetup does not skip it.
    const second = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(verifier.verify).toHaveBeenCalledTimes(2);
    expect(second.processed).toEqual([
      {
        itemId: item.id,
        classification: 'Read-Only',
        disposition: 'needs-setup',
      },
    ]);
  });

  it('records a dispatch failure as a log-only event — reason/error evidence preserved, disposition null', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    upsertArm(m12Id, 'gate-verify', true, 1);
    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({
        disposition: 'needs-setup' as const,
        dispatchFailed: true,
        evidence: {
          reason: 'failed to dispatch verification session',
          error: 'Max concurrent planning sessions (20) reached',
        },
      })),
    };

    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });

    expect(getItem(item.id)?.events).toHaveLength(1);
    expect(getItem(item.id)?.events[0]).toMatchObject({
      disposition: undefined,
      evidence: {
        reason: 'failed to dispatch verification session',
        error: 'Max concurrent planning sessions (20) reached',
      },
    });
    const row = db
      .prepare(`SELECT disposition FROM gate_item_event WHERE gate_item_id = ?`)
      .get(item.id) as { disposition: string | null };
    expect(row.disposition).toBeNull();
  });

  it('an item previously skipped for a genuine needs-setup becomes eligible again once a later event supersedes it', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    upsertArm(m12Id, 'gate-verify', true, 1);
    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({
        disposition: 'needs-setup' as const,
        evidence: { reason: 'budget exceeded' },
      })),
    };

    const first = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(first.processed).toHaveLength(1);

    const skipped = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(skipped.processed).toEqual([]);

    // A superseding event (e.g. an operator note) clears the awaiting-setup
    // gate, so the next pull can reach it again.
    appendGateItemEvent(item.id, {
      disposition: 'noted',
      evidence: { note: 'operator re-opened for another attempt' },
    });

    const resumed = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(resumed.processed).toEqual([
      {
        itemId: item.id,
        classification: 'Read-Only',
        disposition: 'needs-setup',
      },
    ]);
    expect(verifier.verify).toHaveBeenCalledTimes(2);
  });

  it("applies a verifier-proposed reclassification, superseding the run's disposition for routing", async () => {
    const item = await makeRunnableItem({
      classification: 'Read-Only',
      text: 'a Task/Agent subagent call renders as a single distinct collapsible block',
    });
    const verifier: GateItemVerifier = {
      verify: vi.fn(async () => ({
        disposition: 'needs-setup',
        evidence: { reason: 'cannot observe rendering headlessly' },
        reclassify: {
          to: 'Human-Observation',
          reason: 'this is UI/visual behavior, not headlessly verifiable',
        },
      })),
    };

    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(result.processed).toEqual([
      {
        itemId: item.id,
        classification: 'Human-Observation',
        disposition: 'needs-setup',
        reclassifiedTo: 'Human-Observation',
      },
    ]);
    expect(getItem(item.id)?.classification).toBe('Human-Observation');
    expect(getItem(item.id)?.events.at(-1)).toMatchObject({
      disposition: 'reclassified',
      operator: 'gate-verifier',
    });

    // The item is no longer in the Read-Only auto-run tier, so a later tick
    // never re-dispatches it — the mis-routing this proposal exists to fix
    // cannot recur.
    const second = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
    });
    expect(second.processed).toEqual([]);
    expect(verifier.verify).toHaveBeenCalledTimes(1);
  });

  it('abstains to needs-setup and records the rejection when a reclassify proposal targets an auto-run tier', async () => {
    const item = await makeRunnableItem({ classification: 'needs-triage' });
    // Bypass the reconciler's own auto-run-tier skip by using
    // dispatchGateItemVerification for a direct, manually-dispatched
    // verification against a non-auto-run item.
    const verify = vi.fn(async () => ({
      disposition: 'needs-setup' as const,
      reclassify: {
        to: 'Read-Only' as never,
        reason: 'looks headlessly verifiable after all',
      },
    }));
    configureGateVerification({
      verifier: { verify },
      deployAdvanceTrigger: fixedTrigger('sha1'),
    });

    dispatchGateItemVerification([item.id]);
    await vi.waitFor(() => {
      expect(verify).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(getItem(item.id)?.events.at(-1)).toMatchObject({
        disposition: 'needs-setup',
      });
    });
    expect(getItem(item.id)?.classification).toBe('needs-triage');
  });

  it('guards against reclassify ping-pong: a second verifier proposal after an operator reverts it is rejected', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    const verify = vi.fn(async () => ({
      disposition: 'needs-setup' as const,
      reclassify: {
        to: 'Human-Observation' as const,
        reason: 'UI behavior',
      },
    }));
    configureGateVerification({
      verifier: { verify },
      deployAdvanceTrigger: fixedTrigger('sha1'),
    });

    dispatchGateItemVerification([item.id]);
    await vi.waitFor(() => {
      expect(getItem(item.id)?.classification).toBe('Human-Observation');
    });

    // An operator disagrees and reverts it back to an auto-run tier...
    const { reclassifyGateItem } = await import('../gateService.js');
    reclassifyGateItem(item.id, 'Read-Only', 'pedro');
    mergeSource(item.id, 'sha1', new Date(2).toISOString());
    await reconcileGateRunnability('sha1');

    // ...and the verifier proposes reclassifying it again — the ping-pong
    // guard rejects it, falling back to needs-setup rather than looping.
    dispatchGateItemVerification([item.id]);
    await vi.waitFor(() => {
      expect(verify).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(getItem(item.id)?.events.at(-1)).toMatchObject({
        disposition: 'needs-setup',
      });
    });
    expect(getItem(item.id)?.classification).toBe('Read-Only');
  });

  it('fail dedup: skips refiling while a prior filed follow-up is not yet Done', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
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
    const item = await makeRunnableItem({ classification: 'Read-Only' });
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
    // The follow-up task reaching Done also means its fix merged and
    // deployed — otherwise the reconciler's own coverage check (every
    // source's merge_commit must be an ancestor of the deployed sha) would
    // immediately flip the item back to open before verification runs.
    setSourceMergeCommit(item.id, 'notion:followup-1', 'sha1');
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
    await makeRunnableItem({ classification: 'Read-Only' });
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

  it('does not dispatch a gate item that already has a live verify session from an earlier process', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    // Simulates a session dispatched before a process restart: no in-memory
    // inFlightVerifications entry survives, only the DB-backed session row.
    insertVerifySession(item.id, { sessionId: 'sess-live', status: 'running' });
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));

    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    expect(verify).not.toHaveBeenCalled();
    expect(result.processed).toEqual([]);
    expect(getItem(item.id)?.state).toBe('runnable');
  });

  it('does not re-dispatch a completed verification while its runnability inputs are unchanged', async () => {
    await makeRunnableItem({ classification: 'Read-Only' });
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));

    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });
    expect(verify).toHaveBeenCalledTimes(1);

    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('re-dispatches a failed item once its min_deployed_commit is newly satisfied, even with a terminal session row from the earlier verify', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    let callCount = 0;
    const verifier: GateItemVerifier = {
      verify: async () => {
        callCount += 1;
        // Mirrors the real SessionGateItemVerifier: a terminal session row
        // is left behind once the verify concludes.
        insertVerifySession(item.id, {
          sessionId: `sess-${callCount}`,
          status: 'done',
        });
        return { disposition: 'fail', evidence: { log: 'boom' } };
      },
    };
    const followupFiler: FollowupFixTaskFiler = {
      fileFollowupFixTask: vi.fn(async () => ({
        taskId: 'notion:followup-1',
        taskTitle: 'fix it',
      })),
    };

    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier,
      followupFiler,
    });
    expect(callCount).toBe(1);
    expect(getItem(item.id)?.state).toBe('open');

    // A fresh deploy covers a min_deployed_commit past the one recorded at
    // the fail — reconcileGateRunnability reopens then re-marks runnable.
    // Merge coverage for both the original source and the follow-up fix
    // task the fail path attached, or the item stays open (fail-dedup test
    // above does the same double-merge for the same reason).
    mergeSource(item.id, 'sha2', new Date(2).toISOString());
    setSourceMergeCommit(item.id, 'notion:followup-1', 'sha2');
    await reconcileGateRunnability('sha2');
    expect(getItem(item.id)?.state).toBe('runnable');

    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha2'),
      verifier,
      followupFiler,
    });

    expect(callCount).toBe(2);
  });

  it('two consecutive reconciler ticks over the same runnable item produce exactly one session', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    const verify = vi.fn(async () => {
      insertVerifySession(item.id, { sessionId: 'sess-only', status: 'done' });
      return { disposition: 'pass' as const };
    });

    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });
    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    expect(verify).toHaveBeenCalledTimes(1);
    const sessionCount = db
      .prepare(`SELECT COUNT(*) as c FROM sessions WHERE task_id = ?`)
      .get(`gate-item:${item.id}`) as { c: number };
    expect(sessionCount.c).toBe(1);
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
    expect(result.readiness['polimarket-analyser::M20'].status).toBe('blocked');
  });
});

describe('runGateReconcilerTick — event loop yielding', () => {
  it('yields to the event loop between item iterations within a tier', async () => {
    const item1 = await makeRunnableItem({
      classification: 'Read-Only',
      text: 'item one',
    });
    const item2 = await makeRunnableItem({
      classification: 'Read-Only',
      text: 'item two',
    });

    let sentinelRan = false;
    const verify = vi.fn(async (item: { id: string }) => {
      if (item.id === item1.id) {
        // Scheduled during item1's processing — should fire before item2
        // is processed if the tick yields in between.
        setImmediate(() => {
          sentinelRan = true;
        });
      } else if (item.id === item2.id) {
        expect(sentinelRan).toBe(true);
      }
      return { disposition: 'pass' as const };
    });

    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    expect(verify).toHaveBeenCalledTimes(2);
    expect(sentinelRan).toBe(true);
  });

  it('yields to the event loop between milestone iterations', async () => {
    const m13Id = ProjectService.createMilestone({
      id: 'ms-uuid-m13',
      projectId: 'polimarket-analyser',
      name: 'M13',
      canonicalShortId: 'M13',
    }).id;
    upsertArm(m13Id, 'gate-verify', true, 1);

    const item1 = await makeRunnableItem({
      milestone: 'M12',
      classification: 'Read-Only',
      text: 'm12 item',
    });
    const item2 = makeItem({
      milestone: 'M13',
      classification: 'Read-Only',
      text: 'm13 item',
    });
    mergeSource(item2.id, 'sha1', new Date(1).toISOString());
    await reconcileGateRunnability('sha1');

    let sentinelRan = false;
    const verify = vi.fn(async (item: { id: string }) => {
      if (item.id === item1.id) {
        setImmediate(() => {
          sentinelRan = true;
        });
      } else if (item.id === item2.id) {
        expect(sentinelRan).toBe(true);
      }
      return { disposition: 'pass' as const };
    });

    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    expect(verify).toHaveBeenCalledTimes(2);
    expect(sentinelRan).toBe(true);
  });

  it('does not hold the loop for a full multi-item pass', async () => {
    await makeRunnableItem({ classification: 'Read-Only', text: 'item a' });
    await makeRunnableItem({ classification: 'Read-Only', text: 'item b' });
    await makeRunnableItem({ classification: 'Read-Only', text: 'item c' });
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));

    const events: string[] = [];
    setImmediate(() => {
      events.push('sentinel');
    });

    const tick = runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    }).then(() => {
      events.push('tick-complete');
    });
    await tick;

    expect(events).toEqual(['sentinel', 'tick-complete']);
  });
});

describe('reconcileGateRunnability — synchronous git-spawn hot-path regression', () => {
  it('skips the git-ancestry check entirely for an item already in a terminal pass state', async () => {
    const isAncestor = vi.fn(() => true);
    const item = makeItem();
    mergeSource(item.id, 'sha1', new Date(1).toISOString());
    await reconcileGateRunnability('sha1', { ancestrySource: { isAncestor } });
    expect(isAncestor).toHaveBeenCalled();

    appendGateItemEvent(item.id, { disposition: 'pass' });
    isAncestor.mockClear();

    await reconcileGateRunnability('sha2', { ancestrySource: { isAncestor } });

    expect(isAncestor).not.toHaveBeenCalled();
  });

  it('a regression test for runGateReconcilerTick: a realistic number of already-pass items issue no per-item ancestry check', async () => {
    const isAncestor = vi.fn(() => true);
    const passItemCount = 50;
    for (let i = 0; i < passItemCount; i++) {
      const item = makeItem({ text: `pass item ${i}` });
      mergeSource(item.id, 'sha1', new Date(1).toISOString(), 'notion:abc');
      appendGateItemEvent(item.id, { disposition: 'pass' });
    }
    // One still-open item, so the tick still has real reconciliation work to do.
    const openItem = makeItem({ text: 'still open' });
    mergeSource(openItem.id, 'sha1', new Date(1).toISOString());

    await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      ancestrySourceForProject: () => ({ isAncestor }),
    });

    // Only the one non-pass item's source should have reached the ancestry check.
    expect(isAncestor).toHaveBeenCalledTimes(1);
  });

  it('does not use a synchronous child-process call — the event loop stays responsive while a check is in flight', async () => {
    const { createLocalAsyncGitAncestrySource } =
      await import('../gateService.js');
    const ancestry = createLocalAsyncGitAncestrySource(process.cwd());

    const order: string[] = [];
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push('timer');
        resolve();
      }, 0);
    });
    const check = Promise.resolve(
      ancestry.isAncestor(
        '0000000000000000000000000000000000000a',
        '0000000000000000000000000000000000000b',
      ),
    ).then(() => {
      order.push('ancestry');
    });

    await Promise.all([timer, check]);

    // A synchronous execFileSync call would run the whole ancestry check
    // (including its subprocess spawn) to completion before this function
    // even returns control to the microtask queue, so the timer scheduled
    // above would have no chance to fire first.
    expect(order[0]).toBe('timer');
  });

  it('runs ancestry checks with bounded concurrency rather than fully serial, one item at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const isAncestor = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return true;
    });

    for (let i = 0; i < 6; i++) {
      const item = makeItem({ text: `item ${i}` });
      mergeSource(item.id, `sha-${i}`, new Date(1).toISOString());
    }

    await reconcileGateRunnability('sha1', { ancestrySource: { isAncestor } });

    // A fully serial loop can never have more than one ancestry check in
    // flight at a time — more than one overlapping proves the checks are
    // actually running concurrently, not just yielding between each other.
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('issues only one isAncestor call for two items sharing the same (mergeCommit, deploySha) pair within a tick', async () => {
    const isAncestor = vi.fn(() => true);
    const itemA = makeItem({ text: 'item a' });
    const itemB = makeItem({ text: 'item b' });
    mergeSource(itemA.id, 'sha-shared', new Date(1).toISOString());
    mergeSource(itemB.id, 'sha-shared', new Date(1).toISOString());

    await reconcileGateRunnability('sha1', { ancestrySource: { isAncestor } });

    expect(isAncestor).toHaveBeenCalledTimes(1);
  });
});

describe('runGateReconcilerTick — verify concurrency budgeting', () => {
  /** Seeds a live (non-terminal) session row directly — bypasses SessionManager, for exercising the DB-backed count the reconciler budgets against. */
  function insertLiveSession(opts: {
    sessionId: string;
    taskId: string;
    sessionType?: string;
  }) {
    db.prepare(
      `INSERT INTO sessions (session_id, task_id, session_type, status, started_at)
       VALUES (@sessionId, @taskId, @sessionType, 'running', 0)`,
    ).run({
      sessionId: opts.sessionId,
      taskId: opts.taskId,
      sessionType: opts.sessionType ?? 'ops',
    });
  }

  it('dispatches no further verify sessions once live verify sessions already fill the cap', async () => {
    typedSetSetting('max_concurrent_verify_sessions', 2);
    insertLiveSession({
      sessionId: 'live-verify-1',
      taskId: 'gate-item:already-1',
    });
    insertLiveSession({
      sessionId: 'live-verify-2',
      taskId: 'gate-item:already-2',
    });

    const item = await makeRunnableItem({ classification: 'Read-Only' });
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    expect(verify).not.toHaveBeenCalled();
    expect(result.processed).toEqual([]);
    expect(getItem(item.id)?.state).toBe('runnable');
  });

  it('dispatches up to the remaining verify capacity and no more when the cap exceeds live sessions', async () => {
    typedSetSetting('max_concurrent_verify_sessions', 3);
    insertLiveSession({
      sessionId: 'live-verify-1',
      taskId: 'gate-item:already-1',
    });

    const items = [
      await makeRunnableItem({ text: 'item a', classification: 'Read-Only' }),
      await makeRunnableItem({ text: 'item b', classification: 'Read-Only' }),
      await makeRunnableItem({ text: 'item c', classification: 'Read-Only' }),
    ];
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    // cap(3) - live(1) = 2 remaining slots — exactly 2 of the 3 items dispatch.
    expect(verify).toHaveBeenCalledTimes(2);
    expect(result.processed).toHaveLength(2);
    const dispatchedIds = result.processed.map((p) => p.itemId);
    const skipped = items.filter((i) => !dispatchedIds.includes(i.id));
    expect(skipped).toHaveLength(1);
    expect(getItem(skipped[0].id)?.state).toBe('runnable');
  });

  it('stops dispatching while free planning capacity is down to the human reserve', async () => {
    typedSetSetting('max_concurrent_planning_sessions', 2);
    typedSetSetting('human_reserve', 1);
    typedSetSetting('max_concurrent_verify_sessions', 10);
    // One live planning (non-verify) session already occupies the pool —
    // available = 2 - humanReserve(1) - active(1) = 0.
    insertLiveSession({ sessionId: 'live-ops-1', taskId: 'some-ops-task' });

    const item = await makeRunnableItem({ classification: 'Read-Only' });
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    expect(verify).not.toHaveBeenCalled();
    expect(result.processed).toEqual([]);
    expect(getItem(item.id)?.state).toBe('runnable');
  });

  it('does not count a non-gate ops session against the verify cap', async () => {
    typedSetSetting('max_concurrent_verify_sessions', 1);
    typedSetSetting('max_concurrent_planning_sessions', 5);
    typedSetSetting('human_reserve', 0);
    // session_type='ops' but task_id has no gate-item: prefix — must not be
    // counted as a live verify session.
    insertLiveSession({ sessionId: 'ordinary-ops-1', taskId: 'some-ops-task' });

    const item = await makeRunnableItem({ classification: 'Read-Only' });
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.processed).toEqual([
      { itemId: item.id, classification: 'Read-Only', disposition: 'pass' },
    ]);
  });

  it('a dispatch that still fails on the hard cap continues to return dispatchFailed:true without touching latest_disposition or crashCounts', async () => {
    // Budgeting leaves headroom, but the injected verifier simulates
    // SessionManager.start throwing anyway (e.g. a race with another
    // dispatcher) — the dispatchFailed backstop must still apply.
    typedSetSetting('max_concurrent_verify_sessions', 5);
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    const verify = vi.fn(async () => ({
      disposition: 'needs-setup' as const,
      dispatchFailed: true,
      evidence: { reason: 'failed to dispatch verification session' },
    }));
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    expect(result.processed).toEqual([
      {
        itemId: item.id,
        classification: 'Read-Only',
        disposition: 'needs-setup',
      },
    ]);
    expect(getItem(item.id)?.state).toBe('runnable');
    expect(getItem(item.id)?.latestDisposition).toBeUndefined();
  });

  it('does not let a pile of archived idle planning sessions pin the dispatch budget at zero', async () => {
    typedSetSetting('max_concurrent_planning_sessions', 20);
    typedSetSetting('human_reserve', 1);
    typedSetSetting('max_concurrent_verify_sessions', 10);

    // Reproduces the reported incident shape: 104 archived idle planning
    // sessions (no longer holding any real capacity) plus a few genuinely
    // live ones.
    for (let i = 0; i < 104; i++) {
      insertLiveSession({
        sessionId: `archived-idle-${i}`,
        taskId: `ops-task-${i}`,
        sessionType: 'ops',
      });
      db.prepare(
        `UPDATE sessions SET status = 'idle' WHERE session_id = ?`,
      ).run(`archived-idle-${i}`);
      archiveSession(`archived-idle-${i}`);
    }
    insertLiveSession({
      sessionId: 'live-running',
      taskId: 'ops-task-live',
      sessionType: 'ops',
    });

    await makeRunnableItem({ classification: 'Read-Only' });
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.processed).toHaveLength(1);
    expect(result.skippedForBudget).toBe(0);
  });

  it('reports skippedForBudget when a runnable item is passed over solely for want of budget', async () => {
    typedSetSetting('max_concurrent_planning_sessions', 1);
    typedSetSetting('human_reserve', 0);
    typedSetSetting('max_concurrent_verify_sessions', 10);
    // available = 1 - humanReserve(0) - active(1) = 0.
    insertLiveSession({ sessionId: 'live-ops-1', taskId: 'some-ops-task' });

    await makeRunnableItem({ classification: 'Read-Only' });
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    expect(verify).not.toHaveBeenCalled();
    expect(result.processed).toEqual([]);
    expect(result.skippedForBudget).toBe(1);
  });

  it('reports skippedForBudget: 0 when a tick genuinely has no runnable items', async () => {
    typedSetSetting('max_concurrent_planning_sessions', 5);
    typedSetSetting('human_reserve', 0);
    typedSetSetting('max_concurrent_verify_sessions', 10);

    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    expect(verify).not.toHaveBeenCalled();
    expect(result.processed).toEqual([]);
    expect(result.skippedForBudget).toBe(0);
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
    mergeSource(gated.id, 'sha1', new Date(1).toISOString());

    const result = await runGateReconcilerTick({
      ancestrySourceForProject: exactMatchAncestrySource,
    });

    expect(result.deployShaByProject['polimarket-analyser']).toBe('sha1');
    expect(getItem(gated.id)?.state).toBe('runnable');
  });
});

describe('reattachOutstandingGateVerifications', () => {
  it('reattaches to a gate-item session left non-terminal with a pending capability request, and routes its eventual disposition once reconciliation runs', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    insertVerifySession(item.id, {
      sessionId: 'sess-parked',
      status: 'running',
    });
    insertPendingCapabilityRequest('sess-parked');

    const reattach = vi.fn(async () => ({ disposition: 'pass' as const }));
    const verifier: ReattachableGateItemVerifier = {
      verify: vi.fn(),
      reattach,
    };
    configureGateVerification({
      verifier,
      deployAdvanceTrigger: fixedTrigger('sha1'),
    });

    await reattachOutstandingGateVerifications();

    expect(reattach).toHaveBeenCalledTimes(1);
    expect(reattach.mock.calls[0][0]).toMatchObject({ id: item.id });
    expect(reattach.mock.calls[0][1]).toBe('sess-parked');
    await vi.waitFor(() => {
      expect(getItem(item.id)?.state).toBe('pass');
    });
    expect(getItem(item.id)?.events.at(-1)).toMatchObject({
      disposition: 'pass',
      operator: 'gate-verifier',
      unattended: true,
    });
  });

  it('does nothing when no session has a pending capability request', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    insertVerifySession(item.id, {
      sessionId: 'sess-live-no-request',
      status: 'running',
    });

    const reattach = vi.fn(async () => ({ disposition: 'pass' as const }));
    const verifier: ReattachableGateItemVerifier = {
      verify: vi.fn(),
      reattach,
    };
    configureGateVerification({
      verifier,
      deployAdvanceTrigger: fixedTrigger('sha1'),
    });

    await reattachOutstandingGateVerifications();

    expect(reattach).not.toHaveBeenCalled();
  });

  it('is a no-op when the configured verifier does not support reattach', async () => {
    const item = await makeRunnableItem({ classification: 'Read-Only' });
    insertVerifySession(item.id, {
      sessionId: 'sess-parked-2',
      status: 'running',
    });
    insertPendingCapabilityRequest('sess-parked-2');

    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    configureGateVerification({
      verifier: { verify },
      deployAdvanceTrigger: fixedTrigger('sha1'),
    });

    await expect(
      reattachOutstandingGateVerifications(),
    ).resolves.toBeUndefined();
    expect(getItem(item.id)?.state).toBe('runnable');
  });
});

describe('runGateReconcilerTick — wrapped-milestone scoping', () => {
  it('does not load, reconcile, or auto-run a gate item belonging to a wrapped milestone, while an item on an open milestone in the same project is unaffected', async () => {
    upsertArm(m11Id, 'gate-verify', true, 1);
    const openItem = await makeRunnableItem({
      milestone: 'M12',
      classification: 'Read-Only',
    });
    const wrappedItem = await makeRunnableItem({
      milestone: 'M11',
      classification: 'Read-Only',
    });

    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    const result = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });

    // Only the open milestone's item was ever handed to the verifier — the
    // wrapped milestone's item was excluded before auto-run even pulled a
    // tier, not merely skipped after being loaded.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.processed).toEqual([
      {
        itemId: openItem.id,
        classification: 'Read-Only',
        disposition: 'pass',
      },
    ]);
    expect(getItem(openItem.id)?.state).toBe('pass');
    // Untouched: still sitting at 'runnable', exactly where
    // makeRunnableItem left it — the reconciler never reconsidered it.
    expect(getItem(wrappedItem.id)?.state).toBe('runnable');

    // The readiness rollup this tick produces is keyed off the same
    // filtered working set, so a wrapped milestone never appears in it.
    expect(result.readiness['polimarket-analyser::M12']).toBeDefined();
    expect(result.readiness['polimarket-analyser::M11']).toBeUndefined();
  });

  it('excludes a wrapped milestone item from reconcileGateRunnability when isMilestoneWrapped is supplied, while behavior for the open milestone is unchanged', async () => {
    // Both items start 'open' with a merged-but-not-yet-deployed source —
    // reconcileGateRunnability, given deploySha 'sha1', should mark the
    // open-milestone item runnable exactly as it always has, and leave the
    // wrapped-milestone item alone entirely.
    const openItem = makeItem({ milestone: 'M12' });
    mergeSource(openItem.id, 'sha1', new Date(1).toISOString());
    const wrappedItem = makeItem({ milestone: 'M11' });
    mergeSource(wrappedItem.id, 'sha1', new Date(1).toISOString());

    const result = await reconcileGateRunnability('sha1', {
      project: 'polimarket-analyser',
      isMilestoneWrapped: (project, milestone) =>
        project === 'polimarket-analyser' && milestone === 'M11',
    });

    expect(result.markedRunnable).toEqual([openItem.id]);
    expect(getItem(openItem.id)?.state).toBe('runnable');
    expect(getItem(wrappedItem.id)?.state).toBe('open');
  });

  it('reopens a fail item on an open milestone identically whether or not a wrapped-milestone item exists alongside it', async () => {
    const item = await makeRunnableItem({ milestone: 'M12' });
    appendGateItemEvent(item.id, {
      disposition: 'fail',
      evidence: { minDeployedCommitAtFail: 'sha1' },
    });
    expect(getItem(item.id)?.state).toBe('fail');

    const wrappedItem = await makeRunnableItem({ milestone: 'M11' });
    appendGateItemEvent(wrappedItem.id, {
      disposition: 'fail',
      evidence: { minDeployedCommitAtFail: 'sha1' },
    });
    expect(getItem(wrappedItem.id)?.state).toBe('fail');

    // The follow-up fix source merges and pushes min_deployed_commit
    // forward on both items.
    setMinDeployedCommit(item.id, 'sha2', new Date(2).toISOString());
    setMinDeployedCommit(wrappedItem.id, 'sha2', new Date(2).toISOString());

    // A total order over sha strings ('sha2' > 'sha1') — avoids spawning a
    // real `git merge-base` against fixture shas that share no actual git
    // history, mirroring gateService.test.ts's own orderedAncestry fixture.
    const orderedAncestry = {
      isAncestor: (ancestorSha: string, descendantSha: string) =>
        ancestorSha <= descendantSha,
    };

    const result = await reconcileGateRunnability('sha2', {
      project: 'polimarket-analyser',
      ancestrySource: orderedAncestry,
      isMilestoneWrapped: (project, milestone) =>
        project === 'polimarket-analyser' && milestone === 'M11',
    });

    expect(result.reopened).toEqual([item.id]);
    expect(getItem(item.id)?.state).toBe('runnable');
    // The wrapped item's follow-up fix landed too, but the reconciler never
    // looked at it — it stays parked at 'fail' rather than reopening.
    expect(getItem(wrappedItem.id)?.state).toBe('fail');
  });

  it('handles a gate item whose milestone holds a raw milestone UUID deterministically — it resolves to the same wrapped/unwrapped answer as its canonical short-id counterpart', async () => {
    // M12 (m12Id) is unwrapped: a UUID-keyed item on it must be treated as
    // in-scope, same as a canonical-'M12'-keyed item.
    const uuidKeyedOpenItem = await makeRunnableItem({
      milestone: m12Id,
      classification: 'Read-Only',
    });
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    const firstTick = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });
    expect(firstTick.processed).toEqual([
      {
        itemId: uuidKeyedOpenItem.id,
        classification: 'Read-Only',
        disposition: 'pass',
      },
    ]);

    // Now the same check against M11 (m11Id), which IS wrapped: a
    // UUID-keyed item on it must be excluded, same as a canonical-'M11'
    // -keyed item — this is the side the predicate falls on for a raw
    // milestone UUID.
    upsertArm(m11Id, 'gate-verify', true, 1);
    const uuidKeyedWrappedItem = await makeRunnableItem({
      milestone: m11Id,
      classification: 'Read-Only',
    });
    verify.mockClear();
    const secondTick = await runGateReconcilerTick({
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });
    expect(verify).not.toHaveBeenCalled();
    expect(secondTick.processed).toEqual([]);
    expect(getItem(uuidKeyedWrappedItem.id)?.state).toBe('runnable');
  });

  it('preserves the negative items_processed ("runnable work found, no budget") convention when a wrapped-milestone item is also present — it must not be counted as skipped-for-budget', async () => {
    typedSetSetting('max_concurrent_verify_sessions', 1);
    db.prepare(
      `INSERT INTO sessions (session_id, task_id, session_type, status, started_at)
       VALUES ('live-verify-1', 'gate-item:already-live', 'ops', 'running', 0)`,
    ).run();
    await makeRunnableItem({ milestone: 'M12', classification: 'Read-Only' });
    upsertArm(m11Id, 'gate-verify', true, 1);
    await makeRunnableItem({ milestone: 'M11', classification: 'Read-Only' });

    const run = vi.fn(async () => undefined);
    const scheduler = {
      register: vi.fn(({ run: r }) => run.mockImplementation(r)),
    };
    const verify = vi.fn(async () => ({ disposition: 'pass' as const }));
    register(scheduler as never, {
      deployAdvanceTrigger: fixedTrigger('sha1'),
      verifier: { verify },
    });
    const opts = scheduler.register.mock.calls[0][0];
    const result = await opts.run({ signal: new AbortController().signal });

    expect(verify).not.toHaveBeenCalled();
    // Exactly -1: the open milestone's item was skipped for budget; the
    // wrapped milestone's item was excluded entirely and never entered the
    // skippedForBudget count.
    expect(result.items_processed).toBe(-1);

    typedSetSetting('max_concurrent_verify_sessions', 5);
  });
});

describe('getGateReadiness — wrapped-milestone exclusion', () => {
  it('reports green with no blocking items for a wrapped milestone, even though it has an unresolved gate item the reconciler no longer touches', async () => {
    await makeRunnableItem({ milestone: 'M11', classification: 'Read-Only' });

    const readiness = getGateReadiness('polimarket-analyser', 'M11');

    expect(readiness.status).toBe('green');
    expect(readiness.blocking).toEqual([]);
    expect(readiness.parked).toEqual([]);
    expect(readiness.counts).toEqual({});
  });

  it('is unaffected for an open milestone', async () => {
    await makeRunnableItem({ milestone: 'M12', classification: 'Read-Only' });

    const readiness = getGateReadiness('polimarket-analyser', 'M12');

    expect(readiness.status).toBe('blocked');
    expect(readiness.blocking).toHaveLength(1);
  });
});

describe('catchUpMergeCommits — duration isolated from the rest of the tick', () => {
  it('runs and completes as a standalone call, so its contribution to a tick is measurable independent of the item-scan/reconcile phases that follow it', async () => {
    // catchUpMergeCommits is awaited on its own line before gate items are
    // ever loaded (see runGateReconcilerTick) — calling it directly here,
    // outside of a full tick, demonstrates it is a separately-timeable unit
    // rather than work folded into the item scan this task scopes down.
    const start = performance.now();
    const result = await catchUpMergeCommits();
    const elapsedMs = performance.now() - start;

    expect(result).toEqual({ filled: 0 });
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(elapsedMs)).toBe(true);
  });
});
