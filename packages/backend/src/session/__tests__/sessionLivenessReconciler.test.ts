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
import * as queries from '../../db/queries.js';
import {
  insertSession,
  countLivePlanningSessions,
  insertEvent,
  updateSessionStatus,
  listCompletingSignalsForSession,
} from '../../db/queries.js';
import { runtimeSettings } from '../../config';
import {
  reconcileSessionLiveness,
  reconcileNonPlanningSessionLiveness,
  reconcileOrphanProcesses,
} from '../sessionLivenessReconciler';
import { updateSessionWorktreePath } from '../../db/queries';
import type { ClaudeSessionProcess } from '../processLiveness';

const NOW = 1_700_000_000_000;
const OLD_START = NOW - 60 * 60_000; // 1 hour before "now" — well past the grace floor
// Backend "up" for well over the post-boot settle window, unless a test
// overrides bootTimeMs itself to exercise that gate directly.
const BOOT_LONG_AGO = NOW - 60 * 60_000;

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
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual(['ghost-running']);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('ghost-running') as { status: string };
    expect(row.status).toBe('killed');

    // The liveness-sweep kill write goes through updateSessionStatus, which
    // now mirrors it into completing_signal_ledger — see the shared-primitives
    // dual-write migration.
    const signals = listCompletingSignalsForSession('ghost-running');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signal_class: 'legacy_status_write',
      signal_value: 'killed',
    });
  });

  it('reconciles an idle session with no live OS process to a terminal status', () => {
    seedSession({ sessionId: 'ghost-idle', status: 'idle' });

    const result = reconcileSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
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
      bootTimeMs: BOOT_LONG_AGO,
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
      bootTimeMs: BOOT_LONG_AGO,
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
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(countLivePlanningSessions()).toBe(0);
  });

  it('records an audit event naming the reconciled sessions and the reason', () => {
    seedSession({ sessionId: 'ghost-1', status: 'running' });
    seedSession({ sessionId: 'ghost-2', status: 'idle' });

    reconcileSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
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
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual([]);
  });

  it('does not reconcile anything in api session mode (no OS subprocess exists by design)', () => {
    runtimeSettings.session_mode = 'api';
    seedSession({ sessionId: 'api-mode-session', status: 'running' });

    const result = reconcileSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual([]);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('api-mode-session') as { status: string };
    expect(row.status).toBe('running');
  });

  it('records examined = N, alive = N, terminalized = 0 when the whole candidate set reports alive', () => {
    seedSession({ sessionId: 'alive-1', status: 'running' });
    seedSession({ sessionId: 'alive-2', status: 'running' });
    seedSession({ sessionId: 'alive-3', status: 'idle' });

    const result = reconcileSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => true,
      nowFn: () => NOW,
    });

    expect(result.examined).toBe(3);
    expect(result.alive).toBe(3);
    expect(result.reconciled.length).toBe(0);
  });

  it('records examined = 0 for an empty candidate set — distinguishable from an all-alive sweep', () => {
    const result = reconcileSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => true,
      nowFn: () => NOW,
    });

    expect(result.examined).toBe(0);
    expect(result.alive).toBe(0);
    expect(result.reconciled.length).toBe(0);
  });

  it('counts a row whose liveness check fails open (unreadable ps) as alive, and does not terminalize it', () => {
    seedSession({ sessionId: 'fail-open-row', status: 'running' });

    // isSessionProcessAlive returns true on an unreadable ps — simulate that
    // fail-open verdict directly via the injected isProcessAlive dep.
    const result = reconcileSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => true,
      nowFn: () => NOW,
    });

    expect(result.alive).toBe(1);
    expect(result.reconciled).toEqual([]);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('fail-open-row') as { status: string };
    expect(row.status).toBe('running');
  });

  it('items_processed (reconciled.length) still equals the terminalized count, unchanged in meaning', () => {
    seedSession({ sessionId: 'dead-1', status: 'running' });
    seedSession({ sessionId: 'dead-2', status: 'running' });
    seedSession({ sessionId: 'alive-4', status: 'running' });

    const result = reconcileSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: (sessionId) => sessionId === 'alive-4',
      nowFn: () => NOW,
    });

    expect(result.reconciled.length).toBe(2);
    expect(result.examined).toBe(3);
    expect(result.alive).toBe(1);
  });

  it('routes a dead planning session through tryMarkPlanningTerminal instead of writing a bare killed status, when the hook reports it terminalized the session itself', () => {
    seedSession({ sessionId: 'settled-investigate', status: 'running' });
    const tryMarkPlanningTerminal = vi.fn().mockImplementation(() => {
      // Simulate PlanningOrchestrator.tryTerminalizeIfComplete's own write.
      updateSessionStatus('settled-investigate', 'done', NOW);
      return true;
    });

    const result = reconcileSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => false,
      nowFn: () => NOW,
      tryMarkPlanningTerminal,
    });

    expect(tryMarkPlanningTerminal).toHaveBeenCalledWith('settled-investigate');
    expect(result.reconciled).toEqual(['settled-investigate']);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('settled-investigate') as { status: string };
    expect(row.status).toBe('done');
  });

  it('falls back to writing killed when tryMarkPlanningTerminal reports the session was not eligible', () => {
    seedSession({ sessionId: 'still-pending', status: 'running' });
    const tryMarkPlanningTerminal = vi.fn().mockReturnValue(false);

    const result = reconcileSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => false,
      nowFn: () => NOW,
      tryMarkPlanningTerminal,
    });

    expect(tryMarkPlanningTerminal).toHaveBeenCalledWith('still-pending');
    expect(result.reconciled).toEqual(['still-pending']);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('still-pending') as { status: string };
    expect(row.status).toBe('killed');
  });

  it('sets terminal_completion_reason naming the reap when a genuinely dead session is reconciled', () => {
    seedSession({ sessionId: 'reason-ghost', status: 'running' });

    reconcileSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    const row = db
      .prepare(
        'SELECT terminal_completion_reason FROM sessions WHERE session_id = ?',
      )
      .get('reason-ghost') as { terminal_completion_reason: string | null };
    expect(row.terminal_completion_reason).toBe(
      'liveness_reconciler_process_not_found',
    );
  });

  it('does not revoke credentials for any quiet session when the backend has been up for less than the settle window', () => {
    // Quiet for 21 minutes — well past the activity grace floor — but the
    // backend itself only booted 30 seconds ago (e.g. right after a
    // restart, before the in-memory session/process map has rehydrated).
    seedSession({
      sessionId: 'quiet-across-restart',
      status: 'running',
      startedAt: NOW - 21 * 60_000,
    });

    const result = reconcileSessionLiveness({
      bootTimeMs: NOW - 30_000,
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual([]);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('quiet-across-restart') as { status: string };
    expect(row.status).toBe('running');
  });

  it('resumes normal reap behavior for a genuinely dead session once the settle window has elapsed', () => {
    seedSession({
      sessionId: 'dead-after-settle',
      status: 'running',
      startedAt: NOW - 21 * 60_000,
    });

    const result = reconcileSessionLiveness({
      // Backend booted well over the settle window ago.
      bootTimeMs: NOW - 5 * 60_000,
      isProcessAlive: () => false,
      nowFn: () => NOW,
    });

    expect(result.reconciled).toEqual(['dead-after-settle']);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('dead-after-settle') as { status: string };
    expect(row.status).toBe('killed');
  });

  it('does not treat a session with an undispositioned staged intent as inactive, even past the activity grace floor', () => {
    seedSession({
      sessionId: 'blocked-on-staged-intent',
      status: 'running',
      startedAt: NOW - 21 * 60_000,
    });

    const result = reconcileSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => false,
      nowFn: () => NOW,
      hasUndispositionedStagedIntents: (sessionId) =>
        sessionId === 'blocked-on-staged-intent',
    });

    expect(result.reconciled).toEqual([]);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('blocked-on-staged-intent') as { status: string };
    expect(row.status).toBe('running');
  });

  it('reaps a quiet session with no staged intents even when the hook is wired', () => {
    seedSession({
      sessionId: 'quiet-no-staged-intent',
      status: 'running',
      startedAt: NOW - 21 * 60_000,
    });

    const result = reconcileSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => false,
      nowFn: () => NOW,
      hasUndispositionedStagedIntents: () => false,
    });

    expect(result.reconciled).toEqual(['quiet-no-staged-intent']);
  });

  it('never consults tryMarkPlanningTerminal for the non-planning population', () => {
    insertSession({
      session_id: 'standard-ghost',
      task_id: 'task-standard-ghost',
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: OLD_START,
      session_type: 'standard',
      task_name: null,
    } as never);
    const tryMarkPlanningTerminal = vi.fn().mockReturnValue(true);

    reconcileNonPlanningSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => false,
      nowFn: () => NOW,
      tryMarkPlanningTerminal,
    });

    expect(tryMarkPlanningTerminal).not.toHaveBeenCalled();
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
      bootTimeMs: BOOT_LONG_AGO,
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
      bootTimeMs: BOOT_LONG_AGO,
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
      bootTimeMs: BOOT_LONG_AGO,
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
      bootTimeMs: BOOT_LONG_AGO,
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
      bootTimeMs: BOOT_LONG_AGO,
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
      bootTimeMs: BOOT_LONG_AGO,
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
      bootTimeMs: BOOT_LONG_AGO,
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
      bootTimeMs: BOOT_LONG_AGO,
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

  it('records examined = N, alive = N, terminalized = 0 when the whole candidate set reports alive', () => {
    seedSession({
      sessionId: 'np-alive-1',
      status: 'running',
      sessionType: 'standard',
    });
    seedSession({
      sessionId: 'np-alive-2',
      status: 'running',
      sessionType: 'review',
    });

    const result = reconcileNonPlanningSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => true,
      nowFn: () => NOW,
    });

    expect(result.examined).toBe(2);
    expect(result.alive).toBe(2);
    expect(result.reconciled.length).toBe(0);
  });

  it('records examined = 0 for an empty candidate set — distinguishable from an all-alive sweep', () => {
    const result = reconcileNonPlanningSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => true,
      nowFn: () => NOW,
    });

    expect(result.examined).toBe(0);
    expect(result.alive).toBe(0);
    expect(result.reconciled.length).toBe(0);
  });

  it('counts a row whose liveness check fails open (unreadable ps) as alive, and does not terminalize it', () => {
    seedSession({
      sessionId: 'np-fail-open-row',
      status: 'running',
      sessionType: 'standard',
    });

    const result = reconcileNonPlanningSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: () => true,
      nowFn: () => NOW,
    });

    expect(result.alive).toBe(1);
    expect(result.reconciled).toEqual([]);
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('np-fail-open-row') as { status: string };
    expect(row.status).toBe('running');
  });

  it('items_processed (reconciled.length) still equals the terminalized count, unchanged in meaning', () => {
    seedSession({
      sessionId: 'np-dead-1',
      status: 'running',
      sessionType: 'standard',
    });
    seedSession({
      sessionId: 'np-alive-3',
      status: 'running',
      sessionType: 'review',
    });

    const result = reconcileNonPlanningSessionLiveness({
      bootTimeMs: BOOT_LONG_AGO,
      isProcessAlive: (sessionId) => sessionId === 'np-alive-3',
      nowFn: () => NOW,
    });

    expect(result.reconciled.length).toBe(1);
    expect(result.examined).toBe(2);
    expect(result.alive).toBe(1);
  });
});

