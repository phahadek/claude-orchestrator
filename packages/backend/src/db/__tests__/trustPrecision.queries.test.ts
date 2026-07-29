/**
 * Tests for the auto-dispatch trust-precision rejection/abstain-rate read
 * (db/queries.ts's getFlowRejectionRate): groom/design/ops read the
 * staged_intent disposition-rejection rate (pushback/decline vs approve);
 * gate-verify reads the abstain (needs-setup) rate off gate_item_event.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertSession,
  insertStagedIntent,
  hashIntentPayload,
  getFlowRejectionRate,
} from '../queries.js';
import type { StagedIntentRow } from '../types.js';
import { insertItem, appendEvent } from '../../gate/gateStore.js';

beforeEach(() => {
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
});

function seedSession(sessionId: string, sessionType: string): void {
  insertSession({
    session_id: sessionId,
    task_id: `task:${sessionId}`,
    task_url: null,
    project_context_url: null,
    status: 'done',
    started_at: 0,
    project_id: 'proj-1',
    session_type: sessionType,
    task_name: null,
    metadata: null,
    review_result: null,
    pause_reason: null,
    last_error_detail: null,
    events_pruned_at: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    compaction_count: 0,
    context_occupancy_tokens: 0,
  } as never);
}

let seq = 0;
function seedStagedIntent(
  sessionId: string | null,
  state: StagedIntentRow['state'],
): void {
  seq += 1;
  const payload = JSON.stringify({ n: seq });
  insertStagedIntent({
    id: `intent-${seq}`,
    kind: 'task.setStatus',
    payload,
    payload_hash: hashIntentPayload(JSON.parse(payload)),
    task_id: `t-${seq}`,
    project_id: 'proj-1',
    session_id: sessionId,
    group_id: null,
    state,
    supersedes: null,
    annotation: null,
    decision_proposal: null,
    groom_proposal: null,
    advisory: null,
    disposition_reason: null,
    answer: null,
    created_at: seq,
    updated_at: seq,
  });
}

describe('getFlowRejectionRate — staging flows (groom/design/ops)', () => {
  it('computes the disposition-rejection rate from pushback/decline vs approve/commit', () => {
    seedSession('s-groom-1', 'groom');
    seedStagedIntent('s-groom-1', 'approved');
    seedStagedIntent('s-groom-1', 'committed');
    seedStagedIntent('s-groom-1', 'rejected'); // decline
    seedStagedIntent('s-groom-1', 'needs_revision'); // pushback
    seedStagedIntent('s-groom-1', 'staged'); // still pending — excluded from the denominator

    const result = getFlowRejectionRate('proj-1', 'M12', 'groom');
    expect(result).toMatchObject({
      flow: 'groom',
      total: 4,
      rejected: 2,
      rate: 0.5,
    });
  });

  it('scopes by session_type — a design session intent does not count toward groom', () => {
    seedSession('s-groom-1', 'groom');
    seedSession('s-design-1', 'design');
    seedStagedIntent('s-groom-1', 'approved');
    seedStagedIntent('s-design-1', 'rejected');

    const groom = getFlowRejectionRate('proj-1', 'M12', 'groom');
    expect(groom).toMatchObject({ total: 1, rejected: 0, rate: 0 });

    const design = getFlowRejectionRate('proj-1', 'M12', 'design');
    expect(design).toMatchObject({ total: 1, rejected: 1, rate: 1 });
  });

  it('returns a null rate when there is no denominator yet', () => {
    const result = getFlowRejectionRate('proj-1', 'M12', 'ops');
    expect(result).toMatchObject({ total: 0, rejected: 0, rate: null });
  });
});

describe('getFlowRejectionRate — gate-verify', () => {
  function makeGateItem(project: string, milestone: string) {
    return insertItem({
      project,
      milestone,
      text: 'Verify the thing',
      classification: 'Read-Only',
      sources: [{ sourceTaskId: 'notion:abc', sourceTaskTitle: 'thing' }],
      updatedAt: new Date(0).toISOString(),
    });
  }

  it('computes the abstain rate from needs-setup dispositions, scoped to project+milestone', () => {
    const a = makeGateItem('proj-1', 'M12');
    const b = makeGateItem('proj-1', 'M12');
    const c = makeGateItem('proj-1', 'M12');
    appendEvent(a.id, { disposition: 'pass', at: new Date(1).toISOString() });
    appendEvent(b.id, {
      disposition: 'needs-setup',
      at: new Date(1).toISOString(),
    });
    appendEvent(c.id, { disposition: 'fail', at: new Date(1).toISOString() });

    const result = getFlowRejectionRate('proj-1', 'M12', 'gate-verify');
    expect(result).toMatchObject({
      flow: 'gate-verify',
      total: 3,
      rejected: 1,
      rate: 1 / 3,
    });
  });

  it('does not mix in events from a different milestone', () => {
    const inMilestone = makeGateItem('proj-1', 'M12');
    const otherMilestone = makeGateItem('proj-1', 'M13');
    appendEvent(inMilestone.id, {
      disposition: 'needs-setup',
      at: new Date(1).toISOString(),
    });
    appendEvent(otherMilestone.id, {
      disposition: 'needs-setup',
      at: new Date(1).toISOString(),
    });

    const result = getFlowRejectionRate('proj-1', 'M12', 'gate-verify');
    expect(result).toMatchObject({ total: 1, rejected: 1, rate: 1 });
  });
});
