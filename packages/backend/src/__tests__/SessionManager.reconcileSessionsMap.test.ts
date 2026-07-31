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

function setSessionEntry(sm: SessionManager, sessionId: string): void {
  (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
    sessionId,
    { sendMessage: vi.fn() },
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
    expect(revokeStageCredential).toHaveBeenCalledWith(sessionId);
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
      expect(revokeStageCredential).toHaveBeenCalledWith(sessionId);
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
  });
});
