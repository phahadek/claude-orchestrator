/**
 * Tests for the Milestone view's two-tier attention detection
 * (packages/backend/src/convergence/attentionSignals.ts).
 *
 * AC: aging past threshold, flat convergence over the window, and a
 * blocked/stalled task each produce a tier-2 signal; each signal's `key`
 * is stable for the same underlying condition (the frontend dedups on it).
 * Also covers the actionability filter: the nav badge's pendingCount (and
 * the tier-2 signals derived from it) must only ever count staged intents
 * the milestone decision inbox would actually render — see
 * isMilestoneActionable/resolveSessionCompleteForDisplay.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import {
  insertStagedIntent,
  insertSession,
  hashIntentPayload,
} from '../../db/queries.js';
import type { StagedIntentRow } from '../../db/types.js';
import {
  detectAgingSignals,
  detectBlockedSignals,
  detectFlatSignal,
  computeMilestoneAttentionSignals,
  isMilestoneActionable,
  resolveSessionCompleteForDisplay,
} from '../attentionSignals';
import type { ConvergenceSnapshotRow } from '../../db/types';
import type { PauseReasonStruct } from '../../db/pauseReason';

const HOUR = 3_600_000;

describe('detectAgingSignals', () => {
  it('fires for a decision older than the threshold', () => {
    const now = 1_000_000;
    const pending = [
      { id: 'intent-1', created_at: now - 25 * HOUR, kind: 'task.setStatus' },
    ];
    const signals = detectAgingSignals(pending, now, 24 * HOUR);
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('aging:intent-1');
    expect(signals[0].type).toBe('aging');
  });

  it('does not fire for a decision within the threshold', () => {
    const now = 1_000_000;
    const pending = [
      { id: 'intent-1', created_at: now - 1 * HOUR, kind: 'task.setStatus' },
    ];
    expect(detectAgingSignals(pending, now, 24 * HOUR)).toHaveLength(0);
  });

  it('produces a stable key for the same intent across repeated calls', () => {
    const now = 1_000_000;
    const pending = [
      { id: 'intent-1', created_at: now - 25 * HOUR, kind: 'task.setStatus' },
    ];
    const first = detectAgingSignals(pending, now, 24 * HOUR);
    const second = detectAgingSignals(pending, now + HOUR, 24 * HOUR);
    expect(first[0].key).toBe(second[0].key);
  });

  it('does not fire for a session-less gate.verify mirror intent past the threshold, while an equivalent planning intent still does', () => {
    const now = 1_000_000;
    const pending = [
      { id: 'gate-verify-1', created_at: now - 89 * HOUR, kind: 'gate.verify' },
      {
        id: 'planning-1',
        created_at: now - 89 * HOUR,
        kind: 'task.setStatus',
      },
    ];
    const signals = detectAgingSignals(pending, now, 24 * HOUR);
    expect(signals.map((s) => s.key)).toEqual(['aging:planning-1']);
  });
});

describe('detectBlockedSignals', () => {
  function pause(
    overrides: Partial<PauseReasonStruct> = {},
  ): PauseReasonStruct {
    return {
      reason: 'planning_terminal_no_decision',
      source: 'session',
      severity: 'needs_attention',
      retry_strategy: 'manual_action',
      ...overrides,
    };
  }

  it('fires for a needs_attention pause reason', () => {
    const signals = detectBlockedSignals([
      { task_id: 'task-1', parsed: pause() },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('blocked:task-1:planning_terminal_no_decision');
  });

  it('fires for a terminal pause reason', () => {
    const signals = detectBlockedSignals([
      { task_id: 'task-1', parsed: pause({ severity: 'terminal' }) },
    ]);
    expect(signals).toHaveLength(1);
  });

  it('does not fire for a recoverable pause reason', () => {
    const signals = detectBlockedSignals([
      { task_id: 'task-1', parsed: pause({ severity: 'recoverable' }) },
    ]);
    expect(signals).toHaveLength(0);
  });
});

describe('detectFlatSignal', () => {
  function snapshot(
    overrides: Partial<ConvergenceSnapshotRow> = {},
  ): ConvergenceSnapshotRow {
    return {
      id: 'snap-1',
      project: 'proj-1',
      milestone: 'M12',
      ts: new Date(0).toISOString(),
      tasks_open: 1,
      tasks_closed: 0,
      gate_open: 0,
      gate_closed: 0,
      gate_parked: 0,
      seed_open: 0,
      seed_closed: 0,
      ops_open: 0,
      ops_closed: 0,
      total_scope: 1,
      distance_to_green: 1,
      status: 'blocked',
      ...overrides,
    };
  }

  it('fires when distanceToGreen has not improved over the window', () => {
    const now = 100 * HOUR;
    const history = [
      snapshot({ ts: new Date(0).toISOString(), distance_to_green: 3 }),
      snapshot({
        ts: new Date(now - 1 * HOUR).toISOString(),
        distance_to_green: 3,
      }),
    ];
    const signals = detectFlatSignal(history, now, 24 * HOUR, 'proj-1:M12');
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('flat:proj-1:M12');
  });

  it('does not fire when distanceToGreen improved over the window', () => {
    const now = 100 * HOUR;
    const history = [
      snapshot({ ts: new Date(0).toISOString(), distance_to_green: 5 }),
      snapshot({
        ts: new Date(now - 1 * HOUR).toISOString(),
        distance_to_green: 1,
      }),
    ];
    expect(
      detectFlatSignal(history, now, 24 * HOUR, 'proj-1:M12'),
    ).toHaveLength(0);
  });

  it('does not fire once the milestone is green', () => {
    const now = 100 * HOUR;
    const history = [
      snapshot({
        ts: new Date(0).toISOString(),
        distance_to_green: 0,
        status: 'green',
      }),
    ];
    expect(
      detectFlatSignal(history, now, 24 * HOUR, 'proj-1:M12'),
    ).toHaveLength(0);
  });

  it('does not fire when there is not yet enough retained history', () => {
    const now = 100 * HOUR;
    const history = [
      snapshot({
        ts: new Date(now - 1 * HOUR).toISOString(),
        distance_to_green: 3,
      }),
    ];
    expect(
      detectFlatSignal(history, now, 24 * HOUR, 'proj-1:M12'),
    ).toHaveLength(0);
  });

  it('produces a stable key regardless of the latest snapshot timestamp', () => {
    const now = 100 * HOUR;
    const history = [
      snapshot({ ts: new Date(0).toISOString(), distance_to_green: 3 }),
      snapshot({
        ts: new Date(now - 1 * HOUR).toISOString(),
        distance_to_green: 3,
      }),
    ];
    const first = detectFlatSignal(history, now, 24 * HOUR, 'proj-1:M12');
    const second = detectFlatSignal(
      [
        ...history,
        snapshot({ ts: new Date(now).toISOString(), distance_to_green: 3 }),
      ],
      now + HOUR,
      24 * HOUR,
      'proj-1:M12',
    );
    expect(first[0].key).toBe(second[0].key);
  });
});

describe('computeMilestoneAttentionSignals actionability filter', () => {
  const PROJECT_ID = 'proj-attn';
  const MILESTONE = 'M-attn';

  function makeSessionManager(hasActiveTurn: boolean) {
    return {
      getLiveSession: vi.fn().mockReturnValue({
        hasActiveTurn: vi.fn(() => hasActiveTurn),
      }),
    } as never;
  }

  function seedSession(sessionId: string): void {
    insertSession({
      session_id: sessionId,
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: 0,
      session_type: 'standard',
      note: null,
      tags: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      compaction_count: 0,
      context_occupancy_tokens: 0,
      task_name: null,
      metadata: null,
      review_result: null,
      pause_reason: null,
      last_error_detail: null,
      events_pruned_at: null,
      granted_capabilities: '[]',
    } as never);
  }

  function stageRow(overrides: Partial<StagedIntentRow> = {}): StagedIntentRow {
    const payload = overrides.payload ?? JSON.stringify({ taskId: 't-1' });
    const row: StagedIntentRow = {
      id: overrides.id ?? 'intent-1',
      kind: 'task.setStatus',
      payload,
      payload_hash: hashIntentPayload(JSON.parse(payload)),
      task_id: 't-1',
      project_id: PROJECT_ID,
      session_id: null,
      group_id: null,
      milestone: MILESTONE,
      state: 'staged',
      supersedes: null,
      annotation: null,
      decision_proposal: null,
      investigation: null,
      groom_proposal: null,
      advisory: null,
      disposition_reason: null,
      answer: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      ...overrides,
    };
    insertStagedIntent(row);
    return row;
  }

  beforeEach(() => {
    db.prepare('DELETE FROM staged_intent').run();
    db.prepare('DELETE FROM staged_intent_group').run();
    db.prepare('DELETE FROM sessions').run();
  });

  it('excludes an intent whose owning session turn is still in flight', () => {
    seedSession('sess-1');
    stageRow({ id: 'intent-1', session_id: 'sess-1' });
    const sessionManager = makeSessionManager(true);

    const result = computeMilestoneAttentionSignals(
      PROJECT_ID,
      MILESTONE,
      sessionManager,
    );
    expect(result.pendingCount).toBe(0);
  });

  it('includes the intent once the owning session turn ends', () => {
    seedSession('sess-1');
    stageRow({ id: 'intent-1', session_id: 'sess-1' });
    const sessionManager = makeSessionManager(false);

    const result = computeMilestoneAttentionSignals(
      PROJECT_ID,
      MILESTONE,
      sessionManager,
    );
    expect(result.pendingCount).toBe(1);
  });

  it('always includes human-staged intents (no owning session)', () => {
    stageRow({ id: 'intent-1', session_id: null });
    const sessionManager = makeSessionManager(true);

    const result = computeMilestoneAttentionSignals(
      PROJECT_ID,
      MILESTONE,
      sessionManager,
    );
    expect(result.pendingCount).toBe(1);
  });

  it('derives tier-2 aging signals from the same filtered population as the count', () => {
    seedSession('sess-1');
    stageRow({
      id: 'intent-aging',
      session_id: 'sess-1',
      created_at: Date.now() - 999 * HOUR,
    });
    const sessionManager = makeSessionManager(true);

    const result = computeMilestoneAttentionSignals(
      PROJECT_ID,
      MILESTONE,
      sessionManager,
    );
    expect(result.pendingCount).toBe(0);
    expect(result.tier2.filter((s) => s.type === 'aging')).toHaveLength(0);
  });

  it('excludes a session-less gate.verify mirror intent from the aging signal even when well past the threshold', () => {
    stageRow({
      id: 'gate-verify-1',
      kind: 'gate.verify',
      session_id: null,
      payload: JSON.stringify({ gateItemId: 'gate-item-1' }),
      created_at: Date.now() - 999 * HOUR,
    });
    const sessionManager = makeSessionManager(false);

    const result = computeMilestoneAttentionSignals(
      PROJECT_ID,
      MILESTONE,
      sessionManager,
    );
    expect(result.pendingCount).toBe(1);
    expect(result.tier2.filter((s) => s.type === 'aging')).toHaveLength(0);
  });

  it('cannot drift from the decision-inbox visibility rule: pendingCount equals the count of rows the shared predicate marks actionable', () => {
    seedSession('sess-in-flight');
    seedSession('sess-complete');
    stageRow({ id: 'intent-in-flight', session_id: 'sess-in-flight' });
    stageRow({ id: 'intent-complete', session_id: 'sess-complete' });
    stageRow({ id: 'intent-human', session_id: null });

    const sessionManager = {
      getLiveSession: vi.fn((sessionId: string) => ({
        hasActiveTurn: () => sessionId === 'sess-in-flight',
      })),
    } as never;

    const rows = [
      { session_id: 'sess-in-flight' },
      { session_id: 'sess-complete' },
      { session_id: null },
    ];
    // The exact rule the milestone decision inbox's rowToApi `sessionComplete`
    // field is interpreted through on the frontend (sessionComplete === true
    // || sessionComplete === null) — reconstructed here from the same
    // resolveSessionCompleteForDisplay the badge and rowToApi both call, so
    // this test would fail the moment either surface's derivation diverges.
    const inboxVisibleCount = rows.filter((row) =>
      row.session_id === null
        ? true
        : resolveSessionCompleteForDisplay(row.session_id, sessionManager),
    ).length;
    expect(
      rows.filter((row) => isMilestoneActionable(row, sessionManager)).length,
    ).toBe(inboxVisibleCount);

    const result = computeMilestoneAttentionSignals(
      PROJECT_ID,
      MILESTONE,
      sessionManager,
    );
    expect(result.pendingCount).toBe(inboxVisibleCount);
  });
});
