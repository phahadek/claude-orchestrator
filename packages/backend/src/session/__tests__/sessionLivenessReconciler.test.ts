/**
 * Tests for reconcileSessionLiveness (session/sessionLivenessReconciler.ts).
 *
 * Reconciles a non-terminal planning session row (running or idle) whose OS
 * subprocess does not exist to a terminal status — the DB → OS mirror of
 * SessionManager.reconcileSessionsMap (memory → DB). Uses a real in-memory
 * DB throughout (via setupTestDb) so countLivePlanningSessions' predicate is
 * exercised for real, not re-implemented in a mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { db } from '../../db/db.js';
import { recordEvent } from '../../audit/AuditLog';
import {
  insertSession,
  countLivePlanningSessions,
  insertEvent,
} from '../../db/queries.js';
import { runtimeSettings } from '../../config';
import {
  reconcileSessionLiveness,
  reconcileNonPlanningSessionLiveness,
} from '../sessionLivenessReconciler';

const NOW = 1_700_000_000_000;
const OLD_START = NOW - 60 * 60_000; // 1 hour before "now" — well past the grace floor

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_events').run();
  vi.clearAllMocks();
  runtimeSettings.session_mode = 'cli';
});

function seedSession(opts: {
  sessionId: string;
  status: string;
  startedAt?: number;
  sessionType?: string;
}): void {
  insertSession({
    session_id: opts.sessionId,
    task_id: `task-${opts.sessionId}`,
    task_url: null,
    project_context_url: null,
    status: opts.status,
    started_at: opts.startedAt ?? OLD_START,
    session_type: opts.sessionType ?? 'groom',
    task_name: null,
  } as never);
}

describe('reconcileSessionLiveness', () => {
  it('reconciles a running session with no live OS process to a terminal status', () => {
    seedSession({ sessionId: 'ghost-running', status: 'running' });

    const result = reconcileSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual(['ghost-running']);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('ghost-running') as { status: string };
    expect(row.status).toBe('killed');
  });

  it('reconciles an idle session with no live OS process to a terminal status', () => {
    seedSession({ sessionId: 'ghost-idle', status: 'idle' });

    const result = reconcileSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual(['ghost-idle']);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('ghost-idle') as { status: string };
    expect(row.status).toBe('killed');
  });

  it('leaves a session alone whose process exists, even when its last event is hours old', () => {
    seedSession({ sessionId: 'live-but-old', status: 'running' });
    insertEvent({
      session_id: 'live-but-old',
      event_type: 'text',
      payload: '{}',
      timestamp: NOW - 6 * 60 * 60_000, // 6 hours stale
    });

    const result = reconcileSessionLiveness({
      isProcessAlive: () => true,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual([]);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('live-but-old') as { status: string };
    expect(row.status).toBe('running');
  });

  it('does not gate on a stale in-memory map entry (isAlive) — process non-existence alone drives reconciliation', () => {
    seedSession({ sessionId: 'stale-map-entry', status: 'idle' });
    // Simulate SessionManager.sessions still holding a (stale) entry for
    // this session, unrelated to any isAlive() lookup the reconciler might
    // have been tempted to consult — it must reconcile anyway, since the
    // real signal is process non-existence.
    const inMemoryMap = new Map<string, true>([['stale-map-entry', true]]);

    const result = reconcileSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
      evictSessionMapEntry: (sessionId) => inMemoryMap.delete(sessionId),
    });

    expect(result.reconciled).toEqual(['stale-map-entry']);
    expect(inMemoryMap.has('stale-map-entry')).toBe(false);
  });

  it('releases the planning-concurrency slot after reconciliation', () => {
    seedSession({ sessionId: 'slot-holder', status: 'running' });
    expect(countLivePlanningSessions()).toBe(1);

    reconcileSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(countLivePlanningSessions()).toBe(0);
  });

  it('records an audit event naming the reconciled sessions and the reason', () => {
    seedSession({ sessionId: 'ghost-1', status: 'running' });
    seedSession({ sessionId: 'ghost-2', status: 'idle' });

    reconcileSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'planning_sessions_liveness_reconciled',
        payload: expect.objectContaining({
          reconciled_count: 2,
          session_ids: expect.arrayContaining(['ghost-1', 'ghost-2']),
          reason: 'process_not_found',
        }),
      }),
    );
  });

  it('does not record an audit event when nothing was reconciled', () => {
    seedSession({ sessionId: 'still-alive', status: 'running' });

    reconcileSessionLiveness({ isProcessAlive: () => true, nowFn: () => NOW });

    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('skips a just-created row that has not yet cleared the process-race grace floor', () => {
    seedSession({
      sessionId: 'just-started',
      status: 'starting',
      startedAt: NOW - 5_000, // 5s ago — inside the grace window
    });

    const result = reconcileSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual([]);
  });

  it('does not reconcile anything in api session mode (no OS subprocess exists by design)', () => {
    runtimeSettings.session_mode = 'api';
    seedSession({ sessionId: 'api-mode-session', status: 'running' });

    const result = reconcileSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual([]);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('api-mode-session') as { status: string };
    expect(row.status).toBe('running');
  });
});

describe('reconcileNonPlanningSessionLiveness', () => {
  it('reconciles a dead standard session with zero session_events rows to killed', () => {
    seedSession({
      sessionId: 'ghost-standard',
      status: 'running',
      sessionType: 'standard',
    });

    const result = reconcileNonPlanningSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual(['ghost-standard']);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('ghost-standard') as { status: string };
    expect(row.status).toBe('killed');
    const eventCount = db
      .prepare('SELECT COUNT(*) AS c FROM session_events WHERE session_id = ?')
      .get('ghost-standard') as { c: number };
    expect(eventCount.c).toBe(0);
  });

  it('reconciles a dead review session to killed', () => {
    seedSession({
      sessionId: 'ghost-review',
      status: 'running',
      sessionType: 'review',
    });

    const result = reconcileNonPlanningSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual(['ghost-review']);
  });

  it('reconciles a dead depth_review session to killed', () => {
    seedSession({
      sessionId: 'ghost-depth-review',
      status: 'running',
      sessionType: 'depth_review',
    });

    const result = reconcileNonPlanningSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual(['ghost-depth-review']);
  });

  it('leaves a live resumed standard session alone', () => {
    seedSession({
      sessionId: 'live-resumed-standard',
      status: 'running',
      sessionType: 'standard',
    });

    const result = reconcileNonPlanningSessionLiveness({
      isProcessAlive: () => true,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual([]);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('live-resumed-standard') as { status: string };
    expect(row.status).toBe('running');
  });

  it('does not touch planning-type sessions — those stay in the planning-scoped sweep', () => {
    seedSession({
      sessionId: 'ghost-groom',
      status: 'running',
      sessionType: 'groom',
    });

    const result = reconcileNonPlanningSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual([]);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('ghost-groom') as { status: string };
    expect(row.status).toBe('running');
  });

  it('skips a just-created row that has not yet cleared the process-race grace floor', () => {
    seedSession({
      sessionId: 'just-started-standard',
      status: 'starting',
      startedAt: NOW - 5_000,
      sessionType: 'standard',
    });

    const result = reconcileNonPlanningSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual([]);
  });

  it('does not reconcile anything in api session mode', () => {
    runtimeSettings.session_mode = 'api';
    seedSession({
      sessionId: 'api-mode-standard',
      status: 'running',
      sessionType: 'standard',
    });

    const result = reconcileNonPlanningSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual([]);
  });

  it('records an audit event distinct from the planning sweep', () => {
    seedSession({
      sessionId: 'ghost-standard-2',
      status: 'running',
      sessionType: 'standard',
    });

    reconcileNonPlanningSessionLiveness({
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'non_planning_sessions_liveness_reconciled',
        payload: expect.objectContaining({
          reconciled_count: 1,
          session_ids: ['ghost-standard-2'],
          reason: 'process_not_found',
        }),
      }),
    );
  });
});
