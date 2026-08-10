/**
 * Tests for the reconciler's mirror step
 * (gateReconciler.reconcileHumanObservationMirrors): every runnable
 * Human-Observation gate_item with no live mirror gets one staged as a
 * `gate.verify` intent (origin: 'mirror'), individually (no groupId); every
 * Prod-Mutating gate_item held at pending-approval gets one staged with
 * (origin: 'consent') carrying the item's latest disposition-bearing
 * evidence. The scan is level-triggered and idempotent per origin; a mirror
 * is retired once its gate_item leaves the state that earned it a mirror
 * (resolved, reclassified, or — for a consent mirror — approved/rejected).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { ProjectService } from '../../projects/ProjectService.js';
import {
  insertItem,
  setMinDeployedCommit,
  setSourceMergeCommit,
} from '../gateStore.js';
import {
  appendGateItemEvent,
  approveGateItem,
  rejectGateItem,
  reclassifyGateItem,
  reconcileGateRunnability,
  latestDispositionEvidence,
} from '../gateService.js';
import {
  configureGateItemMirrorSink,
  reconcileHumanObservationMirrors,
} from '../gateReconciler.js';
import {
  stageIntent,
  withdrawGateVerifyMirror,
} from '../../routes/stagedIntents.js';

beforeAll(() => {
  ProjectService.create({
    id: 'proj-mirror',
    name: 'Project Mirror',
    projectDir: '/tmp/proj-mirror',
  });
  ProjectService.createMilestone({
    id: 'ms-uuid-mirror-m12',
    projectId: 'proj-mirror',
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
  db.prepare('DELETE FROM audit_log').run();

  configureGateItemMirrorSink({
    stageMirror(item, origin) {
      stageIntent(
        'gate.verify',
        origin === 'consent'
          ? {
              gateItemId: item.id,
              origin: 'consent',
              evidence: latestDispositionEvidence(item),
            }
          : { gateItemId: item.id, origin: 'mirror' },
        item.project,
        null,
        null,
        origin === 'consent'
          ? `Prod-Mutating (pending approval): ${item.text}`
          : `Human-Observation: ${item.text}`,
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

function makeItem(overrides: Partial<Parameters<typeof insertItem>[0]> = {}) {
  return insertItem({
    project: 'proj-mirror',
    milestone: 'M12',
    text: 'Confirm the new banner renders in the correct brand colour',
    classification: 'Human-Observation',
    sources: [{ sourceTaskId: 'notion:abc', sourceTaskTitle: 'Add banner' }],
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });
}

async function makeRunnableItem(
  overrides: Partial<Parameters<typeof insertItem>[0]> = {},
) {
  const item = makeItem(overrides);
  setSourceMergeCommit(item.id, 'notion:abc', 'sha1');
  setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
  await reconcileGateRunnability('sha1', { project: 'proj-mirror' });
  return item;
}

function liveMirrorRows(
  origin: 'mirror' | 'consent' = 'mirror',
): { id: string; task_id: string | null }[] {
  return db
    .prepare(
      `SELECT id, task_id FROM staged_intent
       WHERE kind = 'gate.verify' AND state IN ('staged', 'approved')
         AND json_extract(payload, '$.origin') = ?`,
    )
    .all(origin) as { id: string; task_id: string | null }[];
}

function makeProdMutatingItem(
  overrides: Partial<Parameters<typeof insertItem>[0]> = {},
) {
  return insertItem({
    project: 'proj-mirror',
    milestone: 'M12',
    text: 'Backfill the missing invoice rows in prod',
    classification: 'Prod-Mutating',
    sources: [{ sourceTaskId: 'notion:def', sourceTaskTitle: 'Backfill' }],
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });
}

/** A Prod-Mutating item held at pending-approval, with a disposition-bearing pass event carrying the given evidence. */
function makePendingApprovalItem(
  evidence: unknown = { basis: 'read-only check' },
) {
  const item = makeProdMutatingItem();
  appendGateItemEvent(item.id, {
    disposition: 'pass',
    evidence,
    operator: 'gate-verifier',
  });
  return item;
}

