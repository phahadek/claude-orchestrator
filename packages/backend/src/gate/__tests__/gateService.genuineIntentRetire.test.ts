/**
 * Coverage for the leaked-Planning-slot bug: a gate-verify session dispatches
 * against a `runnable` gate item and stages its own `gate.verify` intent (no
 * `origin` — a genuine verifier report, not a mirror/consent one). If the
 * operator resolves the same gate item through the *direct*
 * Pass/Fail/Defer/reject/reopen path (GateReadinessPanel -> appendGateItemEvent
 * /approveGateItem/rejectGateItem/reopenGateItem) instead of dispositioning
 * that staged intent, the intent is left at `state==='staged'` forever and
 * every terminal-detection mechanism refuses to conclude its owning session
 * — stranding its Planning-concurrency slot. gateService.ts now retires that
 * genuine intent (via the same withdrawGateVerifyMirror mechanism the mirror/
 * consent retire pass uses) and explicitly drives the owning session's
 * PlanningOrchestrator.checkTerminal whenever a direct disposition path
 * resolves/reopens the item.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { ProjectService } from '../../projects/ProjectService.js';
import { insertItem, setMinDeployedCommit, setSourceMergeCommit } from '../gateStore.js';
import {
  appendGateItemEvent,
  approveGateItem,
  rejectGateItem,
  reopenGateItem,
  reconcileGateRunnability,
  configureGateVerifyIntentRetireSink,
} from '../gateService.js';
import {
  configureGateItemMirrorSink,
  reconcileHumanObservationMirrors,
} from '../gateReconciler.js';
import { stageIntent, withdrawGateVerifyMirror } from '../../routes/stagedIntents.js';
import { countLivePlanningSessions } from '../../db/queries.js';
import { PlanningOrchestrator } from '../../orchestration/PlanningOrchestrator.js';

function makeSessionManager() {
  const sm = new EventEmitter();
  return Object.assign(sm, {
    enqueueFeedback: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    getLiveSession: vi.fn().mockReturnValue(undefined),
  });
}

const sessionManager = makeSessionManager();
const planningOrchestrator = new PlanningOrchestrator(sessionManager as never);

beforeAll(() => {
  ProjectService.create({
    id: 'proj-genuine-retire',
    name: 'Project Genuine Retire',
    projectDir: '/tmp/proj-genuine-retire',
  });
  ProjectService.createMilestone({
    id: 'ms-uuid-genuine-retire-m12',
    projectId: 'proj-genuine-retire',
    name: 'M12',
    canonicalShortId: 'M12',
  });
});

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();

  configureGateVerifyIntentRetireSink({
    retireGenuineIntent(intentId, sessionId, reason) {
      withdrawGateVerifyMirror(intentId, reason);
      planningOrchestrator.checkTerminal(sessionId);
    },
  });

  // The mirror/consent sink is wired identically to server.ts for the
  // regression coverage below, confirming this change doesn't disturb it.
  configureGateItemMirrorSink({
    stageMirror(item, origin) {
      stageIntent(
        'gate.verify',
        origin === 'consent'
          ? { gateItemId: item.id, origin: 'consent', evidence: null }
          : { gateItemId: item.id, origin: 'mirror' },
        item.project,
        null,
        null,
        null,
        null,
        null,
        item.milestone,
        null,
      );
    },
    retireMirror(intentId, reason) {
      withdrawGateVerifyMirror(intentId, reason);
    },
  });
});

function makeRunnableItem(
  overrides: Partial<Parameters<typeof insertItem>[0]> = {},
) {
  const item = insertItem({
    project: 'proj-genuine-retire',
    milestone: 'M12',
    text: 'Confirm the checkout flow accepts a discount code',
    classification: 'Read-Only',
    sources: [{ sourceTaskId: 'notion:abc', sourceTaskTitle: 'Add discount' }],
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });
  setSourceMergeCommit(item.id, 'notion:abc', 'sha1');
  setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
  return item;
}

async function makeDispatchedRunnableItem(
  overrides: Partial<Parameters<typeof insertItem>[0]> = {},
) {
  const item = makeRunnableItem(overrides);
  await reconcileGateRunnability('sha1', { project: 'proj-genuine-retire' });
  return item;
}

/** Simulates a dispatched verify session and its own staged genuine `gate.verify` intent (no origin). */
function dispatchVerifySession(itemId: string, sessionId: string) {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, session_type, status, started_at)
     VALUES (@sessionId, @taskId, 'ops', 'idle', 0)`,
  ).run({ sessionId, taskId: `gate-item:${itemId}` });

  const intent = stageIntent(
    'gate.verify',
    { gateItemId: itemId, disposition: 'pass' },
    'proj-genuine-retire',
    null,
    sessionId,
    null,
    null,
    null,
    'M12',
    null,
  );
  // Mirrors the turn-boundary checkTerminal call the live session's own
  // turn end already drives in production (checkTerminal is called
  // repeatedly across a session's life, not just once from this bug's
  // retire hook) — priming stagedCountAtResume so the retire hook's own
  // checkTerminal call, later, correctly reads "nothing new since last
  // check" instead of mistaking the already-staged intent for a fresh
  // turn's work.
  planningOrchestrator.checkTerminal(sessionId);
  return intent;
}

function getIntentRow(
  id: string,
): { state: string; disposition_reason: string | null } {
  return db
    .prepare(
      'SELECT state, disposition_reason FROM staged_intent WHERE id = ?',
    )
    .get(id) as { state: string; disposition_reason: string | null };
}

function getSessionStatus(sessionId: string): string {
  return (
    db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get(sessionId) as { status: string }
  ).status;
}

describe('gateService — retiring a genuine gate.verify intent left stranded by a direct disposition', () => {
  it('withdraws a live genuine gate.verify intent and drives its session terminal when the item resolves via the direct pass path', async () => {
    const item = await makeDispatchedRunnableItem();
    const intent = dispatchVerifySession(item.id, 'verify-session-1');
    expect(getIntentRow(intent.id).state).toBe('staged');
    expect(countLivePlanningSessions()).toBe(1);

    appendGateItemEvent(item.id, { disposition: 'pass', operator: 'jane' });

    const row = getIntentRow(intent.id);
    expect(row.state).toBe('withdrawn');
    expect(row.disposition_reason).toMatch(/resolved to pass/);
    expect(getSessionStatus('verify-session-1')).toBe('done');
    expect(countLivePlanningSessions()).toBe(0);
  });

  it('withdraws a live genuine gate.verify intent and drives its session terminal when the item resolves via the direct fail path', async () => {
    const item = await makeDispatchedRunnableItem();
    const intent = dispatchVerifySession(item.id, 'verify-session-2');

    appendGateItemEvent(item.id, { disposition: 'fail', operator: 'jane' });

    expect(getIntentRow(intent.id).state).toBe('withdrawn');
    expect(getSessionStatus('verify-session-2')).toBe('done');
    expect(countLivePlanningSessions()).toBe(0);
  });

  it('withdraws a live genuine gate.verify intent and drives its session terminal when the item resolves via the direct defer (deferred) path', async () => {
    const item = await makeDispatchedRunnableItem();
    const intent = dispatchVerifySession(item.id, 'verify-session-3');

    appendGateItemEvent(item.id, { disposition: 'deferred', operator: 'jane' });

    expect(getIntentRow(intent.id).state).toBe('withdrawn');
    expect(getSessionStatus('verify-session-3')).toBe('done');
    expect(countLivePlanningSessions()).toBe(0);
  });

  it('withdraws a live genuine gate.verify intent and drives its session terminal via the direct reject path (Prod-Mutating pending-approval)', async () => {
    const item = insertItem({
      project: 'proj-genuine-retire',
      milestone: 'M12',
      text: 'Backfill the missing invoice rows in prod',
      classification: 'Prod-Mutating',
      sources: [{ sourceTaskId: 'notion:def', sourceTaskTitle: 'Backfill' }],
      updatedAt: new Date(0).toISOString(),
    });
    setSourceMergeCommit(item.id, 'notion:def', 'sha1');
    setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
    await reconcileGateRunnability('sha1', { project: 'proj-genuine-retire' });
    // Verifier passes it into pending-approval first.
    appendGateItemEvent(item.id, {
      disposition: 'pass',
      operator: 'gate-verifier',
    });
    const intent = dispatchVerifySession(item.id, 'verify-session-4');

    rejectGateItem(item.id, 'not actually safe', 'jane');

    expect(getIntentRow(intent.id).state).toBe('withdrawn');
    expect(getSessionStatus('verify-session-4')).toBe('done');
    expect(countLivePlanningSessions()).toBe(0);
  });

  it('withdraws a live genuine gate.verify intent and drives its session terminal via the direct approve path (Prod-Mutating pending-approval)', async () => {
    const item = insertItem({
      project: 'proj-genuine-retire',
      milestone: 'M12',
      text: 'Backfill the missing invoice rows in prod',
      classification: 'Prod-Mutating',
      sources: [{ sourceTaskId: 'notion:def', sourceTaskTitle: 'Backfill' }],
      updatedAt: new Date(0).toISOString(),
    });
    setSourceMergeCommit(item.id, 'notion:def', 'sha1');
    setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
    await reconcileGateRunnability('sha1', { project: 'proj-genuine-retire' });
    appendGateItemEvent(item.id, {
      disposition: 'pass',
      operator: 'gate-verifier',
    });
    const intent = dispatchVerifySession(item.id, 'verify-session-5');

    approveGateItem(item.id, 'jane');

    expect(getIntentRow(intent.id).state).toBe('withdrawn');
    expect(getSessionStatus('verify-session-5')).toBe('done');
    expect(countLivePlanningSessions()).toBe(0);
  });

  it('withdraws a live genuine gate.verify intent and drives its session terminal via the direct reopen path', async () => {
    const item = await makeDispatchedRunnableItem();
    appendGateItemEvent(item.id, { disposition: 'pass', operator: 'jane' });
    // A fresh dispatched verify session's own intent, staged after the item
    // was already resolved (e.g. re-dispatched then the operator reopens
    // again before the intent is dispositioned).
    const intent = dispatchVerifySession(item.id, 'verify-session-6');

    reopenGateItem(item.id, 'jane', 'needs another look');

    expect(getIntentRow(intent.id).state).toBe('withdrawn');
    expect(getSessionStatus('verify-session-6')).toBe('done');
    expect(countLivePlanningSessions()).toBe(0);
  });

  it('is a no-op when no live genuine gate.verify intent exists for the item (the common case)', async () => {
    const item = await makeDispatchedRunnableItem();

    expect(() =>
      appendGateItemEvent(item.id, { disposition: 'pass', operator: 'jane' }),
    ).not.toThrow();
  });

  it('never retires a live mirror/consent intent through the genuine-intent path — regression check for the existing mirror retire behavior', async () => {
    const item = await makeDispatchedRunnableItem({
      classification: 'Human-Observation',
    });
    reconcileHumanObservationMirrors();
    const mirror = db
      .prepare(
        `SELECT id FROM staged_intent
         WHERE kind = 'gate.verify' AND json_extract(payload, '$.origin') = 'mirror'`,
      )
      .get() as { id: string } | undefined;
    expect(mirror).toBeDefined();
    expect(getIntentRow(mirror!.id).state).toBe('staged');

    // The direct-path disposition write GateReadinessPanel's Pass button
    // makes still resolves the item and still retires the mirror — but via
    // reconcileHumanObservationMirrors' own scan (mirrors have session_id
    // null, so the new genuine-intent sink never touches them).
    appendGateItemEvent(item.id, { disposition: 'pass', operator: 'jane' });
    expect(getIntentRow(mirror!.id).state).toBe('staged');

    reconcileHumanObservationMirrors();
    expect(getIntentRow(mirror!.id).state).toBe('withdrawn');
  });
});
