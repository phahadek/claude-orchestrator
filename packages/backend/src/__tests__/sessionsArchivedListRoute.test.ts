/**
 * Route-level test for GET /api/sessions/archived: the route must fetch
 * last-activity via a single bulk lookup (getLastActivityMsForArchivedSessions)
 * rather than one getSessionLastActivityMs call per archived session — that
 * per-row fan-out is what previously saturated the event loop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { mockDbQueries } from './helpers/mockDbQueries';
import type { Session } from '../db/types';

const {
  mockGetArchivedSessions,
  mockGetLastActivityMsForArchivedSessions,
  mockGetSessionLastActivityMs,
} = vi.hoisted(() => ({
  mockGetArchivedSessions: vi.fn(),
  mockGetLastActivityMsForArchivedSessions: vi.fn(),
  mockGetSessionLastActivityMs: vi.fn(),
}));

vi.mock('../db/queries', () =>
  mockDbQueries({
    getArchivedSessions: mockGetArchivedSessions,
    getLastActivityMsForArchivedSessions:
      mockGetLastActivityMsForArchivedSessions,
    getSessionLastActivityMs: mockGetSessionLastActivityMs,
  }),
);

import { sessionsRouter } from '../routes/sessions';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  return app;
}

function fakeSession(id: string): Session {
  return {
    session_id: id,
    task_id: null,
    task_url: null,
    project_context_url: null,
    project_id: null,
    status: 'done',
    started_at: 1000,
    ended_at: 2000,
    worktree_path: null,
    archived: 1,
    favorited: 0,
    session_type: 'standard',
    note: null,
    tags: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    model: null,
    effort: null,
    task_name: null,
    pr_url: null,
  } as unknown as Session;
}

describe('GET /api/sessions/archived', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('issues exactly one bulk last-activity lookup regardless of how many archived sessions there are, and never falls back to the per-row lookup', async () => {
    const sessions = Array.from({ length: 50 }, (_, i) =>
      fakeSession(`sess-${i}`),
    );
    mockGetArchivedSessions.mockReturnValue(sessions);
    const activityMap = new Map(
      sessions.map((s, i) => [s.session_id, 5000 + i]),
    );
    mockGetLastActivityMsForArchivedSessions.mockReturnValue(activityMap);

    const res = await supertest(buildApp()).get('/api/sessions/archived');

    expect(res.status).toBe(200);
    expect(mockGetLastActivityMsForArchivedSessions).toHaveBeenCalledTimes(1);
    expect(mockGetSessionLastActivityMs).not.toHaveBeenCalled();
  });

  it('returns the same payload shape as before: each session plus lastActivityAgeMs derived from its last-activity timestamp', async () => {
    mockGetArchivedSessions.mockReturnValue([fakeSession('sess-1')]);
    mockGetLastActivityMsForArchivedSessions.mockReturnValue(
      new Map([['sess-1', 1_700_000_000_000]]),
    );

    const res = await supertest(buildApp()).get('/api/sessions/archived');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      session_id: 'sess-1',
      archived: 1,
    });
    expect(typeof res.body[0].lastActivityAgeMs).toBe('number');
    expect(res.body[0].lastActivityAgeMs).toBeGreaterThanOrEqual(0);
  });

  it('reports lastActivityAgeMs as null when the session has no recorded activity', async () => {
    mockGetArchivedSessions.mockReturnValue([fakeSession('sess-none')]);
    mockGetLastActivityMsForArchivedSessions.mockReturnValue(new Map());

    const res = await supertest(buildApp()).get('/api/sessions/archived');

    expect(res.status).toBe(200);
    expect(res.body[0].lastActivityAgeMs).toBeNull();
  });
});
