/**
 * Tests for DELETE /api/sessions/:id — must evict the SessionManager's
 * in-memory entry for the session before/with the DB row delete, so a
 * lingering live session can never survive its own DB row's deletion and
 * block a future relaunch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../db/queries', () => ({
  getGrantedCapabilities: vi.fn(() => []),
  getSession: vi.fn(),
  getActiveSessions: vi.fn(() => []),
  getArchivedSessions: vi.fn(() => []),
  getSessionsByStatus: vi.fn(() => []),
  getSessionsByProject: vi.fn(() => []),
  deleteSession: vi.fn(),
  archiveSession: vi.fn(),
  unarchiveSession: vi.fn(),
  archiveFinishedSessions: vi.fn(() => 0),
  setSessionNote: vi.fn(),
  setSessionTags: vi.fn(),
  favoriteSession: vi.fn(),
  unfavoriteSession: vi.fn(),
}));

import {
  sessionsRouter,
  setBroadcast,
  setSessionManager,
} from '../routes/sessions';
import * as queries from '../db/queries';
import type { SessionManager } from '../session/SessionManager';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  return app;
}

const mockSession = {
  session_id: 'test-session-1',
  task_id: 'notion-task-id',
  task_url: null,
  project_context_url: null,
  project_id: null,
  status: 'idle',
  started_at: 1000000,
  ended_at: null,
  pr_url: null,
  worktree_path: null,
  archived: 0,
  note: null,
  tags: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  setBroadcast(() => {});
  setSessionManager(null as unknown as SessionManager);
});

describe('DELETE /api/sessions/:id', () => {
  it('returns 404 if session not found', async () => {
    vi.mocked(queries.getSession).mockReturnValue(undefined);
    const res = await supertest(buildApp()).delete('/api/sessions/missing');
    expect(res.status).toBe(404);
  });

  it('evicts the in-memory SessionManager entry before deleting the DB row', async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    const evictSession = vi.fn();
    setSessionManager({ evictSession } as unknown as SessionManager);

    const res = await supertest(buildApp()).delete(
      '/api/sessions/test-session-1',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 'test-session-1' });
    expect(evictSession).toHaveBeenCalledWith('test-session-1');
    expect(queries.deleteSession).toHaveBeenCalledWith('test-session-1');
  });

  it('still deletes the DB row when no SessionManager is registered', async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);

    const res = await supertest(buildApp()).delete(
      '/api/sessions/test-session-1',
    );

    expect(res.status).toBe(200);
    expect(queries.deleteSession).toHaveBeenCalledWith('test-session-1');
  });
});
