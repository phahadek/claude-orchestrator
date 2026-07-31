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
  getSession: vi.fn().mockReturnValue({ session_id: 'sess-1' }),
}));

import {
  getAllStuckSessionTimers,
  insertPauseInterval,
} from '../../db/queries.js';
import { StuckSessionMonitor } from '../StuckSessionMonitor.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSessionManager() {
  const handlers: Record<string, (msg: unknown) => void> = {};
  return {
    on: vi.fn((event: string, handler: (msg: unknown) => void) => {
      handlers[event] = handler;
    }),
    send: vi.fn(),
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

const NOTIFY_MS = 3600 * 1000;
const PAUSE_MS = 72000 * 1000;

describe('StuckSessionMonitor activity-based deadlines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not flag a session emitting events continuously past the notify threshold', () => {
    const { monitor, broadcast, sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-1',
      taskName: 'Groom milestone X',
    });

    // Emit an event every 20 minutes for 2 hours — well past the 1-hour
    // notify threshold, but never idle for more than 20 minutes at a time.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(20 * 60 * 1000);
      emitSessionEvent(sessionManager, 'sess-1', 'text');
    }

    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
    expect(monitor.isTracking('sess-1')).toBe(true);
  });

  it('flags a session with no events for longer than the notify threshold', () => {
    const { broadcast, sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-1',
      taskName: 'Groom milestone X',
    });

    vi.advanceTimersByTime(NOTIFY_MS + 1000);

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified', sessionId: 'sess-1' }),
    );
  });

  it('applies the same activity-based behaviour to the pause threshold', () => {
    const { broadcast, sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-1',
      taskName: 'Groom milestone X',
    });

    // Keep the session active every 5 hours (well under the 20-hour pause
    // threshold) for 40 hours straight.
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(5 * 60 * 60 * 1000);
      emitSessionEvent(sessionManager, 'sess-1', 'tool_use');
    }

    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_paused' }),
    );
    expect(insertPauseInterval).not.toHaveBeenCalledWith(
      'sess-1',
      'stuck_timeout',
    );

    // But an inert session still pauses at the full threshold.
    vi.advanceTimersByTime(PAUSE_MS + 1000);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_paused', sessionId: 'sess-1' }),
    );
  });

  it('covers a planning session via activity alone, with no PR-related event', () => {
    // A groom/design/ops session never emits pr_created, push_detected, or a
    // review verdict — only session_event. Activity resets must not depend
    // on any of those.
    const { broadcast, sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'groom-1',
      taskName: 'Groom milestone Y',
    });

    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(50 * 60 * 1000);
      emitSessionEvent(sessionManager, 'groom-1', 'other');
    }

    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
  });

  it('still cancels timers for pr_created / push_detected on a code session', () => {
    const { broadcast, sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-code',
      taskName: 'Code task',
    });

    sessionManager.emit('message', { type: 'pr_created', sessionId: 'sess-code' });

    // Even far past both thresholds, nothing fires because the timers are
    // suspended for review.
    vi.advanceTimersByTime(PAUSE_MS * 2);

    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_paused' }),
    );
  });

  it('does not let post-suspension activity re-arm a session awaiting review', () => {
    const { broadcast, sessionManager } = makeMonitor();
    sessionManager.emit('message', {
      type: 'session_started',
      sessionId: 'sess-code',
      taskName: 'Code task',
    });
    sessionManager.emit('message', { type: 'pr_created', sessionId: 'sess-code' });

    // Activity after suspension (e.g. a late system event) must not re-arm.
    emitSessionEvent(sessionManager, 'sess-code', 'other');
    vi.advanceTimersByTime(NOTIFY_MS + 1000);

    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_notified' }),
    );
  });

  it('rehydrates an activity-based deadline across a restart without resetting it', () => {
    const now = Date.now();
    vi.mocked(getAllStuckSessionTimers).mockReturnValue([
      {
        session_id: 'sess-restored',
        task_name: 'Groom milestone Z',
        notify_deadline: now + 5000,
        pause_deadline: now + PAUSE_MS,
        hard_stop_deadline: 0,
        hard_stop_armed: 0,
        notify_remaining_ms: null,
        pause_remaining_ms: null,
        hard_stop_remaining_ms: null,
        suspended: 0,
      },
    ]);
    const { monitor, broadcast } = makeMonitor();

    monitor.rehydrate();
    expect(monitor.isTracking('sess-restored')).toBe(true);

    // The persisted deadline (5s out), not a fresh full threshold, is honored.
    vi.advanceTimersByTime(5001);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stuck_session_notified',
        sessionId: 'sess-restored',
      }),
    );
  });
});
