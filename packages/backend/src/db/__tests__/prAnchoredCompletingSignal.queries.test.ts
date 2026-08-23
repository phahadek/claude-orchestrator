/**
 * Dual-write bridge tests for recordPrAnchoredCompletingSignal — the
 * PR-anchored session-type migration task's per-call-site mirror into
 * completing_signal_ledger under the 'external_pr_event' class, wired
 * alongside the legacy markSessionDone/updateSessionStatus writes in
 * PRMergeWatcher/AutoMerger/bootIdleReconciliation. Purely additive: these
 * tests assert the ledger row lands with the right signal_value for the
 * session types the completing-signal registry maps (standard, review) and
 * is a no-op for every other session type.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  recordPrAnchoredCompletingSignal,
  listCompletingSignalsForSession,
} from '../queries.js';

function insertSession(opts: {
  session_id: string;
  session_type: string;
  task_id?: string | null;
}) {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, status, started_at, session_type)
     VALUES (@session_id, @task_id, 'idle', 0, @session_type)`,
  ).run({
    session_id: opts.session_id,
    task_id: opts.task_id ?? `task-${opts.session_id}`,
    session_type: opts.session_type,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM completing_signal_ledger').run();
});

describe('recordPrAnchoredCompletingSignal', () => {
  it('records an external_pr_event pr_merged signal for a standard (code) session', () => {
    insertSession({ session_id: 's1', session_type: 'standard' });

    recordPrAnchoredCompletingSignal('s1', 'pr_merged', 1000);

    const signals = listCompletingSignalsForSession('s1');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      session_id: 's1',
      task_id: 'task-s1',
      session_type: 'standard',
      signal_class: 'external_pr_event',
      signal_value: 'pr_merged',
      recorded_at: 1000,
    });
  });

  it('records an external_pr_event pr_closed_without_merge signal for a review session', () => {
    insertSession({ session_id: 's2', session_type: 'review' });

    recordPrAnchoredCompletingSignal('s2', 'pr_closed_without_merge', 2000);

    const signals = listCompletingSignalsForSession('s2');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      session_type: 'review',
      signal_class: 'external_pr_event',
      signal_value: 'pr_closed_without_merge',
    });
  });

  it('is a no-op for depth_review — no PR is ever linked to one', () => {
    insertSession({ session_id: 's3', session_type: 'depth_review' });

    recordPrAnchoredCompletingSignal('s3', 'pr_merged', 3000);

    expect(listCompletingSignalsForSession('s3')).toHaveLength(0);
  });

  it('is a no-op for session types outside this migration slice (docs/ops)', () => {
    insertSession({ session_id: 's4', session_type: 'docs' });
    insertSession({ session_id: 's5', session_type: 'ops' });

    recordPrAnchoredCompletingSignal('s4', 'pr_merged', 4000);
    recordPrAnchoredCompletingSignal('s5', 'pr_merged', 4000);

    expect(listCompletingSignalsForSession('s4')).toHaveLength(0);
    expect(listCompletingSignalsForSession('s5')).toHaveLength(0);
  });

  it('is a no-op for an unknown session id', () => {
    expect(() =>
      recordPrAnchoredCompletingSignal('does-not-exist', 'pr_merged', 5000),
    ).not.toThrow();
    expect(listCompletingSignalsForSession('does-not-exist')).toHaveLength(0);
  });
});
