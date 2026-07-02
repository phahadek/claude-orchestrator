import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../config.js', () => ({
  runtimeSettings: {
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
}));

import {
  getPRBySessionId,
  insertPauseInterval,
  getSession,
} from '../../db/queries.js';
import { StuckSessionMonitor } from '../StuckSessionMonitor.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSessionManager() {
  return {
    on: vi.fn(),
    send: vi.fn(),
  } as unknown as import('../../session/SessionManager').SessionManager;
}

function makeMonitor() {
  const broadcast = vi.fn();
  const sessionManager = makeSessionManager();
  const monitor = new StuckSessionMonitor(sessionManager, broadcast);
  return { monitor, broadcast, sessionManager };
}

function seedTimerState(monitor: StuckSessionMonitor, sessionId: string) {
  // firePause is private and only ever invoked from an armed setTimeout;
  // reach in directly to arm the in-memory state without waiting on real timers.
  (monitor as unknown as { timers: Map<string, unknown> }).timers.set(
    sessionId,
    {
      taskName: 'Test Task',
      notifyTimer: null,
      pauseTimer: null,
      hardStopTimer: null,
      notifyDeadline: 0,
      pauseDeadline: Date.now(),
      hardStopDeadline: 0,
      notifyRemainingMs: null,
      pauseRemainingMs: null,
      hardStopRemainingMs: null,
      hardStopArmed: false,
    },
  );
}

function callFirePause(monitor: StuckSessionMonitor, sessionId: string) {
  (
    monitor as unknown as { firePause: (id: string) => void }
  ).firePause(sessionId);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StuckSessionMonitor.firePause', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bails out without writing pause state when the session row is gone', () => {
    vi.mocked(getSession).mockReturnValue(undefined);
    const { monitor, broadcast } = makeMonitor();
    seedTimerState(monitor, 'sess-gone');

    expect(() => callFirePause(monitor, 'sess-gone')).not.toThrow();

    expect(insertPauseInterval).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(
      (monitor as unknown as { timers: Map<string, unknown> }).timers.has(
        'sess-gone',
      ),
    ).toBe(false);
  });

  it('still writes the pause interval and broadcasts for an existing session', () => {
    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-live',
    } as never);
    vi.mocked(getPRBySessionId).mockReturnValue(null);
    const { monitor, broadcast, sessionManager } = makeMonitor();
    seedTimerState(monitor, 'sess-live');

    expect(() => callFirePause(monitor, 'sess-live')).not.toThrow();

    expect(insertPauseInterval).toHaveBeenCalledWith(
      'sess-live',
      'stuck_timeout',
    );
    expect(sessionManager.send).toHaveBeenCalledWith(
      'sess-live',
      expect.any(String),
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stuck_session_paused',
        sessionId: 'sess-live',
      }),
    );
  });
});
