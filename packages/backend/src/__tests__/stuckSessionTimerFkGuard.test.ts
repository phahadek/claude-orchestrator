/**
 * Tests that StuckSessionMonitor.persistTimerState does not throw when
 * upsertStuckSessionTimer raises a FOREIGN KEY constraint error (session row
 * deleted before the timer fires).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const { mockUpsertStuckSessionTimer } = vi.hoisted(() => ({
  mockUpsertStuckSessionTimer: vi.fn(),
}));

vi.mock('../config', () => ({
  AUTO_REVIEW_ENABLED: false,
  runtimeSettings: {
    session_notify_threshold_seconds: 1,
    session_pause_threshold_seconds: 2,
    session_hard_stop_window_seconds: 1,
    max_concurrent_code_sessions: 20,
    auto_review_concurrency: 1,
    session_mode: 'cli',
    code_session_model: '',
    review_session_model: '',
    auto_launch_concurrency: 1,
    auto_launch_poll_interval_ms: 60000,
    ci_poll_interval_seconds: 30,
    ci_poll_max_minutes: 30,
    max_review_iterations: 3,
    auto_review: false,
    card_preview_lines: 3,
  },
}));

vi.mock('../db/queries', () => ({
  getPRBySessionId: vi.fn(() => null),
  setPauseReason: vi.fn(),
  insertPauseInterval: vi.fn(),
  closePauseInterval: vi.fn(),
  upsertStuckSessionTimer: mockUpsertStuckSessionTimer,
  deleteStuckSessionTimer: vi.fn(),
  getAllStuckSessionTimers: vi.fn(() => []),
  getStuckResultSessionRows: vi.fn(() => []),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
}));

vi.mock('../session/sessionRecovery', () => ({
  recoverSession: vi.fn(async () => {}),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(),
}));

import { StuckSessionMonitor } from '../orchestration/StuckSessionMonitor';
import type { SessionManager } from '../session/SessionManager';

function makeMockSessionManager(): SessionManager {
  const sm = new EventEmitter() as unknown as SessionManager;
  (sm as unknown as { send: ReturnType<typeof vi.fn> }).send = vi.fn();
  (sm as unknown as { kill: ReturnType<typeof vi.fn> }).kill = vi
    .fn()
    .mockResolvedValue(undefined);
  (sm as unknown as { isAlive: ReturnType<typeof vi.fn> }).isAlive = vi
    .fn()
    .mockReturnValue(false);
  return sm;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StuckSessionMonitor.persistTimerState — FK guard', () => {
  it('does not throw when upsertStuckSessionTimer raises a FOREIGN KEY constraint error', () => {
    const fkErr = Object.assign(new Error('FOREIGN KEY constraint failed'), {
      name: 'SqliteError',
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
    mockUpsertStuckSessionTimer.mockImplementation(() => {
      throw fkErr;
    });

    const sm = makeMockSessionManager();
    const broadcast = vi.fn();
    const monitor = new StuckSessionMonitor(sm, broadcast);

    // Trigger startTracking → scheduleNotifyAndPause → persistTimerState
    expect(() => {
      (sm as unknown as EventEmitter).emit('message', {
        type: 'session_started',
        sessionId: 'sess-fk-test',
        taskName: 'test task',
      });
    }).not.toThrow();

    expect(mockUpsertStuckSessionTimer).toHaveBeenCalledWith(
      'sess-fk-test',
      expect.any(String),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Boolean),
      null,
      null,
      null,
    );

    // Cleanup: clear timers
    monitor.stop();
  });

  it('does not produce an unhandled rejection when upsertStuckSessionTimer throws', async () => {
    const fkErr = Object.assign(new Error('FOREIGN KEY constraint failed'), {
      name: 'SqliteError',
    });
    mockUpsertStuckSessionTimer.mockImplementation(() => {
      throw fkErr;
    });

    let unhandled: Error | undefined;
    const onUnhandled = (e: Error) => {
      unhandled = e;
    };
    process.on('unhandledRejection', onUnhandled);

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());

    (sm as unknown as EventEmitter).emit('message', {
      type: 'session_started',
      sessionId: 'sess-fk-test-2',
      taskName: 'test task 2',
    });

    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', onUnhandled);
    monitor.stop();

    expect(unhandled).toBeUndefined();
  });
});

describe('StuckSessionMonitor.persistTimerState — normal case', () => {
  it('calls upsertStuckSessionTimer with the session state on startTracking', () => {
    mockUpsertStuckSessionTimer.mockImplementation(() => {});

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());

    (sm as unknown as EventEmitter).emit('message', {
      type: 'session_started',
      sessionId: 'sess-normal',
      taskName: 'normal task',
    });

    expect(mockUpsertStuckSessionTimer).toHaveBeenCalledWith(
      'sess-normal',
      'normal task',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      false,
      null,
      null,
      null,
    );

    monitor.stop();
  });
});
