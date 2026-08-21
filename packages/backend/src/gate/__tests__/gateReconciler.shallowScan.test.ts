/**
 * Regression coverage for the gate-verification reconciler's scan-shape fix:
 * runGateReconcilerTick (and its reconcileHumanObservationMirrors step) used
 * to call gateStore.listAll(), which N+1-hydrates every all-time gate_item
 * row's sources+events via gateStore.getItem() even though the reconciler
 * only reads project/milestone/classification/state off the bulk scan. Both
 * call sites now use gateStore.listAllShallow() for the bulk scan; getItem()
 * is only called (individually, per-candidate) where a matched item is
 * actually handed to the injected mirror sink, which does read .events for
 * consent-origin evidence — see gateReconciler.ts's
 * reconcileHumanObservationMirrors. See the "Fix multi-second to 71-second
 * GET / stalls" task.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { ProjectService } from '../../projects/ProjectService.js';
import { upsertArm } from '../../db/queries.js';
import { Scheduler } from '../../orchestration/Scheduler.js';
import * as gateStore from '../gateStore.js';
import { insertItem } from '../gateStore.js';
import {
  configureGateItemMirrorSink,
  reconcileHumanObservationMirrors,
  register,
  runGateReconcilerTick,
} from '../gateReconciler.js';

let m12Id: string;

beforeAll(() => {
  ProjectService.create({
    id: 'shallow-scan-proj',
    name: 'Shallow Scan Proj',
    projectDir: '/tmp/shallow-scan-proj',
  });
  m12Id = ProjectService.createMilestone({
    id: 'ms-uuid-shallow-scan-m12',
    projectId: 'shallow-scan-proj',
    name: 'M12',
    canonicalShortId: 'M12',
  }).id;
});

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM flow_arm').run();
  configureGateItemMirrorSink({
    stageMirror: vi.fn(),
    retireMirror: vi.fn(),
  });
});

function seedItem(overrides: Partial<Parameters<typeof insertItem>[0]> = {}) {
  return insertItem({
    project: 'shallow-scan-proj',
    milestone: 'M12',
    text: 'some item',
    classification: 'Read-Only',
    sources: [{ sourceTaskId: 'notion:src', sourceTaskTitle: 'src' }],
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });
}

describe('gateReconciler — shallow bulk scan', () => {
  it('reconcileHumanObservationMirrors calls listAllShallow (not listAll) for its bulk scan', () => {
    const listAllSpy = vi.spyOn(gateStore, 'listAll');
    const listAllShallowSpy = vi.spyOn(gateStore, 'listAllShallow');
    for (let i = 0; i < 15; i++) {
      seedItem({ text: `not a candidate ${i}` });
    }

    reconcileHumanObservationMirrors();

    expect(listAllShallowSpy).toHaveBeenCalled();
    expect(listAllSpy).not.toHaveBeenCalled();
    listAllSpy.mockRestore();
    listAllShallowSpy.mockRestore();
  });

  it('getItem is never called for items that are not mirror/consent candidates, no matter how many exist', () => {
    for (let i = 0; i < 30; i++) {
      seedItem({ classification: 'Read-Only', text: `open item ${i}` });
    }
    const getItemSpy = vi.spyOn(gateStore, 'getItem');

    reconcileHumanObservationMirrors();

    expect(getItemSpy).not.toHaveBeenCalled();
    getItemSpy.mockRestore();
  });

  it('getItem call count scales with the number of live mirror/consent candidates, not with total historical gate_item rows', () => {
    // A large pile of irrelevant historical items — must cost nothing extra.
    for (let i = 0; i < 40; i++) {
      seedItem({ classification: 'Read-Only', text: `noise ${i}` });
    }
    // Exactly 2 genuine mirror candidates: runnable Human-Observation items.
    const mirrorCandidate1 = seedItem({
      classification: 'Human-Observation',
      text: 'mirror candidate 1',
    });
    gateStore.advanceState(
      mirrorCandidate1.id,
      'runnable',
      undefined,
      new Date(1).toISOString(),
    );
    const mirrorCandidate2 = seedItem({
      classification: 'Human-Observation',
      text: 'mirror candidate 2',
    });
    gateStore.advanceState(
      mirrorCandidate2.id,
      'runnable',
      undefined,
      new Date(1).toISOString(),
    );

    const getItemSpy = vi.spyOn(gateStore, 'getItem');
    const result = reconcileHumanObservationMirrors();

    expect(result.staged.sort()).toEqual(
      [mirrorCandidate1.id, mirrorCandidate2.id].sort(),
    );
    // Bounded to the 2 real candidates, not the 42 total rows.
    expect(getItemSpy).toHaveBeenCalledTimes(2);
    getItemSpy.mockRestore();
  });

  it('runGateReconcilerTick performs a bounded number of gate_item bulk-scan queries independent of historical row count', async () => {
    for (let i = 0; i < 50; i++) {
      seedItem({ text: `history ${i}` });
    }
    upsertArm(m12Id, 'gate-verify', true, 1);
    const listAllSpy = vi.spyOn(gateStore, 'listAll');
    const listAllShallowSpy = vi.spyOn(gateStore, 'listAllShallow');

    await runGateReconcilerTick();

    // listAll() (the N+1-hydrating full scan) must never be used for the
    // bulk pass; listAllShallow() is called exactly twice per tick (the
    // runnability/grouping pass, and the mirror pass) regardless of how
    // many gate_item rows exist.
    expect(listAllSpy).not.toHaveBeenCalled();
    expect(listAllShallowSpy).toHaveBeenCalledTimes(2);
    listAllSpy.mockRestore();
    listAllShallowSpy.mockRestore();
  });

  it('a trivial route handler resolves without waiting on the reconciler tick — a real Scheduler run against a realistic historical row count blocks the event loop for well under a second', async () => {
    // Realistic scale: enough historical gate_item rows, each with sources,
    // that the old listAll()/getItem() N+1 (2N+1 synchronous queries) would
    // have measurably blocked the loop; a bare GET / competing for the loop
    // at the same moment must not queue behind it.
    for (let i = 0; i < 300; i++) {
      seedItem({ text: `history ${i}` });
    }
    upsertArm(m12Id, 'gate-verify', true, 1);

    const scheduler = new Scheduler();
    scheduler.setBroadcast(() => {});
    register(scheduler);
    scheduler.start();

    let handlerResolvedAt = 0;
    const handlerScheduledAt = Date.now();
    const trivialRouteHandler = new Promise<void>((resolve) => {
      setImmediate(() => {
        handlerResolvedAt = Date.now();
        resolve();
      });
    });

    await scheduler.triggerNow('gate_verification_reconciler');
    await trivialRouteHandler;
    await scheduler.stopAll();

    const row = db
      .prepare(
        `SELECT event_loop_blocked_ms FROM scheduler_audit
         WHERE job = 'gate_verification_reconciler'
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as { event_loop_blocked_ms: number | null };
    expect(row.event_loop_blocked_ms).not.toBeNull();
    // The old N+1 hydration pattern measurably blocked the loop for
    // multiple seconds under production row counts (up to 71s observed).
    // A trivial competing handler must get a turn well under a second.
    expect(row.event_loop_blocked_ms as number).toBeLessThan(1000);
    expect(handlerResolvedAt - handlerScheduledAt).toBeLessThan(1000);
  }, 20000);
});