describe('reconcileOrphanProcesses', () => {
  function proc(
    overrides: Partial<ClaudeSessionProcess>,
  ): ClaudeSessionProcess {
    return { pid: 1234, sessionId: null, etimeSeconds: 10_000, ...overrides };
  }

  // Instant, no real delay — tests must never actually wait out
  // KILL_ESCALATION_WAIT_MS / POST_SIGKILL_SETTLE_MS.
  const instantWait = async () => {};

  it('reaps a process whose row is terminal (done) past the grace floor', async () => {
    seedSession({ sessionId: 'orphan-done', status: 'running' });
    updateSessionStatus('orphan-done', 'done', NOW - 60 * 60_000);

    const killed: Array<[number, NodeJS.Signals]> = [];
    const result = await reconcileOrphanProcesses({
      scanProcesses: () => [proc({ pid: 111, sessionId: 'orphan-done' })],
      killProcess: (pid, signal) => killed.push([pid, signal]),
      isPidAlive: () => false, // dies right after SIGTERM
      waitMs: instantWait,
      nowFn: () => NOW,
    });

    expect(result.examined).toBe(1);
    expect(result.reaped).toBe(1);
    expect(result.skippedByGrace).toBe(0);
    expect(result.survivedEscalation).toBe(0);
    expect(killed).toEqual([[111, 'SIGTERM']]);
  });

  it.each(['error', 'killed', 'superseded'])(
    'reaps a process whose row is terminal (%s) past the grace floor',
    async (status) => {
      seedSession({ sessionId: `orphan-${status}`, status: 'running' });
      updateSessionStatus(`orphan-${status}`, status, NOW - 60 * 60_000);

      const killed: number[] = [];
      const result = await reconcileOrphanProcesses({
        scanProcesses: () => [
          proc({ pid: 222, sessionId: `orphan-${status}` }),
        ],
        killProcess: (pid) => killed.push(pid),
        isPidAlive: () => false,
        waitMs: instantWait,
        nowFn: () => NOW,
      });

      expect(result.reaped).toBe(1);
      expect(killed).toEqual([222]);
    },
  );

  it('never reaps a process whose row is non-terminal', async () => {
    seedSession({ sessionId: 'live-row', status: 'running' });

    const killed: number[] = [];
    const result = await reconcileOrphanProcesses({
      scanProcesses: () => [proc({ pid: 333, sessionId: 'live-row' })],
      killProcess: (pid) => killed.push(pid),
      isPidAlive: () => false,
      waitMs: instantWait,
      nowFn: () => NOW,
    });

    expect(result.reaped).toBe(0);
    expect(killed).toEqual([]);
  });

  it('never treats a process with no resolvable session uuid (claude remote-control) as a candidate', async () => {
    const killed: number[] = [];
    const result = await reconcileOrphanProcesses({
      scanProcesses: () => [
        // Exact cmdline shape from processLiveness.scanClaudeSessionProcesses
        // for `/usr/bin/claude remote-control` — no --session-id/--resume flag,
        // so sessionId comes back null.
        { pid: 444, sessionId: null, etimeSeconds: 1_000_000 },
      ],
      killProcess: (pid) => killed.push(pid),
      isPidAlive: () => false,
      waitMs: instantWait,
      nowFn: () => NOW,
    });

    expect(result.examined).toBe(0);
    expect(result.reaped).toBe(0);
    expect(killed).toEqual([]);
  });

  it('never reaps a process whose sessionId resolves to no row — e.g. a Remote Control cloud session id', async () => {
    const killed: number[] = [];
    const result = await reconcileOrphanProcesses({
      scanProcesses: () => [
        // Remote Control sessions carry a cse_-prefixed cloud session id
        // that never has a row in this DB — it must never be reaped.
        proc({
          pid: 555,
          sessionId: 'cse_01HoHJzea111waLofaBDYimz',
          etimeSeconds: 10_000,
        }),
      ],
      killProcess: (pid) => killed.push(pid),
      isPidAlive: () => false,
      waitMs: instantWait,
      nowFn: () => NOW,
    });

    expect(result.examined).toBe(1);
    expect(result.reaped).toBe(0);
    expect(result.skippedByGrace).toBe(0);
    expect(killed).toEqual([]);
  });

  it('skips a terminal row whose ended_at is inside the grace floor, counting it in skippedByGrace', async () => {
    seedSession({ sessionId: 'just-terminalized', status: 'running' });
    updateSessionStatus('just-terminalized', 'done', NOW - 5_000);

    const killed: number[] = [];
    const result = await reconcileOrphanProcesses({
      scanProcesses: () => [proc({ pid: 777, sessionId: 'just-terminalized' })],
      killProcess: (pid) => killed.push(pid),
      isPidAlive: () => false,
      waitMs: instantWait,
      nowFn: () => NOW,
    });

    expect(result.reaped).toBe(0);
    expect(result.skippedByGrace).toBe(1);
    expect(killed).toEqual([]);
  });

  it('is a no-op in api session mode', async () => {
    runtimeSettings.session_mode = 'api';
    const killed: number[] = [];
    const result = await reconcileOrphanProcesses({
      scanProcesses: () => [proc({ pid: 888, sessionId: 'whatever' })],
      killProcess: (pid) => killed.push(pid),
      isPidAlive: () => false,
      waitMs: instantWait,
      nowFn: () => NOW,
    });

    expect(result).toEqual({
      examined: 0,
      reaped: 0,
      skippedByGrace: 0,
      survivedEscalation: 0,
    });
    expect(killed).toEqual([]);
  });

  it('writes no session status — status-writer spy must not be called', async () => {
    seedSession({ sessionId: 'no-status-write', status: 'running' });
    updateSessionStatus('no-status-write', 'done', NOW - 60 * 60_000);

    const statusWriterSpy = vi.spyOn(queries, 'updateSessionStatus');
    statusWriterSpy.mockClear();

    await reconcileOrphanProcesses({
      scanProcesses: () => [proc({ pid: 999, sessionId: 'no-status-write' })],
      killProcess: () => {},
      isPidAlive: () => false,
      waitMs: instantWait,
      nowFn: () => NOW,
    });

    expect(statusWriterSpy).not.toHaveBeenCalled();
    statusWriterSpy.mockRestore();
    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('no-status-write') as { status: string };
    expect(row.status).toBe('done');
  });

  it('evicts a stale in-memory map entry for a reaped session', async () => {
    seedSession({ sessionId: 'evict-me', status: 'running' });
    updateSessionStatus('evict-me', 'killed', NOW - 60 * 60_000);
    const inMemoryMap = new Map<string, true>([['evict-me', true]]);

    await reconcileOrphanProcesses({
      scanProcesses: () => [proc({ pid: 1010, sessionId: 'evict-me' })],
      killProcess: () => {},
      isPidAlive: () => false,
      waitMs: instantWait,
      evictSessionMapEntry: (sessionId) => inMemoryMap.delete(sessionId),
      nowFn: () => NOW,
    });

    expect(inMemoryMap.has('evict-me')).toBe(false);
  });

  it('reports examined and reaped separately, so a zero is distinguishable from a no-op sweep', async () => {
    const result = await reconcileOrphanProcesses({
      scanProcesses: () => [],
      nowFn: () => NOW,
    });

    expect(result).toEqual({
      examined: 0,
      reaped: 0,
      skippedByGrace: 0,
      survivedEscalation: 0,
    });
  });

  it('reaping a terminal session also kills its cgroup — reaches a test-command tree (pytest, uv run task test) that carries no --session-id/--resume of its own and so is invisible to scanProcesses', async () => {
    seedSession({ sessionId: 'orphan-with-tree', status: 'running' });
    updateSessionStatus('orphan-with-tree', 'done', NOW - 60 * 60_000);
    updateSessionWorktreePath(
      'orphan-with-tree',
      '/srv/app/.claude/worktrees/orphan-with-tree',
    );

    const cgroupKills: string[] = [];
    const worktreeKills: string[] = [];
    const result = await reconcileOrphanProcesses({
      scanProcesses: () => [proc({ pid: 111, sessionId: 'orphan-with-tree' })],
      killProcess: () => {},
      isPidAlive: () => false,
      waitMs: instantWait,
      killSessionCgroup: (sessionId) => cgroupKills.push(sessionId),
      killWorktreeProcessTree: (worktreePath) => {
        worktreeKills.push(worktreePath);
        return 1;
      },
      nowFn: () => NOW,
    });

    expect(result.reaped).toBe(1);
    expect(cgroupKills).toEqual(['orphan-with-tree']);
    expect(worktreeKills).toEqual([
      '/srv/app/.claude/worktrees/orphan-with-tree',
    ]);
  });

  it('never kills a cgroup or worktree-path tree for a process with no resolvable session uuid (claude remote-control)', async () => {
    const cgroupKills: string[] = [];
    const worktreeKills: string[] = [];
    const result = await reconcileOrphanProcesses({
      scanProcesses: () => [
        { pid: 444, sessionId: null, etimeSeconds: 1_000_000 },
      ],
      killProcess: () => {},
      isPidAlive: () => false,
      waitMs: instantWait,
      killSessionCgroup: (sessionId) => cgroupKills.push(sessionId),
      killWorktreeProcessTree: (worktreePath) => {
        worktreeKills.push(worktreePath);
        return 1;
      },
      nowFn: () => NOW,
    });

    expect(result.examined).toBe(0);
    expect(cgroupKills).toEqual([]);
    expect(worktreeKills).toEqual([]);
  });

  it('never kills a cgroup or worktree-path tree for a session uuid resolving to no row — e.g. a Remote Control cloud session id', async () => {
    const cgroupKills: string[] = [];
    const worktreeKills: string[] = [];
    const result = await reconcileOrphanProcesses({
      scanProcesses: () => [
        proc({
          pid: 555,
          sessionId: 'cse_01HoHJzea111waLofaBDYimz',
          etimeSeconds: 10_000,
        }),
      ],
      killProcess: () => {},
      isPidAlive: () => false,
      waitMs: instantWait,
      killSessionCgroup: (sessionId) => cgroupKills.push(sessionId),
      killWorktreeProcessTree: (worktreePath) => {
        worktreeKills.push(worktreePath);
        return 1;
      },
      nowFn: () => NOW,
    });

    expect(result.reaped).toBe(0);
    expect(cgroupKills).toEqual([]);
    expect(worktreeKills).toEqual([]);
  });

  it('never kills a cgroup or worktree-path tree for a process whose row is non-terminal (live session)', async () => {
    seedSession({ sessionId: 'live-row-2', status: 'running' });
    updateSessionWorktreePath(
      'live-row-2',
      '/srv/app/.claude/worktrees/live-row-2',
    );

    const cgroupKills: string[] = [];
    const worktreeKills: string[] = [];
    await reconcileOrphanProcesses({
      scanProcesses: () => [proc({ pid: 666, sessionId: 'live-row-2' })],
      killProcess: () => {},
      isPidAlive: () => false,
      waitMs: instantWait,
      killSessionCgroup: (sessionId) => cgroupKills.push(sessionId),
      killWorktreeProcessTree: (worktreePath) => {
        worktreeKills.push(worktreePath);
        return 1;
      },
      nowFn: () => NOW,
    });

    expect(cgroupKills).toEqual([]);
    expect(worktreeKills).toEqual([]);
  });

  it('escalates to SIGKILL when the process ignores SIGTERM, and confirms death before counting it reaped', async () => {
    seedSession({ sessionId: 'ignores-sigterm', status: 'running' });
    updateSessionStatus('ignores-sigterm', 'done', NOW - 60 * 60_000);

    const signalsSent: NodeJS.Signals[] = [];
    // Alive after SIGTERM (first check), dead after SIGKILL (second check).
    let aliveCheckCount = 0;
    const result = await reconcileOrphanProcesses({
      scanProcesses: () => [proc({ pid: 2020, sessionId: 'ignores-sigterm' })],
      killProcess: (_pid, signal) => signalsSent.push(signal),
      isPidAlive: () => {
        aliveCheckCount++;
        return aliveCheckCount === 1;
      },
      waitMs: instantWait,
      nowFn: () => NOW,
    });

    expect(signalsSent).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result.reaped).toBe(1);
    expect(result.survivedEscalation).toBe(0);
  });

  it('does not count a process as reaped when it survives both SIGTERM and SIGKILL', async () => {
    seedSession({ sessionId: 'survives-everything', status: 'running' });
    updateSessionStatus('survives-everything', 'done', NOW - 60 * 60_000);

    const signalsSent: NodeJS.Signals[] = [];
    const result = await reconcileOrphanProcesses({
      scanProcesses: () => [
        proc({ pid: 3030, sessionId: 'survives-everything' }),
      ],
      killProcess: (_pid, signal) => signalsSent.push(signal),
      isPidAlive: () => true, // never dies, e.g. stuck in D-state
      waitMs: instantWait,
      nowFn: () => NOW,
    });

    expect(signalsSent).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result.reaped).toBe(0);
    expect(result.survivedEscalation).toBe(1);
  });

  it('still runs the cgroup and worktree-tree backstops even when the pid-level escalation cannot confirm death', async () => {
    seedSession({ sessionId: 'survives-with-tree', status: 'running' });
    updateSessionStatus('survives-with-tree', 'done', NOW - 60 * 60_000);
    updateSessionWorktreePath(
      'survives-with-tree',
      '/srv/app/.claude/worktrees/survives-with-tree',
    );

    const cgroupKills: string[] = [];
    const result = await reconcileOrphanProcesses({
      scanProcesses: () => [
        proc({ pid: 4040, sessionId: 'survives-with-tree' }),
      ],
      killProcess: () => {},
      isPidAlive: () => true,
      waitMs: instantWait,
      killSessionCgroup: (sessionId) => cgroupKills.push(sessionId),
      nowFn: () => NOW,
    });

    expect(result.survivedEscalation).toBe(1);
    expect(cgroupKills).toEqual(['survives-with-tree']);
  });
});