describe('reconcileHumanObservationMirrors', () => {
  it('stages a mirror for a runnable Human-Observation item with no groupId', async () => {
    const item = await makeRunnableItem();

    const result = reconcileHumanObservationMirrors();

    expect(result.staged).toEqual([item.id]);
    const rows = liveMirrorRows();
    expect(rows).toHaveLength(1);
    const row = db
      .prepare('SELECT * FROM staged_intent WHERE id = ?')
      .get(rows[0].id) as { payload: string; group_id: string | null };
    expect(row.group_id).toBeNull();
    expect(JSON.parse(row.payload)).toMatchObject({
      gateItemId: item.id,
      origin: 'mirror',
    });
  });

  it('never mirrors a non-Human-Observation item', async () => {
    await makeRunnableItem({ classification: 'Read-Only' });

    const result = reconcileHumanObservationMirrors();

    expect(result.staged).toEqual([]);
    expect(liveMirrorRows()).toHaveLength(0);
  });

  it('mirrors an item accreted directly into a runnable state (no open->runnable transition observed)', () => {
    // Simulate accretion straight into `runnable` by advancing state without
    // ever calling reconcileGateRunnability's open->runnable transition
    // path — the mirror scan is level-triggered, not edge-triggered, so it
    // must still catch this on the next pass.
    const item = makeItem();
    db.prepare(`UPDATE gate_item SET state = 'runnable' WHERE id = ?`).run(
      item.id,
    );

    const result = reconcileHumanObservationMirrors();

    expect(result.staged).toEqual([item.id]);
  });

  it('is idempotent — a second pass never re-stages an item with an already-live mirror', async () => {
    await makeRunnableItem();

    const first = reconcileHumanObservationMirrors();
    const second = reconcileHumanObservationMirrors();

    expect(first.staged).toHaveLength(1);
    expect(second.staged).toEqual([]);
    expect(liveMirrorRows()).toHaveLength(1);
  });

  it('retires a live mirror once its gate_item resolves via the direct GateReadinessPanel path', async () => {
    const item = await makeRunnableItem();
    reconcileHumanObservationMirrors();
    expect(liveMirrorRows()).toHaveLength(1);

    // The direct-path disposition write GateReadinessPanel's Pass button
    // makes — bypassing the Decision Inbox entirely.
    appendGateItemEvent(item.id, { disposition: 'pass', operator: 'jane' });

    const result = reconcileHumanObservationMirrors();
    expect(result.retired).toHaveLength(1);
    expect(liveMirrorRows()).toHaveLength(0);

    const row = db
      .prepare(
        'SELECT state, disposition_reason FROM staged_intent WHERE id = ?',
      )
      .get(result.retired[0]) as {
      state: string;
      disposition_reason: string | null;
    };
    expect(row.state).toBe('withdrawn');
    expect(row.disposition_reason).toMatch(/resolved/);
  });

  it('retires a live mirror once its gate_item is reclassified away from Human-Observation', async () => {
    const item = await makeRunnableItem();
    reconcileHumanObservationMirrors();
    expect(liveMirrorRows()).toHaveLength(1);

    reclassifyGateItem(item.id, 'Read-Only', 'jane');

    const result = reconcileHumanObservationMirrors();
    expect(result.retired).toHaveLength(1);
    expect(liveMirrorRows()).toHaveLength(0);

    const row = db
      .prepare('SELECT disposition_reason FROM staged_intent WHERE id = ?')
      .get(result.retired[0]) as { disposition_reason: string | null };
    expect(row.disposition_reason).toMatch(/reclassified/);
  });

  it('does not restage a mirror for an item that was just retired in the same tick sequence unless it becomes runnable again', async () => {
    const item = await makeRunnableItem();
    reconcileHumanObservationMirrors();
    appendGateItemEvent(item.id, { disposition: 'pass', operator: 'jane' });
    reconcileHumanObservationMirrors();

    const result = reconcileHumanObservationMirrors();
    expect(result.staged).toEqual([]);
    expect(result.retired).toEqual([]);
    expect(liveMirrorRows()).toHaveLength(0);
  });
});

