/**
 * PATCH /api/sessions/:id/archive — archiving is one of the terminal-ish
 * transitions that flips isSessionComplete for good (see
 * resolveSessionCompleteForDisplay), but when the session has no live
 * in-memory handle (the common case: archiving an already-done/killed row
 * long after the process exited), archiveAndEndSession's endSession() call
 * produces no session_status/session_ended WS traffic at all — there's
 * nothing else to correct a connected client's stale sessionComplete
 * snapshot. The archive route must broadcast the session_completeness
 * signal itself.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { sessionsRouter, setBroadcast } from '../sessions';
import { insertSession } from '../../db/queries';
import type { ServerMessage } from '../../ws/types';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  setBroadcast(() => {});
});

describe('PATCH /api/sessions/:id/archive — session_completeness broadcast', () => {
  it('broadcasts complete:true for an already-terminal session with no live handle', async () => {
    insertSession({
      session_id: 'sess-archive-1',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.now(),
    });

    const broadcast = vi.fn();
    setBroadcast(broadcast);
    // No setSessionManager call — mirrors a session with no live in-memory
    // handle, the case that previously produced zero WS traffic at all.

    const app = buildApp();
    const res = await supertest(app).patch(
      '/api/sessions/sess-archive-1/archive',
    );

    expect(res.status).toBe(200);
    expect(broadcast).toHaveBeenCalledWith({
      type: 'session_completeness',
      sessionId: 'sess-archive-1',
      complete: true,
    } satisfies ServerMessage);
  });

  it('broadcasts complete:true for an archived, still-non-terminal-status session', async () => {
    insertSession({
      session_id: 'sess-archive-2',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'idle',
      started_at: Date.now(),
    });

    const broadcast = vi.fn();
    setBroadcast(broadcast);

    const app = buildApp();
    const res = await supertest(app).patch(
      '/api/sessions/sess-archive-2/archive',
    );

    expect(res.status).toBe(200);
    expect(broadcast).toHaveBeenCalledWith({
      type: 'session_completeness',
      sessionId: 'sess-archive-2',
      complete: true,
    } satisfies ServerMessage);
  });

  it('returns 404 for an unknown session without broadcasting', async () => {
    const broadcast = vi.fn();
    setBroadcast(broadcast);

    const app = buildApp();
    const res = await supertest(app).patch(
      '/api/sessions/does-not-exist/archive',
    );

    expect(res.status).toBe(404);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
