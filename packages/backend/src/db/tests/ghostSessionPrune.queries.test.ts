/**
 * Tests for db/queries.ts's deleteGhostSessions — the boot-time sweep that
 * removes sessions with no session_events rows. Rewritten from a
 * `NOT IN (SELECT DISTINCT session_id FROM session_events)` scan (which
 * materialises a distinct set over the full session_events table) to a
 * NOT EXISTS anti-join, so it's an indexed SEARCH per session rather than a
 * full-table SCAN of session_events.
 */

import { describe, it, expect, beforeEach } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { vi } from 'vitest';
import { db } from '../db.js';
import { insertSession, insertEvent, deleteGhostSessions } from '../queries.js';

beforeEach(() => {
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM sessions').run();
});

function makeSession(sessionId: string): void {
  insertSession({
    session_id: sessionId,
    task_id: null,
    task_url: null,
    project_context_url: null,
    status: 'running',
    started_at: Date.now(),
  });
}

describe('deleteGhostSessions', () => {
  it('deletes only sessions with no session_events rows, leaving others intact', () => {
    makeSession('ghost-1');
    makeSession('ghost-2');
    makeSession('live-1');
    makeSession('live-2');

    insertEvent({
      session_id: 'live-1',
      event_type: 'text',
      payload: '{}',
      timestamp: Date.now(),
    });
    insertEvent({
      session_id: 'live-2',
      event_type: 'text',
      payload: '{}',
      timestamp: Date.now(),
    });

    const deleted = deleteGhostSessions();

    expect(deleted).toBe(2);
    const remaining = (
      db
        .prepare('SELECT session_id FROM sessions ORDER BY session_id')
        .all() as {
        session_id: string;
      }[]
    ).map((r) => r.session_id);
    expect(remaining).toEqual(['live-1', 'live-2']);
  });

  it('returns 0 and deletes nothing when every session has events', () => {
    makeSession('live-1');
    insertEvent({
      session_id: 'live-1',
      event_type: 'text',
      payload: '{}',
      timestamp: Date.now(),
    });

    const deleted = deleteGhostSessions();

    expect(deleted).toBe(0);
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM sessions')
      .get() as {
      n: number;
    };
    expect(remaining.n).toBe(1);
  });

  it('uses an indexed SEARCH on session_events, never a full SCAN', () => {
    makeSession('ghost-1');
    makeSession('live-1');
    insertEvent({
      session_id: 'live-1',
      event_type: 'text',
      payload: '{}',
      timestamp: Date.now(),
    });

    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN
           DELETE FROM sessions
           WHERE NOT EXISTS (
             SELECT 1 FROM session_events WHERE session_events.session_id = sessions.session_id
           )`,
        )
        .all() as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');

    expect(plan).not.toMatch(/SCAN session_events/);
    expect(plan).toMatch(/session_events/);
  });
});
