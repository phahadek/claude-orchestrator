import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../config.js', () => ({
  runtimeSettings: {
    session_notify_threshold_seconds: 3600,
    session_pause_threshold_seconds: 7200,
    session_hard_stop_window_seconds: 60,
  },
}));

vi.mock('../../db/queries.js', () => ({
  getPRBySessionId: vi.fn().mockReturnValue(null),
  setPauseReason: vi.fn(),
  setTaskPauseReason: vi.fn(),
  setSessionPauseReason: vi.fn(),
  archiveSession: vi.fn(),
  insertPauseInterval: vi.fn(),
  closePauseInterval: vi.fn(),
  upsertStuckSessionTimer: vi.fn(),
  deleteStuckSessionTimer: vi.fn(),
  getAllStuckSessionTimers: vi.fn().mockReturnValue([]),
  getStuckResultSessionRows: vi.fn().mockReturnValue([]),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getSession: vi.fn().mockReturnValue({ session_id: 'sess-1' }),
  getSessionLastActivityMs: vi.fn().mockReturnValue(null),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../session/processLiveness', () => ({
  isSessionProcessAlive: vi.fn().mockReturnValue(true),
}));

import { recordEvent } from '../../audit/AuditLog';
import { isSessionProcessAlive } from '../../session/processLiveness';
import { StuckSessionMonitor } from '../StuckSessionMonitor.js';
import * as queries from '../../db/queries.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSessionManager() {
  const handlers: Record<string, (msg: unknown) => void> = {};
  return {
    on: vi.fn((event: string, handler: (msg: unknown) => void) => {
      handlers[event] = handler;
    }),
    send: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    reclaimSessionProcess: vi.fn(),
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

function runHeartbeatSweep(monitor: StuckSessionMonitor) {
  (monitor as unknown as { runHeartbeatSweep: () => void }).runHeartbeatSweep();
}

describe('StuckSessionMonitor intra-tool heartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isSessionProcessAlive).mockReturnValue(true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not trip notify/pause for a session busy inside one long tool call whose process is alive', () => {
    const { monitor, broadcast, sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-1',
      taskName: 'Long build',
    });

    // A single tool_use with no matching tool_result — a long-running Bash
    // build/test call. Nothing else arrives until it completes.
    emitSessionEvent(sessionManager, 'sess-1', 'tool_use');

    // Simulate the heartbeat scheduler firing repeatedly while the tool call
    // is still running, well past both the notify and pause thresholds.
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(5 * 60 * 1000);
      runHeartbeatSweep(monitor);
    }

    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_paused' }),
    );

    // The tool call finally completes.
    emitSessionEvent(sessionManager, 'sess-1', 'tool_result');
    expect(monitor.isTracking('sess-1')).toBe(true);
  });

  it('still trips notify/pause for a session with no in-flight tool_use, regardless of the heartbeat sweep', () => {
    const { monitor, broadcast, sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-2',
      taskName: 'Idle task',
    });

    // No tool_use emitted at all — the heartbeat sweep must be a no-op here.
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(5 * 60 * 1000);
      runHeartbeatSweep(monitor);
    }

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stuck_session_notified',
        sessionId: 'sess-2',
      }),
    );
    expect(monitor.isTracking('sess-2')).toBe(true);

    // The hard-stop window (armed by the pause) expires with no further
    // activity — the session is reclaimed (OS process torn down) and
    // surfaced to the operator, never terminalized directly.
    expect(sessionManager.reclaimSessionProcess).toHaveBeenCalledWith(
      'sess-2',
    );
    expect(queries.archiveSession).toHaveBeenCalledWith('sess-2');
    expect(queries.setSessionPauseReason).toHaveBeenCalledWith(
      'sess-2',
      'stuck_session_hard_stop_window_expired',
    );
  });

  it('still trips notify/pause once a long tool call is left running after the OS process has exited', () => {
    const { monitor, broadcast, sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-3',
      taskName: 'Crashed mid-call',
    });

    emitSessionEvent(sessionManager, 'sess-3', 'tool_use');
    vi.mocked(isSessionProcessAlive).mockReturnValue(false);

    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(5 * 60 * 1000);
      runHeartbeatSweep(monitor);
    }

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stuck_session_notified',
        sessionId: 'sess-3',
      }),
    );

    // A tool_use pending with the OS process already gone doesn't hold off
    // the hard-stop window — it still expires and reclaims the (already
    // dead) process, surfacing the session rather than terminalizing it.
    expect(sessionManager.reclaimSessionProcess).toHaveBeenCalledWith(
      'sess-3',
    );
    expect(queries.archiveSession).toHaveBeenCalledWith('sess-3');
  });

  it('records each heartbeat tick via recordEvent (audit_log), not as a session_event', () => {
    const { monitor, sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-4',
      taskName: 'Long build',
    });

    emitSessionEvent(sessionManager, 'sess-4', 'tool_use');
    vi.mocked(recordEvent).mockClear();

    runHeartbeatSweep(monitor);

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'stuck_session_heartbeat_tick',
        actor_type: 'system',
        actor_id: 'sess-4',
        payload: expect.objectContaining({ session_id: 'sess-4' }),
      }),
    );
    // recordEvent (audit_log) is the only persistence path the sweep writes
    // through — no insertEvent/session_events call is made by this module.
    const heartbeatTicks = vi
      .mocked(recordEvent)
      .mock.calls.filter(
        ([e]) => e.event_type === 'stuck_session_heartbeat_tick',
      );
    expect(heartbeatTicks).toHaveLength(1);
  });

  it('does not sweep a session suspended for PR review even with an in-flight tool_use', () => {
    const { monitor, broadcast, sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-5',
      taskName: 'Code task',
    });
    emitSessionEvent(sessionManager, 'sess-5', 'tool_use');
    sessionManager.emit('message', {
      type: 'pr_created',
      sessionId: 'sess-5',
    });
    vi.mocked(recordEvent).mockClear();

    runHeartbeatSweep(monitor);

    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'stuck_session_heartbeat_tick' }),
    );
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
  });
});