describe('reconcileHumanObservationMirrors — consent mirrors (Prod-Mutating pending-approval)', () => {
  it('stages a consent mirror carrying the evidence behind the held pass', () => {
    const item = makePendingApprovalItem({ basis: 'read-only dry run' });

    const result = reconcileHumanObservationMirrors();

    expect(result.staged).toEqual([item.id]);
    const rows = liveMirrorRows('consent');
    expect(rows).toHaveLength(1);
    const row = db
      .prepare('SELECT * FROM staged_intent WHERE id = ?')
      .get(rows[0].id) as { payload: string; group_id: string | null };
    expect(row.group_id).toBeNull();
    expect(JSON.parse(row.payload)).toMatchObject({
      gateItemId: item.id,
      origin: 'consent',
      evidence: { basis: 'read-only dry run' },
    });
  });

  it('never mirrors an item in another state or classification', async () => {
    makeProdMutatingItem(); // open, never passed — not pending-approval
    await makeRunnableItem({ classification: 'Read-Only' });
    await makeRunnableItem();

    const result = reconcileHumanObservationMirrors();

    expect(liveMirrorRows('consent')).toHaveLength(0);
    // The Human-Observation runnable item is still mirrored as before —
    // broadening the scan to a second origin doesn't affect the first.
    expect(liveMirrorRows('mirror')).toHaveLength(1);
    expect(result.staged).toHaveLength(1);
  });

  it('is idempotent — a second pass never re-stages a consent mirror with an already-live one', () => {
    makePendingApprovalItem();

    const first = reconcileHumanObservationMirrors();
    const second = reconcileHumanObservationMirrors();

    expect(first.staged).toHaveLength(1);
    expect(second.staged).toEqual([]);
    expect(liveMirrorRows('consent')).toHaveLength(1);
  });

  it('retires a consent mirror once its item is approved from the milestone surface, converging with the direct approve path', () => {
    const item = makePendingApprovalItem();
    reconcileHumanObservationMirrors();
    expect(liveMirrorRows('consent')).toHaveLength(1);

    const approved = approveGateItem(item.id, 'pedro');
    expect(approved.state).toBe('pass');

    const result = reconcileHumanObservationMirrors();
    expect(result.retired).toHaveLength(1);
    expect(liveMirrorRows('consent')).toHaveLength(0);
  });

  it('retires a consent mirror once its item is rejected, and the item stays unresolved', () => {
    const item = makePendingApprovalItem();
    reconcileHumanObservationMirrors();

    rejectGateItem(item.id, 'not consenting', 'pedro');

    const result = reconcileHumanObservationMirrors();
    expect(result.retired).toHaveLength(1);
    expect(liveMirrorRows('consent')).toHaveLength(0);
  });

  it('closes the loop: a rejected item reopened for re-verification is mirrored again once it passes back to pending-approval', () => {
    const item = makePendingApprovalItem();
    reconcileHumanObservationMirrors();
    rejectGateItem(item.id, 'not consenting');
    reconcileHumanObservationMirrors();
    expect(liveMirrorRows('consent')).toHaveLength(0);

    appendGateItemEvent(item.id, {
      disposition: 'pass',
      operator: 'gate-verifier',
    });
    const result = reconcileHumanObservationMirrors();

    expect(result.staged).toEqual([item.id]);
    expect(liveMirrorRows('consent')).toHaveLength(1);
  });

  it('never re-stages once approved or rejected — not re-surfaced on a later tick', () => {
    const item = makePendingApprovalItem();
    reconcileHumanObservationMirrors();
    approveGateItem(item.id);
    reconcileHumanObservationMirrors();

    const result = reconcileHumanObservationMirrors();
    expect(result.staged).toEqual([]);
    expect(result.retired).toEqual([]);
    expect(liveMirrorRows('consent')).toHaveLength(0);
  });
});
