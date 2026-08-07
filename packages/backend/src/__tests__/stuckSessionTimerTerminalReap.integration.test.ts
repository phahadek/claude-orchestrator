/**
 * Integration test (real SQLite, real db/queries) proving the
 * stuck_session_timers row for a session is deleted once that session
 * reaches a terminal status by any path — not just the session_ended
 * broadcast clear() previously relied on exclusively.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../db/db.js', async () => {
  const { setupTestDb } = await import('../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

import { StuckSessionMonitor } from '../orchestration/StuckSessionMonitor';
import type { SessionManager } from '../session/SessionManager';
import { db } from '../db/db.js';
import { updateSessionStatus } from '../db/queries';

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

function insertRunningSession(sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, project_id, task_id, task_url, project_context_url,
       status, started_at, session_type, worktree_path)
     VALUES (?, 'proj-1', 'task-1', 'https://notion.so/task', 'https://notion.so/ctx',
       'running', ?, 'standard', '/fake/wt')`,
  ).run(sessionId, Date.now());
}

function timerRowExists(sessionId: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM stuck_session_timers WHERE session_id = ?`)
      .get(sessionId) !== undefined
  );
}

beforeEach(() => {
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM stuck_session_timers').run();
  db.prepare('DELETE FROM sessions').run();
  vi.clearAllMocks();
});

describe('StuckSessionMonitor — timer row cleared on terminal transition by any path', () => {
  it('deletes the persisted stuck_session_timers row once the session goes terminal via a watcher-style status write (not session_ended)', () => {
    const sessionId = 'sess-watcher-terminal';
    insertRunningSession(sessionId);

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());

    (sm as unknown as EventEmitter).emit('message', {
      type: 'session_started',
      sessionId,
      taskName: 'watcher task',
    });
    expect(timerRowExists(sessionId)).toBe(true);

    // Simulate a watcher-driven transition (pr_merge_watcher / auto_merger
    // style) that writes the terminal status directly, without ever
    // broadcasting session_ended.
    updateSessionStatus(sessionId, 'done', Date.now());

    (
      monitor as unknown as { reapTerminalTimers: () => void }
    ).reapTerminalTimers();

    expect(timerRowExists(sessionId)).toBe(false);
    expect(monitor.isTracking(sessionId)).toBe(false);

    monitor.stop();
  });

  it('leaves the timer row intact for a session still running', () => {
    const sessionId = 'sess-still-running';
    insertRunningSession(sessionId);

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());

    (sm as unknown as EventEmitter).emit('message', {
      type: 'session_started',
      sessionId,
      taskName: 'running task',
    });
    expect(timerRowExists(sessionId)).toBe(true);

    (
      monitor as unknown as { reapTerminalTimers: () => void }
    ).reapTerminalTimers();

    expect(timerRowExists(sessionId)).toBe(true);
    expect(monitor.isTracking(sessionId)).toBe(true);

    monitor.stop();
  });
});
