/**
 * Tests for the cross-project gate-verify fleet snapshot
 * (packages/backend/src/gate/gateService.ts's getGateVerifyFleetState,
 * backing GET /api/gate/fleet).
 *
 * AC: the snapshot spans every project in a single response; the exposed
 * live count matches the length of the returned session rows; and
 * elapsed/remaining are computed purely from sessions.started_at at read
 * time (not cached), so they read correctly even for a session seeded with
 * a long-past started_at — proving the values survive a process restart
 * without one actually happening.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  insertSession,
  insertStagedIntent,
  hashIntentPayload,
  insertSchedulerAudit,
} from '../../db/queries.js';
import { insertItem } from '../gateStore.js';
import { getGateVerifyFleetState } from '../gateService.js';
import { DEFAULT_BUDGET_MS } from '../gateItemVerifier.js';

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM staged_intent').run();
  db.prepare('DELETE FROM scheduler_audit').run();
  db.prepare('DELETE FROM gate_item_event').run();
  db.prepare('DELETE FROM gate_item_source').run();
  db.prepare('DELETE FROM gate_item').run();
});

function makeItem(project: string, text: string) {
  return insertItem({
    project,
    milestone: 'M12',
    text,
    classification: 'Read-Only',
    sources: [{ sourceTaskId: `notion:${project}`, sourceTaskTitle: text }],
    updatedAt: new Date(0).toISOString(),
  });
}

function seedLiveSession(
  sessionId: string,
  itemId: string,
  projectId: string,
  startedAt: number,
  status = 'running',
) {
  insertSession({
    session_id: sessionId,
    task_id: `gate-item:${itemId}`,
    task_url: null,
    project_context_url: null,
    status,
    started_at: startedAt,
    project_id: projectId,
    session_type: 'ops',
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

describe('getGateVerifyFleetState', () => {
  it('spans more than one project in a single response', () => {
    const itemA = makeItem('project-a', 'Verify A');
    const itemB = makeItem('project-b', 'Verify B');
    seedLiveSession('sess-a', itemA.id, 'project-a', Date.now());
    seedLiveSession('sess-b', itemB.id, 'project-b', Date.now());

    const result = getGateVerifyFleetState();

    const projects = new Set(result.sessions.map((s) => s.project));
    expect(projects).toEqual(new Set(['project-a', 'project-b']));
  });

  it('exposes a live count equal to the number of returned session rows', () => {
    const itemA = makeItem('project-a', 'Verify A');
    const itemB = makeItem('project-a', 'Verify B');
    const itemC = makeItem('project-b', 'Verify C');
    seedLiveSession('sess-a', itemA.id, 'project-a', Date.now(), 'running');
    seedLiveSession('sess-b', itemB.id, 'project-a', Date.now(), 'idle');
    seedLiveSession('sess-c', itemC.id, 'project-b', Date.now(), 'starting');
    // Terminal — must not be counted as live.
    const itemD = makeItem('project-b', 'Verify D');
    seedLiveSession('sess-d', itemD.id, 'project-b', Date.now(), 'done');

    const result = getGateVerifyFleetState();

    expect(result.sessions).toHaveLength(3);
    expect(result.liveCount).toBe(result.sessions.length);
  });

  it('computes elapsed/remaining from sessions.started_at at read time, not a cached value', () => {
    const item = makeItem('project-a', 'Verify A');
    const now = 10_000_000;
    const elapsedSoFar = 5 * 60_000; // 5 minutes
    const startedAt = now - elapsedSoFar;
    seedLiveSession('sess-a', item.id, 'project-a', startedAt);

    const result = getGateVerifyFleetState(now);

    expect(result.sessions).toHaveLength(1);
    const [session] = result.sessions;
    expect(session.startedAt).toBe(startedAt);
    expect(session.elapsedMs).toBe(elapsedSoFar);
    expect(session.remainingMs).toBe(DEFAULT_BUDGET_MS - elapsedSoFar);
  });

  it('marks a session suspended when it has an active capability request', () => {
    const item = makeItem('project-a', 'Verify A');
    seedLiveSession('sess-a', item.id, 'project-a', Date.now());
    const payload = JSON.stringify({
      capability: 'Bash(sqlite3 dashboard.db:*)',
      plan: 'read the operational record',
      evidence: 'gate item needs an audited DB read',
    });
    insertStagedIntent({
      id: 'cap-1',
      kind: 'session.requestCapability',
      payload,
      payload_hash: hashIntentPayload(JSON.parse(payload)),
      task_id: `gate-item:${item.id}`,
      project_id: 'project-a',
      session_id: 'sess-a',
      group_id: 'group-1',
      milestone: null,
      state: 'staged',
      supersedes: null,
      annotation: null,
      decision_proposal: null,
      groom_proposal: null,
      advisory: null,
      disposition_reason: null,
      answer: null,
      created_at: 1,
      updated_at: 1,
    } as never);

    const result = getGateVerifyFleetState();

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].suspended).toBe(true);
  });

  it('reads recent skippedForBudget history from scheduler_audit', () => {
    insertSchedulerAudit({
      job: 'gate_verification_reconciler',
      status: 'ok',
      started_at: new Date(1000).toISOString(),
      completed_at: new Date(2000).toISOString(),
      duration_ms: 1000,
      items_processed: -3,
    });
    insertSchedulerAudit({
      job: 'gate_verification_reconciler',
      status: 'ok',
      started_at: new Date(3000).toISOString(),
      completed_at: new Date(4000).toISOString(),
      duration_ms: 1000,
      items_processed: 0,
    });

    const result = getGateVerifyFleetState();

    expect(result.skippedForBudgetHistory).toHaveLength(1);
    expect(result.skippedForBudgetHistory[0].skippedCount).toBe(3);
  });
});
