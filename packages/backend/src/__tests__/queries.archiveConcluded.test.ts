import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db/db.js';
import { archiveConcludedSessionsOlderThan } from '../db/queries.js';

function insertSession(opts: {
  session_id: string;
  status: string;
  ended_at: number | null;
  archived?: number;
}) {
  db.prepare(
    `INSERT INTO sessions (session_id, status, started_at, ended_at, archived)
     VALUES (@session_id, @status, 0, @ended_at, @archived)`,
  ).run({
    session_id: opts.session_id,
    status: opts.status,
    ended_at: opts.ended_at,
    archived: opts.archived ?? 0,
  });
}

const CUTOFF = 1_000_000;

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
});

describe('archiveConcludedSessionsOlderThan', () => {
  it('archives concluded sessions older than cutoff', () => {
    insertSession({
      session_id: 'old-done',
      status: 'done',
      ended_at: CUTOFF - 1,
    });
    insertSession({
      session_id: 'old-error',
      status: 'error',
      ended_at: CUTOFF - 1,
    });
    insertSession({
      session_id: 'old-killed',
      status: 'killed',
      ended_at: CUTOFF - 1,
    });

    const ids = archiveConcludedSessionsOlderThan(CUTOFF);
    expect(ids.sort()).toEqual(['old-done', 'old-error', 'old-killed'].sort());

    const rows = db
      .prepare(`SELECT session_id, archived FROM sessions`)
      .all() as { session_id: string; archived: number }[];
    for (const r of rows) {
      expect(r.archived).toBe(1);
    }
  });

  it('does not archive sessions within the grace period (ended_at >= cutoff)', () => {
    insertSession({ session_id: 'fresh', status: 'done', ended_at: CUTOFF });
    insertSession({
      session_id: 'newer',
      status: 'done',
      ended_at: CUTOFF + 1000,
    });

    const ids = archiveConcludedSessionsOlderThan(CUTOFF);
    expect(ids).toHaveLength(0);

    const rows = db.prepare(`SELECT archived FROM sessions`).all() as {
      archived: number;
    }[];
    for (const r of rows) {
      expect(r.archived).toBe(0);
    }
  });

  it('does not touch already-archived sessions', () => {
    insertSession({
      session_id: 'already-archived',
      status: 'done',
      ended_at: CUTOFF - 1,
      archived: 1,
    });

    const ids = archiveConcludedSessionsOlderThan(CUTOFF);
    expect(ids).toHaveLength(0);
  });

  it('archives idle sessions older than cutoff (archival is orthogonal to lifecycle)', () => {
    insertSession({
      session_id: 'old-idle',
      status: 'idle',
      ended_at: CUTOFF - 1,
    });

    const ids = archiveConcludedSessionsOlderThan(CUTOFF);
    expect(ids).toEqual(['old-idle']);

    const row = db
      .prepare(`SELECT archived FROM sessions WHERE session_id = 'old-idle'`)
      .get() as { archived: number };
    expect(row.archived).toBe(1);
  });

  it('does not archive idle sessions within the grace period', () => {
    insertSession({
      session_id: 'fresh-idle',
      status: 'idle',
      ended_at: CUTOFF,
    });

    const ids = archiveConcludedSessionsOlderThan(CUTOFF);
    expect(ids).toHaveLength(0);

    const row = db
      .prepare(`SELECT archived FROM sessions WHERE session_id = 'fresh-idle'`)
      .get() as { archived: number };
    expect(row.archived).toBe(0);
  });

  it('does not touch active (running) sessions', () => {
    insertSession({ session_id: 'running', status: 'running', ended_at: null });

    const ids = archiveConcludedSessionsOlderThan(CUTOFF);
    expect(ids).toHaveLength(0);

    const row = db
      .prepare(`SELECT archived FROM sessions WHERE session_id = 'running'`)
      .get() as { archived: number };
    expect(row.archived).toBe(0);
  });

  it('does not archive sessions with null ended_at', () => {
    insertSession({ session_id: 'no-end', status: 'done', ended_at: null });

    const ids = archiveConcludedSessionsOlderThan(CUTOFF);
    expect(ids).toHaveLength(0);
  });

  it('returns empty array when nothing qualifies', () => {
    const ids = archiveConcludedSessionsOlderThan(CUTOFF);
    expect(ids).toEqual([]);
  });

  it('integration: 10 sessions, 5 within grace, 5 older', () => {
    for (let i = 0; i < 5; i++) {
      insertSession({
        session_id: `within-${i}`,
        status: 'done',
        ended_at: CUTOFF + i,
      });
    }
    for (let i = 0; i < 5; i++) {
      insertSession({
        session_id: `older-${i}`,
        status: 'done',
        ended_at: CUTOFF - i - 1,
      });
    }

    const ids = archiveConcludedSessionsOlderThan(CUTOFF);
    expect(ids).toHaveLength(5);
    for (const id of ids) {
      expect(id).toMatch(/^older-/);
    }
  });
});
