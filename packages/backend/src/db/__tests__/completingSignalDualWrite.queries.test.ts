/**
 * Dual-write bridge tests for the shared session-status write primitives
 * (markSessionDone, markSessionIdle, updateSessionStatus, markSessionSuperseded,
 * applyPendingDone) and the type-agnostic archive sweeps
 * (archiveSession/archiveFinishedSessions/archiveConcludedSessionsOlderThan).
 *
 * Each primitive now mirrors its legacy sessions.status/archived write into
 * completing_signal_ledger under the 'legacy_status_write' class — additive
 * instrumentation only, landed ahead of any read-side cutover onto
 * session/sessionStatusDeriver.ts. These tests assert:
 *  (a) the mirrored ledger row lands whenever (and only whenever) the legacy
 *      write actually lands, and
 *  (b) the three race-safety guards (markSessionDone's in-flight-running
 *      guard + pending_done_* deferral, markSessionIdle's terminal-status
 *      guard, updateSessionStatus's reopen-terminal guard) still behave
 *      exactly as before — this instrumentation must never change what gets
 *      written to sessions.status, only add a parallel ledger row.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../db.js';
import {
  markSessionDone,
  markSessionIdle,
  markSessionSuperseded,
  updateSessionStatus,
  applyPendingDone,
  getSessionsWithUnappliedPendingDone,
  archiveSession,
  archiveFinishedSessions,
  archiveConcludedSessionsOlderThan,
  listCompletingSignalsForSession,
} from '../queries.js';

function insertSession(opts: {
  session_id: string;
  status: string;
  ended_at?: number | null;
  session_type?: string;
  task_id?: string | null;
  archived?: number;
}) {
  db.prepare(
    `INSERT INTO sessions (session_id, task_id, status, started_at, ended_at, session_type, archived)
     VALUES (@session_id, @task_id, @status, 0, @ended_at, @session_type, @archived)`,
  ).run({
    session_id: opts.session_id,
    task_id: opts.task_id ?? `task-${opts.session_id}`,
    status: opts.status,
    ended_at: opts.ended_at ?? null,
    session_type: opts.session_type ?? 'standard',
    archived: opts.archived ?? 0,
  });
}

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM completing_signal_ledger').run();
});

describe('updateSessionStatus dual-write', () => {
  it('mirrors a real transition into completing_signal_ledger', () => {
    insertSession({ session_id: 's1', status: 'running' });

    updateSessionStatus('s1', 'killed', 1000);

    const signals = listCompletingSignalsForSession('s1');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      session_id: 's1',
      task_id: 'task-s1',
      session_type: 'standard',
      signal_class: 'legacy_status_write',
      signal_value: 'killed',
      recorded_at: 1000,
    });
  });

  it('does not write a ledger row when the status does not actually change (mirrors the session_status_changed no-op guard)', () => {
    insertSession({ session_id: 's2', status: 'running' });

    updateSessionStatus('s2', 'running', 1000);

    expect(listCompletingSignalsForSession('s2')).toHaveLength(0);
  });

  it('reopen-terminal guard: an explicit reopen of a terminal row (respawnSession/sendOrResume\'s allowReopenTerminal path) still flips status and now also records the reopen in the ledger', () => {
    insertSession({ session_id: 's3', status: 'done' });

    // Mirrors respawnSession/sendOrResume's explicit, audited reopen path —
    // the guard itself lives in SessionManager (unchanged by this task); this
    // exercises the same call updateSessionStatus receives once that guard
    // has decided to allow the reopen.
    updateSessionStatus('s3', 'running');

    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('s3') as { status: string };
    expect(row.status).toBe('running');

    const signals = listCompletingSignalsForSession('s3');
    expect(signals).toHaveLength(1);
    expect(signals[0].signal_value).toBe('running');
  });
});

describe('markSessionDone dual-write', () => {
  it('mirrors an immediate done-write into the ledger', () => {
    insertSession({ session_id: 'd1', status: 'idle' });

    markSessionDone('d1', 2000, 'https://example.com/pr/1', 'test-call-site');

    const signals = listCompletingSignalsForSession('d1');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signal_class: 'legacy_status_write',
      signal_value: 'done',
      recorded_at: 2000,
    });
  });

  it('in-flight-running guard: defers the done-write onto pending_done_* and does NOT write the ledger until the deferred transition is actually applied', () => {
    insertSession({ session_id: 'd2', status: 'running' });

    markSessionDone('d2', 2000, null, 'test-call-site');

    // Status untouched, and no ledger row yet — nothing was actually written.
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('d2') as { status: string };
    expect(row.status).toBe('running');
    expect(listCompletingSignalsForSession('d2')).toHaveLength(0);
    expect(
      getSessionsWithUnappliedPendingDone().some((s) => s.session_id === 'd2'),
    ).toBe(false); // still 'running' — only surfaced once non-running

    // Simulate the turn-boundary drain (a settle handler flipping the row to
    // idle before applyPendingDone runs, as SessionManager's real drain does).
    db.prepare(`UPDATE sessions SET status = 'idle' WHERE session_id = ?`).run(
      'd2',
    );
    const applied = applyPendingDone('d2');
    expect(applied).toBe(true);

    const afterRow = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('d2') as { status: string };
    expect(afterRow.status).toBe('done');

    const signals = listCompletingSignalsForSession('d2');
    expect(signals).toHaveLength(1);
    expect(signals[0].signal_value).toBe('done');
  });

  it('skipInFlightGuard bypasses the deferral and writes the ledger immediately', () => {
    insertSession({ session_id: 'd3', status: 'running' });

    markSessionDone('d3', 3000, null, 'boot-orphan-recovery', {
      skipInFlightGuard: true,
    });

    const signals = listCompletingSignalsForSession('d3');
    expect(signals).toHaveLength(1);
    expect(signals[0].signal_value).toBe('done');
  });
});

describe('markSessionIdle dual-write', () => {
  it('mirrors a clean-exit idle write into the ledger', () => {
    insertSession({ session_id: 'i1', status: 'running' });

    const result = markSessionIdle('i1', 4000, null);

    expect(result).toBe('idle');
    const signals = listCompletingSignalsForSession('i1');
    expect(signals).toHaveLength(1);
    expect(signals[0].signal_value).toBe('idle');
  });

  it('terminal-status guard: a clean-exit write against an already-terminal row is skipped, and no ledger row is written', () => {
    insertSession({ session_id: 'i2', status: 'done' });

    const result = markSessionIdle('i2', 4000, null);

    expect(result).toBe('done');
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('i2') as { status: string };
    expect(row.status).toBe('done');
    expect(listCompletingSignalsForSession('i2')).toHaveLength(0);
  });
});

describe('markSessionSuperseded dual-write', () => {
  it('mirrors a supersede write into the ledger', () => {
    insertSession({ session_id: 'sup1', status: 'running' });

    markSessionSuperseded('sup1', 5000);

    const signals = listCompletingSignalsForSession('sup1');
    expect(signals).toHaveLength(1);
    expect(signals[0].signal_value).toBe('superseded');
  });
});

describe('archive sweep dual-write (routes/sessions.ts operator archive + ConcludedSessionArchiver bulk sweep)', () => {
  it('archiveSession (operator-initiated, routes/sessions.ts PATCH /:id/archive) records a ledger row', () => {
    insertSession({ session_id: 'arch1', status: 'done' });

    archiveSession('arch1');

    const signals = listCompletingSignalsForSession('arch1');
    expect(signals).toHaveLength(1);
    expect(signals[0].signal_value).toBe('archived');
  });

  it('archiveSession is a no-op (no ledger row) when the session is already archived', () => {
    insertSession({ session_id: 'arch2', status: 'done', archived: 1 });

    archiveSession('arch2');

    expect(listCompletingSignalsForSession('arch2')).toHaveLength(0);
  });

  it('archiveFinishedSessions (bulk route) records a ledger row per archived session', () => {
    insertSession({ session_id: 'fin1', status: 'done' });
    insertSession({ session_id: 'fin2', status: 'running' });

    const count = archiveFinishedSessions();

    expect(count).toBe(1);
    expect(listCompletingSignalsForSession('fin1')).toHaveLength(1);
    expect(listCompletingSignalsForSession('fin2')).toHaveLength(0);
  });

  it('archiveConcludedSessionsOlderThan (ConcludedSessionArchiver sweep) records a ledger row per archived session', () => {
    insertSession({ session_id: 'sweep1', status: 'done', ended_at: 100 });

    const ids = archiveConcludedSessionsOlderThan(1000);

    expect(ids).toEqual(['sweep1']);
    const signals = listCompletingSignalsForSession('sweep1');
    expect(signals).toHaveLength(1);
    expect(signals[0].signal_value).toBe('archived');
  });
});
