import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import supertest from 'supertest';

// ── AC: runMigrations() adds note and tags columns idempotently ─────────────

describe('runMigrations() — note/tags columns', () => {
  it('adds note column with try/catch for idempotency', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    expect(source).toMatch(/ALTER TABLE sessions ADD COLUMN.*note TEXT/);
  });

  it('adds tags column with try/catch for idempotency', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    expect(source).toMatch(/ALTER TABLE sessions ADD COLUMN.*tags TEXT/);
  });

  it('wraps each ALTER TABLE in try/catch', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    // Both must be wrapped (count try blocks that mention note/tags)
    const noteMatch = source.match(/try\s*\{[^}]*note[^}]*\}/s);
    const tagsMatch = source.match(/try\s*\{[^}]*tags[^}]*\}/s);
    expect(noteMatch).not.toBeNull();
    expect(tagsMatch).not.toBeNull();
  });
});

// ── AC: PATCH /api/sessions/:id/tags + note endpoints ──────────────────────

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
}));

import { sessionsRouter, setBroadcast } from '../routes/sessions';
import * as queries from '../db/queries';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  return app;
}

const mockSession = {
  session_id: 'test-session-1',
  task_id: null,
  task_url: null,
  project_context_url: null,
  project_id: null,
  status: 'done',
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
});

describe('PATCH /api/sessions/:id/tags', () => {
  it('returns 404 if session not found', async () => {
    vi.mocked(queries.getSession).mockReturnValue(undefined);
    const res = await supertest(buildApp())
      .patch('/api/sessions/missing/tags')
      .send({ tags: ['bugfix'] });
    expect(res.status).toBe(404);
  });

  it('persists tags array and returns 200', async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    const res = await supertest(buildApp())
      .patch('/api/sessions/test-session-1/tags')
      .send({ tags: ['bugfix', 'auth'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(queries.setSessionTags).toHaveBeenCalledWith('test-session-1', [
      'bugfix',
      'auth',
    ]);
  });

  it('coerces non-array tags body to empty array', async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    const res = await supertest(buildApp())
      .patch('/api/sessions/test-session-1/tags')
      .send({ tags: 'not-an-array' });
    expect(res.status).toBe(200);
    expect(queries.setSessionTags).toHaveBeenCalledWith('test-session-1', []);
  });

  it('broadcasts session_updated after persisting tags', async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    const broadcasts: unknown[] = [];
    setBroadcast((msg) => broadcasts.push(msg));
    await supertest(buildApp())
      .patch('/api/sessions/test-session-1/tags')
      .send({ tags: ['fix'] });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: 'session_updated',
      sessionId: 'test-session-1',
      tags: ['fix'],
    });
  });
});

describe('PATCH /api/sessions/:id/note', () => {
  it('returns 404 if session not found', async () => {
    vi.mocked(queries.getSession).mockReturnValue(undefined);
    const res = await supertest(buildApp())
      .patch('/api/sessions/missing/note')
      .send({ note: 'hello' });
    expect(res.status).toBe(404);
  });

  it('sets a note and returns 200', async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    const res = await supertest(buildApp())
      .patch('/api/sessions/test-session-1/note')
      .send({ note: 'my note' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(queries.setSessionNote).toHaveBeenCalledWith(
      'test-session-1',
      'my note',
    );
  });

  it('sets null to clear note', async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    const res = await supertest(buildApp())
      .patch('/api/sessions/test-session-1/note')
      .send({ note: null });
    expect(res.status).toBe(200);
    expect(queries.setSessionNote).toHaveBeenCalledWith('test-session-1', null);
  });

  it('defaults to null when note is omitted', async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    const res = await supertest(buildApp())
      .patch('/api/sessions/test-session-1/note')
      .send({});
    expect(res.status).toBe(200);
    expect(queries.setSessionNote).toHaveBeenCalledWith('test-session-1', null);
  });

  it('broadcasts session_updated after persisting note', async () => {
    vi.mocked(queries.getSession).mockReturnValue(mockSession as never);
    const broadcasts: unknown[] = [];
    setBroadcast((msg) => broadcasts.push(msg));
    await supertest(buildApp())
      .patch('/api/sessions/test-session-1/note')
      .send({ note: null });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: 'session_updated',
      sessionId: 'test-session-1',
      note: null,
    });
  });
});
