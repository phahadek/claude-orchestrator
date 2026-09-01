/**
 * Tests for getSessionLastActivityMs and its bulk counterpart
 * getLastActivityMsForArchivedSessions: the covering index on
 * session_events(session_id, timestamp) must resolve MAX(timestamp) WHERE
 * session_id = ? without a per-row table search, and MAX(timestamp) must
 * keep returning the true maximum timestamp (not the last-inserted row's
 * timestamp) even when events are inserted out of timestamp order.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  insertSession,
  insertEvent,
  getSessionLastActivityMs,
  getLastActivityMsForArchivedSessions,
  archiveSession,
} from '../queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM sessions').run();
});

function seedSession(sessionId: string): void {
  insertSession({
    session_id: sessionId,
    task_id: `task:${sessionId}`,
    task_url: null,
    project_context_url: null,
    status: 'running',
    started_at: 0,
    session_type: 'standard',
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

function seedEvent(sessionId: string, timestamp: number): void {
  insertEvent({
    session_id: sessionId,
    event_type: 'user',
    payload: '{}',
    timestamp,
  } as never);
}

describe('getSessionLastActivityMs', () => {
  it('resolves via the session_id+timestamp covering index with no table search', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT MAX(timestamp) AS ts FROM session_events WHERE session_id = ?`,
      )
      .all('sess-1') as { detail: string }[];
    const detail = plan.map((row) => row.detail).join(' | ');
    // A COVERING INDEX plan means the index alone satisfies the query — no
    // separate per-row seek back into the session_events table.
    expect(detail).toContain('COVERING INDEX');
    expect(detail).toContain('idx_session_events_session_id_timestamp');
    expect(detail).not.toContain('SCAN');
  });

  it('returns null for a session with zero events', () => {
    seedSession('sess-none');
    expect(getSessionLastActivityMs('sess-none')).toBeNull();
  });

  it('returns the timestamp for a session with exactly one event', () => {
    seedSession('sess-one');
    seedEvent('sess-one', 1000);
    expect(getSessionLastActivityMs('sess-one')).toBe(1000);
  });

  it('returns the maximum timestamp across many events', () => {
    seedSession('sess-many');
    seedEvent('sess-many', 1000);
    seedEvent('sess-many', 3000);
    seedEvent('sess-many', 2000);
    expect(getSessionLastActivityMs('sess-many')).toBe(3000);
  });

  it('returns the true max timestamp, not the last-inserted row, when events are inserted out of timestamp order', () => {
    seedSession('sess-out-of-order');
    seedEvent('sess-out-of-order', 5000);
    seedEvent('sess-out-of-order', 1000);
    // Last-inserted row has the smallest timestamp — MAX(timestamp) must
    // still report 5000, distinguishing it from an ORDER BY id DESC LIMIT 1
    // proxy that would (wrongly) return 1000 here.
    expect(getSessionLastActivityMs('sess-out-of-order')).toBe(5000);
  });
});

describe('getLastActivityMsForArchivedSessions', () => {
  it('returns the max timestamp per archived session in a single aggregate query, regardless of session count', () => {
    for (let i = 0; i < 25; i++) {
      const sessionId = `sess-${i}`;
      seedSession(sessionId);
      seedEvent(sessionId, 1000 + i);
      seedEvent(sessionId, 2000 + i);
      archiveSession(sessionId, 'operator');
    }

    // Warm the lazily-cached statement, then assert the next call prepares
    // no new statement — the query is a single aggregate over all archived
    // sessions, not one query per row.
    getLastActivityMsForArchivedSessions();
    const spy = vi.spyOn(db, 'prepare');
    const map = getLastActivityMsForArchivedSessions();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    expect(map.size).toBe(25);
    for (let i = 0; i < 25; i++) {
      expect(map.get(`sess-${i}`)).toBe(2000 + i);
    }
  });

  it('only includes archived sessions', () => {
    seedSession('sess-active');
    seedEvent('sess-active', 1000);
    seedSession('sess-archived');
    seedEvent('sess-archived', 2000);
    archiveSession('sess-archived', 'operator');

    const map = getLastActivityMsForArchivedSessions();
    expect(map.has('sess-active')).toBe(false);
    expect(map.get('sess-archived')).toBe(2000);
  });
});
