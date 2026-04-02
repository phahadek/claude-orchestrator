import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../db/queries', () => ({
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
  deleteDenialsBySession: vi.fn(),
  getEventsBySession: vi.fn(() => []),
}));

vi.mock('../utils/eventFilters', () => ({
  isSystemOnlyUserEvent: vi.fn(() => false),
}));

import { sessionsRouter, setBroadcast } from '../routes/sessions';
import * as queries from '../db/queries';
import * as eventFilters from '../utils/eventFilters';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  return app;
}

const mockSession = {
  session_id: 'test-session-1',
  notion_task_id: null,
  notion_task_url: 'https://notion.so/task-1',
  project_context_url: null,
  project_id: 'my-project',
  status: 'done',
  started_at: 1000000,
  ended_at: 2000000,
  pr_url: null,
  worktree_path: null,
  archived: 1,
  favorited: 0,
  note: null,
  tags: null,
};

const mockEvents = [
  {
    event_type: 'text',
    payload: '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}',
    timestamp: 1000100,
    message_id: 'msg-1',
  },
  {
    event_type: 'user_message',
    payload: '{"type":"user","message":{"content":[{"type":"text","text":"Hi"}]}}',
    timestamp: 1000050,
    message_id: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  setBroadcast(() => {});
});

describe('GET /api/sessions/:id/events', () => {
  it('returns 404 for a non-existent session ID', async () => {
    vi.mocked(queries.getSession).mockReturnValue(undefined);
    const res = await supertest(buildApp()).get('/api/sessions/nonexistent/events');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Session not found' });
  });

  it('returns 200 with { session, events } for an existing session', async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    vi.mocked(queries.getEventsBySession).mockReturnValue(mockEvents as never);
    const res = await supertest(buildApp()).get('/api/sessions/test-session-1/events');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('session');
    expect(res.body).toHaveProperty('events');
    expect(res.body.session.session_id).toBe('test-session-1');
    expect(res.body.events).toHaveLength(2);
  });

  it('maps event fields correctly including optional messageId', async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    vi.mocked(queries.getEventsBySession).mockReturnValue(mockEvents as never);
    const res = await supertest(buildApp()).get('/api/sessions/test-session-1/events');
    expect(res.status).toBe(200);
    const [ev0, ev1] = res.body.events;
    expect(ev0.eventType).toBe('text');
    expect(ev0.messageId).toBe('msg-1');
    expect(ev1.eventType).toBe('user_message');
    expect(ev1).not.toHaveProperty('messageId');
  });

  it('excludes system-only user events filtered by isSystemOnlyUserEvent', async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    vi.mocked(queries.getEventsBySession).mockReturnValue(mockEvents as never);
    vi.mocked(eventFilters.isSystemOnlyUserEvent)
      .mockReturnValueOnce(true)   // first event filtered out
      .mockReturnValueOnce(false); // second event kept
    const res = await supertest(buildApp()).get('/api/sessions/test-session-1/events');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].eventType).toBe('user_message');
  });
});
