/**
 * Terminal-status guards for StuckSessionMonitor — closing the lifecycle gap
 * where clear() previously fired only on the session_ended broadcast, so a
 * session that reached a terminal DB status by any other path (a watcher
 * such as pr_merge_watcher / auto_merger, or an external actor) kept a live
 * timer that eventually fired a false "exceeding expected duration" alert.
 *
 * Verifies:
 * - reapTerminalTimers clears a tracked timer once its session row goes
 *   terminal, independent of any broadcast.
 * - fireNotify skips the toast (and the flagged:true audit row) for a
 *   terminal session, and clears its timer instead.
 * - firePause takes no pause action for a terminal session.
 * - A genuinely inactive, non-terminal session still produces exactly one
 *   notify toast — the guard narrows the alert, it doesn't disable it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  getSession: vi.fn(),
  getSessionLastActivityMs: vi.fn().mockReturnValue(null),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import {
  getSession,
  deleteStuckSessionTimer,
  insertPauseInterval,
} from '../../db/queries.js';
import { recordEvent } from '../../audit/AuditLog';
import { StuckSessionMonitor } from '../StuckSessionMonitor.js';

function makeSessionManager() {
  return {
    on: vi.fn(),
    send: vi.fn().mockReturnValue(true),
  } as unknown as import('../../session/SessionManager').SessionManager;
}

function makeMonitor() {
  const broadcast = vi.fn();
  const sessionManager = makeSessionManager();
  const monitor = new StuckSessionMonitor(sessionManager, broadcast);
  return { monitor, broadcast, sessionManager };
}

function seedTimerState(monitor: StuckSessionMonitor, sessionId: string) {
  (monitor as unknown as { timers: Map<string, unknown> }).timers.set(
    sessionId,
    {
      taskName: 'Test Task',
      notifyTimer: null,
      pauseTimer: null,
      hardStopTimer: null,
      notifyDeadline: Date.now(),
      pauseDeadline: Date.now(),
      hardStopDeadline: 0,
      notifyRemainingMs: null,
      pauseRemainingMs: null,
      hardStopRemainingMs: null,
      hardStopArmed: false,
      suspended: false,
      lastActivityAt: Date.now() - 4_000_000,
    },
  );
}

function callFireNotify(monitor: StuckSessionMonitor, sessionId: string) {
  (monitor as unknown as { fireNotify: (id: string) => void }).fireNotify(
    sessionId,
  );
}

function callFirePause(monitor: StuckSessionMonitor, sessionId: string) {
  (monitor as unknown as { firePause: (id: string) => void }).firePause(
    sessionId,
  );
}

function callReapTerminalTimers(monitor: StuckSessionMonitor) {
  (
    monitor as unknown as { reapTerminalTimers: () => void }
  ).reapTerminalTimers();
}

function hasTimer(monitor: StuckSessionMonitor, sessionId: string) {
  return (monitor as unknown as { timers: Map<string, unknown> }).timers.has(
    sessionId,
  );
}

describe('StuckSessionMonitor terminal-status guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reapTerminalTimers clears a timer whose session reached a terminal status without a session_ended broadcast', () => {
    const { monitor } = makeMonitor();
    seedTimerState(monitor, 'sess-watcher-done');
    // Simulate a watcher-driven transition (e.g. pr_merge_watcher / auto_merger)
    // writing the row directly, with no session_ended broadcast ever firing.
    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-watcher-done',
      status: 'done',
    } as never);

    callReapTerminalTimers(monitor);

    expect(hasTimer(monitor, 'sess-watcher-done')).toBe(false);
    expect(deleteStuckSessionTimer).toHaveBeenCalledWith('sess-watcher-done');
  });

  it('leaves a non-terminal session tracked', () => {
    const { monitor } = makeMonitor();
    seedTimerState(monitor, 'sess-running');
    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-running',
      status: 'running',
    } as never);

    callReapTerminalTimers(monitor);

    expect(hasTimer(monitor, 'sess-running')).toBe(true);
  });

  it('fireNotify emits no toast and records no flagged:true row for a terminal session', () => {
    const { monitor, broadcast } = makeMonitor();
    seedTimerState(monitor, 'sess-terminal-notify');
    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-terminal-notify',
      status: 'error',
    } as never);

    callFireNotify(monitor, 'sess-terminal-notify');

    expect(broadcast).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ flagged: true }),
      }),
    );
    expect(hasTimer(monitor, 'sess-terminal-notify')).toBe(false);
  });

  it('firePause takes no pause action for a terminal session', () => {
    const { monitor, broadcast, sessionManager } = makeMonitor();
    seedTimerState(monitor, 'sess-terminal-pause');
    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-terminal-pause',
      status: 'killed',
    } as never);

    callFirePause(monitor, 'sess-terminal-pause');

    expect(insertPauseInterval).not.toHaveBeenCalled();
    expect(sessionManager.send).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(hasTimer(monitor, 'sess-terminal-pause')).toBe(false);
  });

  it('a genuinely inactive, non-terminal session still produces exactly one notify toast at the threshold', () => {
    const { monitor, broadcast } = makeMonitor();
    seedTimerState(monitor, 'sess-idle-not-terminal');
    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-idle-not-terminal',
      status: 'running',
    } as never);

    callFireNotify(monitor, 'sess-idle-not-terminal');

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stuck_session_notified',
        sessionId: 'sess-idle-not-terminal',
      }),
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ flagged: true }),
      }),
    );
  });
});
