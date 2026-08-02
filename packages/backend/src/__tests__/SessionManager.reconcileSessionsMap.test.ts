/**
 * Tests for SessionManager.reconcileSessionsMap() — the periodic
 * defense-in-depth sweep that drops stale in-memory `this.sessions` entries
 * whose backing DB row is terminal or missing, mirroring
 * WorktreeReconciler's periodic-Scheduler-job pattern applied to the
 * in-memory map instead of the filesystem.
 *
 * Verifies:
 * - a missing-DB-row entry is dropped and its stage credential revoked.
 * - a terminal-status (error/killed/done) entry is dropped and revoked.
 * - a non-terminal (live) entry is never touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDbQueries } from './helpers/mockDbQueries';

vi.mock('../db/queries', () =>
  mockDbQueries({
    getSession: vi.fn().mockReturnValue(null),
  }),
);

vi.mock('../auth/SessionStageAuth', () => ({
  revokeStageCredential: vi.fn(),
}));

import { SessionManager } from '../session/SessionManager';
import * as queries from '../db/queries';
import { revokeStageCredential } from '../auth/SessionStageAuth';
import { db } from '../db/db';

function auditRowsFor(sessionId: string): Array<{
  ts: number;
  event_type: string;
  payload: string;
}> {
  return db
    .prepare(
      `SELECT ts, event_type, payload FROM audit_log WHERE actor_id = ? AND event_type = 'session_map_entry_dropped'`,
    )
    .all(sessionId) as Array<{
    ts: number;
    event_type: string;
    payload: string;
  }>;
}

function setSessionEntry(sm: SessionManager, sessionId: string): void {
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
    sessionId,
    { sendMessage: vi.fn(), endSession: vi.fn().mockResolvedValue(undefined) },
  );
}

function hasSessionEntry(sm: SessionManager, sessionId: string): boolean {
  return (sm as unknown as { sessions: Map<string, unknown> }).sessions.has(
    sessionId,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reconcileSessionsMap()', () => {
  it('drops an entry whose DB row is missing and revokes its stage credential', () => {
    const sessionId = 'missing-row-session';
    vi.mocked(queries.getSession).mockReturnValue(null as never);

    const sm = new SessionManager();
    setSessionEntry(sm, sessionId);

    const result = sm.reconcileSessionsMap();

    expect(result.dropped).toBe(1);
    expect(hasSessionEntry(sm, sessionId)).toBe(false);
    expect(revokeStageCredential).toHaveBeenCalledWith(
      sessionId,
      'missing_db_row',
    );

    const rows = auditRowsFor(sessionId);
    expect(rows).toHaveLength(1);
    expect(Number.isInteger(rows[0].ts)).toBe(true);
    const payload = JSON.parse(rows[0].payload);
    expect(payload).toEqual({
      session_id: sessionId,
      status: null,
      revocation_reason: 'missing_db_row',
    });
  });

  it.each(['error', 'killed', 'done'])(
    'drops an entry whose DB row is terminal (%s) and revokes its stage credential',
    (status) => {
      const sessionId = `terminal-${status}-session`;
      vi.mocked(queries.getSession).mockReturnValue({
        session_id: sessionId,
        status,
      } as never);

      const sm = new SessionManager();
      setSessionEntry(sm, sessionId);

      const result = sm.reconcileSessionsMap();

      expect(result.dropped).toBe(1);
      expect(hasSessionEntry(sm, sessionId)).toBe(false);
      expect(revokeStageCredential).toHaveBeenCalledWith(
        sessionId,
        `terminal_status:${status}`,
      );

      const rows = auditRowsFor(sessionId);
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0].payload);
      expect(payload).toEqual({
        session_id: sessionId,
        status,
        revocation_reason: `terminal_status:${status}`,
      });
    },
  );

  it('never touches an entry whose DB row is non-terminal (genuinely live)', () => {
    const sessionId = 'live-session';
    vi.mocked(queries.getSession).mockReturnValue({
      session_id: sessionId,
      status: 'running',
    } as never);

    const sm = new SessionManager();
    setSessionEntry(sm, sessionId);

    const result = sm.reconcileSessionsMap();

    expect(result.dropped).toBe(0);
    expect(hasSessionEntry(sm, sessionId)).toBe(true);
    expect(revokeStageCredential).not.toHaveBeenCalled();
    expect(auditRowsFor(sessionId)).toHaveLength(0);
  });
});
