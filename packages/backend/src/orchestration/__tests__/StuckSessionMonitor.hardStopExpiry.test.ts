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
  isSessionProcessAlive: vi.fn().mockReturnValue(false),
}));

import { getSession, archiveSession } from '../../db/queries.js';
import { isSessionProcessAlive } from '../../session/processLiveness';
import { StuckSessionMonitor } from '../StuckSessionMonitor.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSessionManager() {
  return {
    on: vi.fn(),
    send: vi.fn().mockReturnValue(true),
    kill: vi.fn().mockResolvedValue(undefined),
    reclaimSessionProcess: vi.fn(),
  } as unknown as import('../../session/SessionManager').SessionManager;
}

function makeMonitor() {
  const broadcast = vi.fn();
  const sessionManager = makeSessionManager();
  const monitor = new StuckSessionMonitor(sessionManager, broadcast);
  return { monitor, broadcast, sessionManager };
}

function seedTimerState(
  monitor: StuckSessionMonitor,
  sessionId: string,
  pendingToolUseCount: number,
) {
  (monitor as unknown as { timers: Map<string, unknown> }).timers.set(
    sessionId,
    {
      taskName: 'Test Task',
      notifyTimer: null,
      pauseTimer: null,
      hardStopTimer: null,
      notifyDeadline: 0,
      pauseDeadline: 0,
      hardStopDeadline: Date.now(),
      notifyRemainingMs: null,
      pauseRemainingMs: null,
      hardStopRemainingMs: null,
      hardStopArmed: true,
      suspended: false,
      lastActivityAt: Date.now(),
      pendingToolUseCount,
      lastNotifyCheckedFlagged: false,
    },
  );
}

function callExpiry(monitor: StuckSessionMonitor, sessionId: string) {
  (
    monitor as unknown as {
      handleHardStopWindowExpiry: (id: string) => void;
    }
  ).handleHardStopWindowExpiry(sessionId);
}

describe('StuckSessionMonitor hard-stop window expiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockReturnValue({ session_id: 'sess-1' } as never);
    vi.mocked(isSessionProcessAlive).mockReturnValue(false);
  });

  it('surfaces to the operator (reclaim + archive, never kill) a session that went completely silent — no in-flight tool_use', () => {
    const { monitor, broadcast, sessionManager } = makeMonitor();
    seedTimerState(monitor, 'sess-silent', 0);

    callExpiry(monitor, 'sess-silent');

    expect(sessionManager.kill).not.toHaveBeenCalled();
    expect(sessionManager.reclaimSessionProcess).toHaveBeenCalledWith(
      'sess-silent',
    );
    expect(archiveSession).toHaveBeenCalledWith('sess-silent', 'machine_park');
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stuck_session_killed',
        sessionId: 'sess-silent',
      }),
    );
  });

  it('disarms without escalating when a tool_use is in flight and the process is alive', () => {
    vi.mocked(isSessionProcessAlive).mockReturnValue(true);
    const { monitor, broadcast, sessionManager } = makeMonitor();
    seedTimerState(monitor, 'sess-busy', 1);

    callExpiry(monitor, 'sess-busy');

    expect(sessionManager.kill).not.toHaveBeenCalled();
    expect(sessionManager.reclaimSessionProcess).not.toHaveBeenCalled();
    expect(archiveSession).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'stuck_session_killed' }),
    );
    const state = (
      monitor as unknown as {
        timers: Map<string, { hardStopArmed: boolean }>;
      }
    ).timers.get('sess-busy');
    expect(state?.hardStopArmed).toBe(false);
  });

  it('surfaces a session with a pendingToolUseCount but whose OS process has actually exited', () => {
    vi.mocked(isSessionProcessAlive).mockReturnValue(false);
    const { monitor, sessionManager } = makeMonitor();
    seedTimerState(monitor, 'sess-crashed', 1);

    callExpiry(monitor, 'sess-crashed');

    expect(sessionManager.kill).not.toHaveBeenCalled();
    expect(sessionManager.reclaimSessionProcess).toHaveBeenCalledWith(
      'sess-crashed',
    );
    expect(archiveSession).toHaveBeenCalledWith('sess-crashed', 'machine_park');
  });

  it('is a no-op if the timer state was already cleared', () => {
    const { monitor, sessionManager } = makeMonitor();

    expect(() => callExpiry(monitor, 'sess-unknown')).not.toThrow();
    expect(sessionManager.kill).not.toHaveBeenCalled();
    expect(sessionManager.reclaimSessionProcess).not.toHaveBeenCalled();
  });

  it('does not escalate an already-terminal session, and clears its timer instead', () => {
    vi.mocked(getSession).mockReturnValue({
      session_id: 'sess-done',
      status: 'done',
    } as never);
    const { monitor, sessionManager } = makeMonitor();
    seedTimerState(monitor, 'sess-done', 0);

    callExpiry(monitor, 'sess-done');

    expect(sessionManager.kill).not.toHaveBeenCalled();
    expect(sessionManager.reclaimSessionProcess).not.toHaveBeenCalled();
    expect(monitor.isTracking('sess-done')).toBe(false);
  });
});
