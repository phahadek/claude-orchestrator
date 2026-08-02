/**
 * Tests for the Human-Observation mirror step
 * (gateReconciler.reconcileHumanObservationMirrors): every runnable
 * Human-Observation gate_item with no live mirror gets one staged as a
 * `gate.verify` intent (origin: 'mirror'), individually (no groupId); the
 * scan is level-triggered and idempotent; a mirror is retired once its
 * gate_item resolves or is reclassified away from Human-Observation.
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
  reclassifyGateItem,
  reconcileGateRunnability,
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
    stageMirror(item) {
      stageIntent(
        'gate.verify',
        { gateItemId: item.id, origin: 'mirror' },
        item.project,
        null,
        null,
        `Human-Observation: ${item.text}`,
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

function makeRunnableItem(
  overrides: Partial<Parameters<typeof insertItem>[0]> = {},
) {
  const item = makeItem(overrides);
  setSourceMergeCommit(item.id, 'notion:abc', 'sha1');
  setMinDeployedCommit(item.id, 'sha1', new Date(1).toISOString());
  reconcileGateRunnability('sha1', { project: 'proj-mirror' });
  return item;
}

function liveMirrorRows(): { id: string; task_id: string | null }[] {
  return db
    .prepare(
      `SELECT id, task_id FROM staged_intent
       WHERE kind = 'gate.verify' AND state IN ('staged', 'approved')
         AND json_extract(payload, '$.origin') = 'mirror'`,
    )
    .all() as { id: string; task_id: string | null }[];
}

describe('reconcileHumanObservationMirrors', () => {
  it('stages a mirror for a runnable Human-Observation item with no groupId', () => {
    const item = makeRunnableItem();

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

  it('never mirrors a non-Human-Observation item', () => {
    makeRunnableItem({ classification: 'Read-Only' });

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

  it('is idempotent — a second pass never re-stages an item with an already-live mirror', () => {
    makeRunnableItem();

    const first = reconcileHumanObservationMirrors();
    const second = reconcileHumanObservationMirrors();

    expect(first.staged).toHaveLength(1);
    expect(second.staged).toEqual([]);
    expect(liveMirrorRows()).toHaveLength(1);
  });

  it('retires a live mirror once its gate_item resolves via the direct GateReadinessPanel path', () => {
    const item = makeRunnableItem();
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

  it('retires a live mirror once its gate_item is reclassified away from Human-Observation', () => {
    const item = makeRunnableItem();
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

  it('does not restage a mirror for an item that was just retired in the same tick sequence unless it becomes runnable again', () => {
    const item = makeRunnableItem();
    reconcileHumanObservationMirrors();
    appendGateItemEvent(item.id, { disposition: 'pass', operator: 'jane' });
    reconcileHumanObservationMirrors();

    const result = reconcileHumanObservationMirrors();
    expect(result.staged).toEqual([]);
    expect(result.retired).toEqual([]);
    expect(liveMirrorRows()).toHaveLength(0);
  });
});
