/**
 * Tests for the Milestone view's two-tier attention detection
 * (packages/backend/src/convergence/attentionSignals.ts).
 *
 * AC: aging past threshold, flat convergence over the window, and a
 * blocked/stalled task each produce a tier-2 signal; each signal's `key`
 * is stable for the same underlying condition (the frontend dedups on it).
 */

import { describe, it, expect } from 'vitest';
import {
  detectAgingSignals,
  detectBlockedSignals,
  detectFlatSignal,
} from '../attentionSignals';
import type { ConvergenceSnapshotRow } from '../../db/types';
import type { PauseReasonStruct } from '../../db/pauseReason';

const HOUR = 3_600_000;

describe('detectAgingSignals', () => {
  it('fires for a decision older than the threshold', () => {
    const now = 1_000_000;
    const pending = [{ id: 'intent-1', created_at: now - 25 * HOUR }];
    const signals = detectAgingSignals(pending, now, 24 * HOUR);
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('aging:intent-1');
    expect(signals[0].type).toBe('aging');
  });

  it('does not fire for a decision within the threshold', () => {
    const now = 1_000_000;
    const pending = [{ id: 'intent-1', created_at: now - 1 * HOUR }];
    expect(detectAgingSignals(pending, now, 24 * HOUR)).toHaveLength(0);
  });

  it('produces a stable key for the same intent across repeated calls', () => {
    const now = 1_000_000;
    const pending = [{ id: 'intent-1', created_at: now - 25 * HOUR }];
    const first = detectAgingSignals(pending, now, 24 * HOUR);
    const second = detectAgingSignals(pending, now + HOUR, 24 * HOUR);
    expect(first[0].key).toBe(second[0].key);
  });
});

describe('detectBlockedSignals', () => {
  function pause(overrides: Partial<PauseReasonStruct> = {}): PauseReasonStruct {
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
    expect(signals[0].key).toBe(
      'blocked:task-1:planning_terminal_no_decision',
    );
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
      snapshot({ ts: new Date(0).toISOString(), distance_to_green: 0, status: 'green' }),
    ];
    expect(
      detectFlatSignal(history, now, 24 * HOUR, 'proj-1:M12'),
    ).toHaveLength(0);
  });

  it('does not fire when there is not yet enough retained history', () => {
    const now = 100 * HOUR;
    const history = [
      snapshot({ ts: new Date(now - 1 * HOUR).toISOString(), distance_to_green: 3 }),
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
      [...history, snapshot({ ts: new Date(now).toISOString(), distance_to_green: 3 })],
      now + HOUR,
      24 * HOUR,
      'proj-1:M12',
    );
    expect(first[0].key).toBe(second[0].key);
  });
});
