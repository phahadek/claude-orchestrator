/**
 * A gate-verify session must not spend its `gate.verify` disposition while
 * it still has an outstanding `session.requestCapability` request of its
 * own — see GateVerifyCapabilityRequestOutstandingError /
 * assertNoOutstandingCapabilityRequest in ../stagedIntents. This reuses the
 * exact same `hasActiveCapabilityRequestForSession` predicate
 * GateItemVerifier's onBudgetFire already uses to suspend the verification
 * budget rather than time the session out — here it refuses the disposition
 * at stage time instead of silently deferring it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { stageIntent } from '../stagedIntents';
import { insertItem } from '../../gate/gateStore.js';
import { transitionStagedIntent } from '../../db/queries';

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

function stageCapabilityRequest(sessionId = SESSION_ID) {
  return stageIntent(
    'session.requestCapability',
    {
      capability: 'Bash(curl:*)',
      plan: 'GET /api/staged-intents to read live state',
      evidence: 'no HTTP client or device auth to produce one myself',
    },
    PROJECT_ID,
    null,
    sessionId,
  );
}

function stageGateVerify(gateItemId: string, sessionId = SESSION_ID) {
  return stageIntent(
    'gate.verify',
    {
      gateItemId,
      disposition: 'pass',
      evidence: { basis: 'operational', explanation: 'observed the trace' },
    },
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

describe('gate.verify stage-time capability-request guard', () => {
  it('refuses gate.verify while the session has an outstanding capability request, naming it', () => {
    const item = makeGateItem();
    stageCapabilityRequest();

    expect(() => stageGateVerify(item.id)).toThrowError(
      /outstanding.*session\.requestCapability.*Bash\(curl:\*\)/s,
    );
  });

  it('does not affect gate.verify staged by a session with no outstanding capability request', () => {
    const item = makeGateItem();

    const intent = stageGateVerify(item.id);
    expect(intent.kind).toBe('gate.verify');
    expect(intent.state).toBe('staged');
  });

  it('does not affect gate.verify staged by a different session that has an outstanding request', () => {
    const item = makeGateItem();
    stageCapabilityRequest('other-session');

    const intent = stageGateVerify(item.id, SESSION_ID);
    expect(intent.kind).toBe('gate.verify');
  });

  it('allows gate.verify again once the outstanding request is granted (committed)', () => {
    const item = makeGateItem();
    const request = stageCapabilityRequest();

    transitionStagedIntent(request.id, 'approved');
    transitionStagedIntent(request.id, 'committed');

    const intent = stageGateVerify(item.id);
    expect(intent.kind).toBe('gate.verify');
    expect(intent.state).toBe('staged');
  });

  it('allows gate.verify again once the outstanding request is rejected', () => {
    const item = makeGateItem();
    const request = stageCapabilityRequest();

    transitionStagedIntent(request.id, 'rejected');

    const intent = stageGateVerify(item.id);
    expect(intent.kind).toBe('gate.verify');
    expect(intent.state).toBe('staged');
  });
});
