/**
 * Route-level test for PATCH /api/sessions/:id/archive: archiving is an
 * explicit operator signal that a session is done, so any subprocess still
 * live under it must be reaped too — otherwise an archived (dashboard-
 * invisible) row can keep holding a concurrency slot indefinitely, the same
 * leak markTerminal has for the orchestrator-declared-terminal path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockGetSession, mockArchiveSession } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockArchiveSession: vi.fn(),
}));

vi.mock('../db/queries', () => ({
  getSession: mockGetSession,
  getActiveSessions: vi.fn(),
  getArchivedSessions: vi.fn(),
  getSessionsByStatus: vi.fn(),
  getSessionsByProject: vi.fn(),
  deleteSession: vi.fn(),
  archiveSession: mockArchiveSession,
  unarchiveSession: vi.fn(),
  archiveFinishedSessions: vi.fn(),
  setSessionNote: vi.fn(),
  setSessionTags: vi.fn(),
  favoriteSession: vi.fn(),
  unfavoriteSession: vi.fn(),
  deleteDenialsBySession: vi.fn(),
  getEventsBySession: vi.fn(),
}));

vi.mock('../config', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('../tasks/TaskBackend', () => ({
  getTaskBackend: vi.fn(),
}));

import { sessionsRouter, setSessionManager } from '../routes/sessions';
import type { SessionManager } from '../session/SessionManager';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  return app;
}

describe('PATCH /api/sessions/:id/archive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockReturnValue({ session_id: 'sess-1', status: 'idle' });
  });

  it('ends the session in addition to archiving it, reaping a still-live subprocess', async () => {
    const endSession = vi.fn();
    setSessionManager({ endSession } as unknown as SessionManager);

    const res = await supertest(buildApp()).patch(
      '/api/sessions/sess-1/archive',
    );

    expect(res.status).toBe(200);
    expect(mockArchiveSession).toHaveBeenCalledWith('sess-1');
    expect(endSession).toHaveBeenCalledWith('sess-1');
  });

  it('404s without archiving or ending when the session does not exist', async () => {
    mockGetSession.mockReturnValue(undefined);
    const endSession = vi.fn();
    setSessionManager({ endSession } as unknown as SessionManager);

    const res = await supertest(buildApp()).patch(
      '/api/sessions/missing/archive',
    );

    expect(res.status).toBe(404);
    expect(mockArchiveSession).not.toHaveBeenCalled();
    expect(endSession).not.toHaveBeenCalled();
  });
});
