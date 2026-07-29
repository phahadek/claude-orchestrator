/**
 * PATCH /api/sessions/:id/capabilities/revoke — the operator revoke action
 * for a session's durable granted_capabilities set. Mirrors the tags
 * add/remove route pattern, but also records a capability_revoked audit
 * event since (unlike tags) there is no dedicated grant-side event today.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { sessionsRouter } from '../sessions';
import { insertSession, addGrantedCapability, getGrantedCapabilities } from '../../db/queries';
import { getAuditLogByActorId } from '../../audit/AuditLog';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('PATCH /api/sessions/:id/capabilities/revoke', () => {
  it('removes the capability and records a capability_revoked audit event', async () => {
    insertSession({
      session_id: 'sess-revoke-1',
      task_id: 'task:1',
      task_url: null,
      project_context_url: null,
      project_id: 'proj-1',
      status: 'running',
      started_at: Date.now(),
    });
    addGrantedCapability('sess-revoke-1', 'Bash(psql:*)');
    addGrantedCapability('sess-revoke-1', 'mcp__orchestrator__health');

    const app = buildApp();
    const res = await supertest(app)
      .patch('/api/sessions/sess-revoke-1/capabilities/revoke')
      .send({ capability: 'Bash(psql:*)' });

    expect(res.status).toBe(200);
    expect(res.body.grantedCapabilities).toEqual(['mcp__orchestrator__health']);
    expect(getGrantedCapabilities('sess-revoke-1')).toEqual([
      'mcp__orchestrator__health',
    ]);

    const events = getAuditLogByActorId('sess-revoke-1');
    const revokedEvent = events.find((e) => e.eventType === 'capability_revoked');
    expect(revokedEvent).toBeDefined();
    expect(revokedEvent?.payload).toEqual({ capability: 'Bash(psql:*)' });
  });

  it('returns 404 for an unknown session', async () => {
    const app = buildApp();
    const res = await supertest(app)
      .patch('/api/sessions/does-not-exist/capabilities/revoke')
      .send({ capability: 'Bash(psql:*)' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when capability is missing', async () => {
    insertSession({
      session_id: 'sess-revoke-2',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    const app = buildApp();
    const res = await supertest(app)
      .patch('/api/sessions/sess-revoke-2/capabilities/revoke')
      .send({});
    expect(res.status).toBe(400);
  });
});
