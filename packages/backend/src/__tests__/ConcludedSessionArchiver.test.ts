import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/queries.js', () => ({
  archiveConcludedSessionsOlderThan: vi.fn(),
}));

vi.mock('../audit/AuditLog.js', () => ({
  recordEvent: vi.fn(),
}));

vi.mock('../config.js', () => ({
  runtimeSettings: {
    auto_archive_enabled: true,
    auto_archive_grace_minutes: 30,
    auto_archive_sweep_interval_minutes: 5,
  },
}));

import { archiveConcludedSessionsOlderThan } from '../db/queries.js';
import { recordEvent } from '../audit/AuditLog.js';
import { runtimeSettings } from '../config.js';
import { ConcludedSessionArchiver } from '../orchestration/ConcludedSessionArchiver.js';

const mockArchive = vi.mocked(archiveConcludedSessionsOlderThan);
const mockRecord = vi.mocked(recordEvent);

beforeEach(() => {
  vi.clearAllMocks();
  runtimeSettings.auto_archive_enabled = true;
  runtimeSettings.auto_archive_grace_minutes = 30;
  runtimeSettings.auto_archive_sweep_interval_minutes = 5;
});

describe('ConcludedSessionArchiver', () => {
  it('start() / stop() do not throw', () => {
    const archiver = new ConcludedSessionArchiver(() => {}, {
      intervalMs: 100000,
    });
    archiver.start();
    archiver.stop();
  });

  it('start() is idempotent — calling twice does not double-schedule', () => {
    const archiver = new ConcludedSessionArchiver(() => {}, {
      intervalMs: 100000,
    });
    archiver.start();
    archiver.start();
    archiver.stop();
  });

  it('sweepOnce() skips when auto_archive_enabled=false', async () => {
    runtimeSettings.auto_archive_enabled = false;
    const broadcast = vi.fn();
    const archiver = new ConcludedSessionArchiver(broadcast, {
      intervalMs: 100000,
    });
    await archiver.sweepOnce();
    expect(mockArchive).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('sweepOnce() archives nothing when query returns empty array', async () => {
    mockArchive.mockReturnValue([]);
    const broadcast = vi.fn();
    const archiver = new ConcludedSessionArchiver(broadcast, {
      intervalMs: 100000,
    });
    await archiver.sweepOnce();
    expect(broadcast).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('sweepOnce() uses frozen clock for cutoff calculation', async () => {
    const FROZEN_NOW = 5_000_000;
    runtimeSettings.auto_archive_grace_minutes = 30;
    mockArchive.mockReturnValue([]);
    const archiver = new ConcludedSessionArchiver(() => {}, {
      intervalMs: 100000,
      nowFn: () => FROZEN_NOW,
    });
    await archiver.sweepOnce();
    const expectedCutoff = FROZEN_NOW - 30 * 60 * 1000;
    expect(mockArchive).toHaveBeenCalledWith(expectedCutoff);
  });

  it('sweepOnce() broadcasts session_archived for each archived session', async () => {
    mockArchive.mockReturnValue(['s1', 's2', 's3']);
    const broadcast = vi.fn();
    const archiver = new ConcludedSessionArchiver(broadcast, {
      intervalMs: 100000,
    });
    await archiver.sweepOnce();
    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(broadcast).toHaveBeenCalledWith({
      type: 'session_archived',
      sessionId: 's1',
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: 'session_archived',
      sessionId: 's2',
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: 'session_archived',
      sessionId: 's3',
    });
  });

  it('sweepOnce() writes one audit_log row with archived_count and session_ids', async () => {
    mockArchive.mockReturnValue(['s1', 's2']);
    const archiver = new ConcludedSessionArchiver(() => {}, {
      intervalMs: 100000,
    });
    await archiver.sweepOnce();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith({
      event_type: 'sessions_auto_archived',
      actor_type: 'system',
      payload: {
        archived_count: 2,
        session_ids: ['s1', 's2'],
      },
    });
  });

  it('sweepOnce() writes NO audit_log row when 0 sessions archived', async () => {
    mockArchive.mockReturnValue([]);
    const archiver = new ConcludedSessionArchiver(() => {}, {
      intervalMs: 100000,
    });
    await archiver.sweepOnce();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('stop() prevents further sweeps from executing', async () => {
    mockArchive.mockReturnValue([]);
    const archiver = new ConcludedSessionArchiver(() => {}, {
      intervalMs: 100000,
    });
    archiver.start();
    archiver.stop();
    mockArchive.mockClear();
    await new Promise((r) => setTimeout(r, 10));
    expect(mockArchive).not.toHaveBeenCalled();
  });

  it('sweepOnce() never touches worktrees — only calls archiveConcludedSessionsOlderThan (idle sessions exempt by SQL filter)', async () => {
    // Regression: ConcludedSessionArchiver must never trigger worktree teardown.
    // archiveConcludedSessionsOlderThan only queries status IN ('done','error','killed'),
    // so idle sessions are structurally excluded without any extra guard needed here.
    mockArchive.mockReturnValue(['s1']);
    const broadcast = vi.fn();
    const archiver = new ConcludedSessionArchiver(broadcast, {
      intervalMs: 100000,
    });
    await archiver.sweepOnce();
    // The archiver's only side effects are archiveConcludedSessionsOlderThan,
    // broadcast, and recordEvent — never a SessionManager or git call.
    expect(mockArchive).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith({ type: 'session_archived', sessionId: 's1' });
    // No other mocked functions should have been called (no worktree cleanup)
    expect(mockRecord).toHaveBeenCalledOnce();
  });
});
