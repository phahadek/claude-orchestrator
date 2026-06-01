import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../db/db.js', async () => {
  const Database = (await import('better-sqlite3')).default;
  const memDb = new Database(':memory:');
  memDb.pragma('foreign_keys = ON');
  const { applyTestSchema } = await import('../../test/helpers/testDbSchema');
  applyTestSchema(memDb);
  return { db: memDb };
});

vi.mock('../session/sessionRecovery', () => ({
  recoverSession: vi.fn(async () => {}),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(() => ({
    type: 'notion',
    fetchReadyTasks: vi.fn(async () => []),
    attachPR: vi.fn(async () => {}),
    updateStatus: vi.fn(async () => {}),
    fetchTaskPage: vi.fn(async () => ''),
    fetchNonMilestoneTasks: vi.fn(async () => []),
  })),
}));

vi.mock('../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
}));

// Stub DB ops that StuckSessionMonitor calls through its event handlers
vi.mock('../db/queries', async () => {
  const actual = await vi.importActual<typeof import('../db/queries')>(
    '../db/queries',
  );
  return {
    ...actual,
    getPRBySessionId: vi.fn(() => null),
    setPauseReason: vi.fn(),
    insertPauseInterval: vi.fn(),
    closePauseInterval: vi.fn(),
    upsertStuckSessionTimer: vi.fn(),
    deleteStuckSessionTimer: vi.fn(),
    getAllStuckSessionTimers: vi.fn(() => []),
  };
});

import { StuckSessionMonitor } from '../orchestration/StuckSessionMonitor';
import type { SessionManager } from '../session/SessionManager';
import { recoverSession } from '../session/sessionRecovery';
import { db } from '../db/db.js';

function makeMockSessionManager(): SessionManager {
  const sm = new EventEmitter() as unknown as SessionManager;
  (sm as unknown as { send: ReturnType<typeof vi.fn> }).send = vi.fn();
  (sm as unknown as { kill: ReturnType<typeof vi.fn> }).kill = vi
    .fn()
    .mockResolvedValue(undefined);
  return sm;
}

function insertStuckSession(
  sessionId: string,
  projectId: string,
  ageMs: number,
  sessionType = 'standard',
): void {
  const startedAt = Date.now() - ageMs;
  const lastEventTs = startedAt + Math.floor(ageMs / 2);
  db.prepare(
    `INSERT INTO sessions (session_id, project_id, task_id, task_url, project_context_url,
       status, started_at, session_type, worktree_path)
     VALUES (?, ?, 'task-1', 'https://notion.so/task', 'https://notion.so/ctx',
       'running', ?, ?, '/fake/wt')`,
  ).run(sessionId, projectId, startedAt, sessionType);
  db.prepare(
    `INSERT INTO session_events (session_id, event_type, payload, timestamp)
     VALUES (?, 'result', '{}', ?)`,
  ).run(sessionId, lastEventTs);
}

beforeEach(() => {
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM sessions').run();
  vi.clearAllMocks();
});

describe('StuckSessionMonitor.scanForStuckSessions() — periodic recovery', () => {
  it('calls recoverSession with scope=periodic for a session older than 5 minutes', async () => {
    insertStuckSession('sess-old', 'proj-1', 10 * 60 * 1000);

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());
    await monitor.scanForStuckSessions();

    expect(recoverSession).toHaveBeenCalledWith(
      'sess-old',
      expect.objectContaining({ scope: 'periodic' }),
    );
  });

  it('marks the session as done in the DB before calling recoverSession', async () => {
    insertStuckSession('sess-done', 'proj-1', 10 * 60 * 1000);

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());
    await monitor.scanForStuckSessions();

    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('sess-done') as { status: string } | undefined;
    expect(row?.status).toBe('done');
  });

  it('skips sessions younger than 5 minutes', async () => {
    insertStuckSession('sess-young', 'proj-1', 2 * 60 * 1000);

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());
    await monitor.scanForStuckSessions();

    expect(recoverSession).not.toHaveBeenCalled();

    const row = db
      .prepare('SELECT status FROM sessions WHERE session_id = ?')
      .get('sess-young') as { status: string } | undefined;
    expect(row?.status).toBe('running');
  });

  it('handles multiple stuck sessions in a single scan', async () => {
    insertStuckSession('sess-a', 'proj-1', 15 * 60 * 1000);
    insertStuckSession('sess-b', 'proj-1', 20 * 60 * 1000);

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());
    await monitor.scanForStuckSessions();

    expect(recoverSession).toHaveBeenCalledTimes(2);
    expect(recoverSession).toHaveBeenCalledWith(
      'sess-a',
      expect.objectContaining({ scope: 'periodic' }),
    );
    expect(recoverSession).toHaveBeenCalledWith(
      'sess-b',
      expect.objectContaining({ scope: 'periodic' }),
    );
  });

  it('passes sessionType from session row — review session skips standard-only side effects via helper gating', async () => {
    insertStuckSession('sess-review', 'proj-1', 10 * 60 * 1000, 'review');

    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());
    await monitor.scanForStuckSessions();

    expect(recoverSession).toHaveBeenCalledWith(
      'sess-review',
      expect.objectContaining({ scope: 'periodic', sessionType: 'review' }),
    );
  });

  it('does nothing when no stuck sessions exist', async () => {
    const sm = makeMockSessionManager();
    const monitor = new StuckSessionMonitor(sm, vi.fn());
    await monitor.scanForStuckSessions();

    expect(recoverSession).not.toHaveBeenCalled();
  });
});
