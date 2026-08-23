import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../config.js', () => ({
  runtimeSettings: {
    session_notify_threshold_seconds: 3600,
    session_pause_threshold_seconds: 72000,
    session_hard_stop_window_seconds: 60,
  },
}));

vi.mock('../../db/queries.js', () => ({
  getPRBySessionId: vi.fn().mockReturnValue(null),
  setPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  closePauseInterval: vi.fn(),
  upsertStuckSessionTimer: vi.fn(),
  deleteStuckSessionTimer: vi.fn(),
  getAllStuckSessionTimers: vi.fn().mockReturnValue([]),
  getStuckResultSessionRows: vi.fn().mockReturnValue([]),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getSession: vi
    .fn()
    .mockReturnValue({ session_id: 'sess-1', status: 'running' }),
  getSessionLastActivityMs: vi.fn().mockReturnValue(null),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../session/sessionLifecycle.js', () => ({
  sessionIsLive: vi.fn().mockReturnValue(false),
}));

vi.mock('../../session/processLiveness.js', () => ({
  isSessionProcessAlive: vi.fn().mockReturnValue(false),
}));

import { getSession } from '../../db/queries.js';
import { recordEvent } from '../../audit/AuditLog';
import { StuckSessionMonitor } from '../StuckSessionMonitor.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSessionManager() {
  const handlers: Record<string, (msg: unknown) => void> = {};
  return {
    on: vi.fn((event: string, handler: (msg: unknown) => void) => {
      handlers[event] = handler;
    }),
    send: vi.fn().mockReturnValue(true),
    emit(event: string, msg: unknown) {
      handlers[event]?.(msg);
    },
  } as unknown as import('../../session/SessionManager').SessionManager & {
    emit: (event: string, msg: unknown) => void;
  };
}

function makeMonitor() {
  const broadcast = vi.fn();
  const sessionManager = makeSessionManager();
  const monitor = new StuckSessionMonitor(sessionManager, broadcast);
  return { monitor, broadcast, sessionManager };
}

function emitSessionEvent(
  sessionManager: ReturnType<typeof makeSessionManager>,
  sessionId: string,
  eventType: string,
) {
  (sessionManager as unknown as { emit: (e: string, m: unknown) => void }).emit(
    'message',
    { type: 'session_event', sessionId, eventType, content: '{}' },
  );
}

function notifyCheckedCalls() {
  return vi
    .mocked(recordEvent)
    .mock.calls.filter(
      ([evt]) => evt.event_type === 'stuck_session_notify_checked',
    );
}

const NOTIFY_MS = 3600 * 1000;

describe('StuckSessionMonitor stuck_session_notify_checked edge-triggering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-1',
      status: 'running',
    } as never);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records at most one row for repeated polls with flagged unchanged (recordActivity site)', () => {
    const { sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-1',
      taskName: 'Groom milestone X',
    });

    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(20 * 60 * 1000);
      emitSessionEvent(sessionManager, 'sess-1', 'text');
    }

    expect(notifyCheckedCalls().length).toBeLessThanOrEqual(1);
  });

  it('records exactly one row on a false->true transition (fireNotify site)', () => {
    const { sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-1',
      taskName: 'Groom milestone X',
    });

    vi.advanceTimersByTime(NOTIFY_MS + 1000);

    const calls = notifyCheckedCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      payload: expect.objectContaining({
        session_id: 'sess-1',
        flagged: true,
      }),
    });
  });

  it('records exactly one row on a true->false transition (recordActivity recovery)', () => {
    const { sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-1',
      taskName: 'Groom milestone X',
    });

    // Fire the notify threshold — flagged transitions false -> true.
    vi.advanceTimersByTime(NOTIFY_MS + 1000);
    expect(notifyCheckedCalls()).toHaveLength(1);

    // Activity arrives afterward — flagged transitions true -> false.
    emitSessionEvent(sessionManager, 'sess-1', 'text');

    const calls = notifyCheckedCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toMatchObject({
      payload: expect.objectContaining({
        session_id: 'sess-1',
        flagged: false,
      }),
    });
  });

  it('preserves the existing payload shape (session_id, observed_gap_ms, threshold_ms, flagged)', () => {
    const { sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-1',
      taskName: 'Groom milestone X',
    });

    vi.advanceTimersByTime(NOTIFY_MS + 1000);

    const [call] = notifyCheckedCalls();
    expect(call[0]).toMatchObject({
      event_type: 'stuck_session_notify_checked',
      actor_type: 'system',
      actor_id: 'sess-1',
      payload: {
        session_id: 'sess-1',
        observed_gap_ms: expect.any(Number),
        threshold_ms: NOTIFY_MS,
        flagged: true,
      },
    });
  });

  it('does not leak per-session transition state past a terminal session', () => {
    const { monitor, sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-1',
      taskName: 'Groom milestone X',
    });

    vi.advanceTimersByTime(NOTIFY_MS + 1000);
    expect(notifyCheckedCalls()).toHaveLength(1);

    sessionManager.emit('message', {
      type: 'session_ended',
      sessionId: 'sess-1',
    });

    expect(monitor.isTracking('sess-1')).toBe(false);
    expect(
      (monitor as unknown as { timers: Map<string, unknown> }).timers.has(
        'sess-1',
      ),
    ).toBe(false);
  });
});
