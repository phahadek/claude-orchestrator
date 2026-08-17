/**
 * test_request_cycle_exceeded is sticky on the sessions row (setSessionPauseReason
 * writes it directly, with no matching clear path) — a session that reaches a
 * terminal state must not stay counted as paused. updateSessionStatus and the
 * markSessionDone/applyPendingDone 'done' path are the two ways a session
 * reaches a terminal status; both must clear this specific pause_reason.
 */

import { describe, it, expect, beforeEach } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { vi } from 'vitest';
import { db } from '../db.js';
import {
  insertSession,
  setSessionPauseReason,
  updateSessionStatus,
  markSessionDone,
} from '../queries.js';

beforeEach(() => {
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
  });
}

function getPauseReason(sessionId: string): string | null {
  const row = db
    .prepare('SELECT pause_reason FROM sessions WHERE session_id = ?')
    .get(sessionId) as { pause_reason: string | null };
  return row.pause_reason;
}

describe('test_request_cycle_exceeded pause reason clears on terminal transition', () => {
  it('is cleared by updateSessionStatus reaching a terminal status', () => {
    seedSession('sess-error');
    setSessionPauseReason('sess-error', 'test_request_cycle_exceeded');

    updateSessionStatus('sess-error', 'error');

    expect(getPauseReason('sess-error')).toBeNull();
  });

  it('is cleared by markSessionDone', () => {
    seedSession('sess-done');
    setSessionPauseReason('sess-done', 'test_request_cycle_exceeded');

    markSessionDone('sess-done', Date.now(), null, 'test', {
      skipInFlightGuard: true,
    });

    expect(getPauseReason('sess-done')).toBeNull();
  });

  it('leaves an unrelated pause_reason untouched on terminal transition', () => {
    seedSession('sess-other-pause');
    setSessionPauseReason('sess-other-pause', 'stalled_idle');

    updateSessionStatus('sess-other-pause', 'killed');

    expect(getPauseReason('sess-other-pause')).toBe('stalled_idle');
  });

  it('does not clear the pause reason on a non-terminal status update', () => {
    seedSession('sess-running');
    setSessionPauseReason('sess-running', 'test_request_cycle_exceeded');

    updateSessionStatus('sess-running', 'running');

    expect(getPauseReason('sess-running')).toBe('test_request_cycle_exceeded');
  });
});
