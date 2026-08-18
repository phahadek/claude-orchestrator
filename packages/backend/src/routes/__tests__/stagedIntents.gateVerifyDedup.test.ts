/**
 * gate.verify staged intents must dedup on their gate item — see
 * extractTaskId's `gate-item:<id>` key in ../stagedIntents. Before that key
 * existed, extractTaskId fell through to the generic `payload.taskId` read
 * (gate.verify payloads carry `gateItemId`, never `taskId`), which is always
 * null — so every gate.verify stage call inserted a brand-new row instead of
 * superseding a still-live prior one for the same item, letting a gate item
 * accumulate multiple simultaneously-staged, conflicting resolutions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { stageIntent } from '../stagedIntents';
import { insertItem } from '../../gate/gateStore.js';
import { findActiveStagedIntentForTask } from '../../db/queries';

const PROJECT_ID = 'proj-a';
const SESSION_ID = 'gate-verify-session-1';

function makeGateItem() {
  return insertItem({
    project: PROJECT_ID,
    milestone: 'M12',
    text: 'the described behavior works as intended',
    classification: 'Read-Only',
    sources: [{ sourceTaskId: 'notion:abc', sourceTaskTitle: 'Some task' }],
    updatedAt: new Date(0).toISOString(),
  });
}

function stageGateVerify(
  gateItemId: string,
  disposition: 'pass' | 'fail' | 'needs-setup' | 'not-yet-triggerable',
  sessionId = SESSION_ID,
  evidence: unknown = { basis: 'operational', explanation: 'observed the trace' },
) {
  return stageIntent(
    'gate.verify',
    { gateItemId, disposition, evidence },
    PROJECT_ID,
    null,
    sessionId,
  );
}

beforeEach(() => {
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM staged_intent_group').run();
});

describe('gate.verify staged-intent dedup', () => {
  it('supersedes a prior staged gate.verify with a different disposition, same session', () => {
    const item = makeGateItem();
    const first = stageGateVerify(item.id, 'pass');

    const second = stageGateVerify(item.id, 'fail');

    expect(second.id).not.toBe(first.id);
    expect(second.state).toBe('staged');

    const firstRow = db
      .prepare('SELECT state, supersedes FROM staged_intent WHERE id = ?')
      .get(first.id) as { state: string; supersedes: string | null };
    expect(firstRow.state).not.toBe('staged');
    expect(['superseded', 'rejected']).toContain(firstRow.state);

    const active = findActiveStagedIntentForTask(
      PROJECT_ID,
      'gate.verify',
      `gate-item:${item.id}`,
    );
    expect(active?.id).toBe(second.id);
  });

  it('supersedes a prior staged gate.verify with a different disposition, across sessions', () => {
    const item = makeGateItem();
    const first = stageGateVerify(item.id, 'pass', 'gate-verify-session-1');

    const second = stageGateVerify(item.id, 'fail', 'gate-verify-session-2');

    expect(second.id).not.toBe(first.id);

    const active = findActiveStagedIntentForTask(
      PROJECT_ID,
      'gate.verify',
      `gate-item:${item.id}`,
    );
    expect(active?.id).toBe(second.id);

    const firstRow = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(first.id) as { state: string };
    expect(firstRow.state).not.toBe('staged');
  });

  it('is a no-op that returns the existing row when the same disposition/evidence is staged twice', () => {
    const item = makeGateItem();
    const evidence = { basis: 'operational', explanation: 'observed the trace' };
    const first = stageGateVerify(item.id, 'pass', SESSION_ID, evidence);

    const second = stageGateVerify(item.id, 'pass', SESSION_ID, evidence);

    expect(second.id).toBe(first.id);
    expect(second.state).toBe('staged');

    const rows = db
      .prepare('SELECT id FROM staged_intent WHERE kind = ?')
      .all('gate.verify') as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
  });

  it('never supersedes across different gate items', () => {
    const itemA = makeGateItem();
    const itemB = makeGateItem();

    const a = stageGateVerify(itemA.id, 'pass');
    const b = stageGateVerify(itemB.id, 'fail');

    expect(a.id).not.toBe(b.id);

    const aRow = db
      .prepare('SELECT state FROM staged_intent WHERE id = ?')
      .get(a.id) as { state: string };
    expect(aRow.state).toBe('staged');

    const activeA = findActiveStagedIntentForTask(
      PROJECT_ID,
      'gate.verify',
      `gate-item:${itemA.id}`,
    );
    const activeB = findActiveStagedIntentForTask(
      PROJECT_ID,
      'gate.verify',
      `gate-item:${itemB.id}`,
    );
    expect(activeA?.id).toBe(a.id);
    expect(activeB?.id).toBe(b.id);
  });
});
