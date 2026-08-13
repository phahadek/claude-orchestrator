/**
 * completing_signal_ledger's own query functions, exercised against a real
 * (in-memory) database — the deriver's own tests use synthetic row objects
 * directly and never touch this table, per this task's scope (no real
 * writer inserts into it yet). This test covers the query layer itself:
 * insertCompletingSignal writes a row that listCompletingSignalsForSession
 * reads back, ordered oldest first.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import {
  insertCompletingSignal,
  listCompletingSignalsForSession,
} from '../queries.js';
import type { CompletingSignalClass } from '../types.js';

describe('completing_signal_ledger queries', () => {
  it('round-trips a row through insertCompletingSignal and listCompletingSignalsForSession', () => {
    const signalClass: CompletingSignalClass = 'staged_intent';
    insertCompletingSignal({
      session_id: 'session-1',
      task_id: 'task-1',
      session_type: 'design',
      signal_class: signalClass,
      signal_value: 'planning_approved',
      recorded_at: 1000,
    });

    const rows = listCompletingSignalsForSession('session-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: 'session-1',
      task_id: 'task-1',
      session_type: 'design',
      signal_class: 'staged_intent',
      signal_value: 'planning_approved',
      recorded_at: 1000,
    });
  });

  it('orders multiple rows for a session oldest-first', () => {
    insertCompletingSignal({
      session_id: 'session-2',
      task_id: null,
      session_type: 'standard',
      signal_class: 'external_pr_event',
      signal_value: 'pr_merged',
      recorded_at: 2000,
    });
    insertCompletingSignal({
      session_id: 'session-2',
      task_id: null,
      session_type: 'standard',
      signal_class: 'external_pr_event',
      signal_value: 'pr_closed_without_merge',
      recorded_at: 1000,
    });

    const rows = listCompletingSignalsForSession('session-2');
    expect(rows.map((r) => r.signal_value)).toEqual([
      'pr_closed_without_merge',
      'pr_merged',
    ]);
  });

  it('scopes results to the requested session_id', () => {
    insertCompletingSignal({
      session_id: 'session-3',
      task_id: null,
      session_type: 'groom',
      signal_class: 'staged_intent',
      signal_value: 'planning_no_pending_dispositions',
      recorded_at: 500,
    });

    expect(listCompletingSignalsForSession('session-3')).toHaveLength(1);
    expect(listCompletingSignalsForSession('session-does-not-exist')).toEqual(
      [],
    );
  });
});
