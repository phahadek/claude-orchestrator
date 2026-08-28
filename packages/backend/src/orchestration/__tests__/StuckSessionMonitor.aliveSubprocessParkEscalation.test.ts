import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../config.js', () => ({
  runtimeSettings: {
    session_alive_park_escalation_seconds: 900,
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
  getStuckAliveSubprocessParkRows: vi.fn().mockReturnValue([]),
  markSessionDone: vi.fn(),
  markSessionIdle: vi.fn(),
  getSession: vi.fn(),
  getProjectRowById: vi.fn(),
}));

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../../session/processLiveness', () => ({
  isSessionProcessAlive: vi.fn().mockReturnValue(true),
}));

import { recordEvent } from '../../audit/AuditLog';
import { isSessionProcessAlive } from '../../session/processLiveness';
import { getStuckAliveSubprocessParkRows } from '../../db/queries.js';
import { runtimeSettings } from '../../config.js';
import { StuckSessionMonitor } from '../StuckSessionMonitor.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSessionManager() {
  return {
    on: vi.fn(),
    send: vi.fn(),
    isAlive: vi.fn().mockReturnValue(true),
    markSessionErrored: vi.fn(),
    endSession: vi.fn(),
    reclaimSessionProcess: vi.fn(),
  } as unknown as import('../../session/SessionManager').SessionManager;
}

function makeMonitor() {
  const broadcast = vi.fn();
  const sessionManager = makeSessionManager();
  const monitor = new StuckSessionMonitor(sessionManager, broadcast);
  return { monitor, broadcast, sessionManager };
}

const NOW = 1_800_000_000_000;
const BOUND_MS = 900 * 1000;

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-1',
    task_id: 'task-1',
    project_id: 'proj-1',
    pr_url: null,
    worktree_path: '/worktree',
    session_type: 'standard',
    parked_at: NOW - BOUND_MS - 1000,
    latest_event_ts: NOW - BOUND_MS - 1000,
    ...overrides,
  };
}

describe('StuckSessionMonitor — stuck_session_alive_subprocess park escalation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isSessionProcessAlive).mockReturnValue(true);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('escalates a park whose subprocess is still alive past the bound with no new events', async () => {
    vi.mocked(getStuckAliveSubprocessParkRows).mockReturnValue([
      makeRow(),
    ] as never);
    const { monitor, sessionManager } = makeMonitor();

    await (monitor as any).scanForStuckAliveSubprocessParks();

    expect(sessionManager.markSessionErrored).not.toHaveBeenCalled();
    expect(sessionManager.endSession).not.toHaveBeenCalled();
    expect(sessionManager.reclaimSessionProcess).toHaveBeenCalledWith('sess-1');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'stuck_session_alive_park_escalated',
        actor_id: 'sess-1',
        payload: expect.objectContaining({
          session_id: 'sess-1',
          outcome: 'process_reclaimed',
        }),
      }),
    );
  });

  it('does not escalate a park still within the configured bound', async () => {
    vi.mocked(getStuckAliveSubprocessParkRows).mockReturnValue([
      makeRow({
        parked_at: NOW - 1000,
        latest_event_ts: NOW - 1000,
      }),
    ] as never);
    const { monitor, sessionManager } = makeMonitor();

    await (monitor as any).scanForStuckAliveSubprocessParks();

    expect(sessionManager.markSessionErrored).not.toHaveBeenCalled();
    expect(sessionManager.endSession).not.toHaveBeenCalled();
    expect(sessionManager.reclaimSessionProcess).not.toHaveBeenCalled();
  });

  it('does not escalate when the newest event is within the bound, however old parked_at is', async () => {
    vi.mocked(getStuckAliveSubprocessParkRows).mockReturnValue([
      makeRow({ latest_event_ts: NOW - 10 }),
    ] as never);
    const { monitor, sessionManager } = makeMonitor();

    await (monitor as any).scanForStuckAliveSubprocessParks();

    expect(sessionManager.markSessionErrored).not.toHaveBeenCalled();
    expect(sessionManager.reclaimSessionProcess).not.toHaveBeenCalled();
  });

  it('escalates a resumed session whose newest event is after sessions.ended_at but still past the bound', async () => {
    // Regression case: the resume's fresh hook events land ~1s after the
    // park itself, well within the bound, while ended_at (no longer read)
    // still carries the original clean-exit instant from long before the
    // park. Silence since the newest event — not ended_at, not parked_at —
    // is what must decide this.
    vi.mocked(getStuckAliveSubprocessParkRows).mockReturnValue([
      makeRow({
        parked_at: NOW - BOUND_MS - 1000,
        latest_event_ts: NOW - BOUND_MS - 999,
      }),
    ] as never);
    const { monitor, sessionManager } = makeMonitor();

    await (monitor as any).scanForStuckAliveSubprocessParks();

    expect(sessionManager.markSessionErrored).not.toHaveBeenCalled();
    expect(sessionManager.endSession).not.toHaveBeenCalled();
    expect(sessionManager.reclaimSessionProcess).toHaveBeenCalledWith('sess-1');
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'stuck_session_alive_park_escalated',
        actor_id: 'sess-1',
      }),
    );
  });

  it('does not escalate when the subprocess has already exited', async () => {
    vi.mocked(getStuckAliveSubprocessParkRows).mockReturnValue([
      makeRow(),
    ] as never);
    vi.mocked(isSessionProcessAlive).mockReturnValue(false);
    const { monitor, sessionManager } = makeMonitor();

    await (monitor as any).scanForStuckAliveSubprocessParks();

    expect(sessionManager.markSessionErrored).not.toHaveBeenCalled();
    expect(sessionManager.reclaimSessionProcess).not.toHaveBeenCalled();
  });

  it('is a no-op when the escalation bound is disabled (0)', async () => {
    const original = runtimeSettings.session_alive_park_escalation_seconds;
    (runtimeSettings as any).session_alive_park_escalation_seconds = 0;
    try {
      vi.mocked(getStuckAliveSubprocessParkRows).mockReturnValue([
        makeRow(),
      ] as never);
      const { monitor, sessionManager } = makeMonitor();

      await (monitor as any).scanForStuckAliveSubprocessParks();

      expect(sessionManager.markSessionErrored).not.toHaveBeenCalled();
      expect(sessionManager.reclaimSessionProcess).not.toHaveBeenCalled();
      expect(getStuckAliveSubprocessParkRows).not.toHaveBeenCalled();
    } finally {
      (runtimeSettings as any).session_alive_park_escalation_seconds = original;
    }
  });

  it.each(['groom', 'review', 'standard'])(
    'escalates regardless of session type (%s)',
    async (sessionType) => {
      vi.mocked(getStuckAliveSubprocessParkRows).mockReturnValue([
        makeRow({ session_type: sessionType }),
      ] as never);
      const { monitor, sessionManager } = makeMonitor();

      await (monitor as any).scanForStuckAliveSubprocessParks();

      expect(sessionManager.markSessionErrored).not.toHaveBeenCalled();
      expect(sessionManager.reclaimSessionProcess).toHaveBeenCalledWith(
        'sess-1',
      );
    },
  );
});
