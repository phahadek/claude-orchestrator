/**
 * The own-record read surface a dispatched ops/gate-verify session's granted
 * `read:session-record:<target-session-id>` capability materialises: a
 * loopback-only, stage-credential-authed GET that returns the target
 * session's session_events + audit_log only once that exact capability has
 * been durably granted — the end-to-end request -> operator-approve ->
 * grant-on-re-dispatch loop this task exists to make functional.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { createSessionRecordReadRouter } from '../sessionRecordRead';
import {
  mintStageCredential,
  _resetStageCredentialsForTesting,
} from '../../auth/SessionStageAuth';
import { insertSession, insertEvent, addGrantedCapability } from '../../db/queries';
import { recordEvent } from '../../audit/AuditLog';
import { sessionRecordReadCapability } from '../../session/orchestrator-config';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createSessionRecordReadRouter());
  return app;
}

beforeEach(() => {
  _resetStageCredentialsForTesting();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM session_events').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('GET /api/session-record-reads/:targetSessionId', () => {
  it('returns the target session\'s session_events and audit_log once the exact capability is granted', async () => {
    insertSession({
      session_id: 'requester-1',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    insertSession({
      session_id: 'target-1',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.now(),
    });
    insertEvent({
      session_id: 'target-1',
      event_type: 'assistant',
      payload: JSON.stringify({ type: 'assistant', text: 'hi' }),
      timestamp: Date.now(),
    });
    recordEvent({
      event_type: 'gate_verify_dispatched',
      actor_type: 'session',
      actor_id: 'target-1',
      project_id: 'proj-1',
      task_id: 'notion:abc',
      payload: { note: 'dispatched' },
    });

    addGrantedCapability('requester-1', sessionRecordReadCapability('target-1'));
    const token = mintStageCredential('requester-1');

    const res = await supertest(buildApp())
      .get('/api/session-record-reads/target-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.session.session_id ?? res.body.session.sessionId).toBeTruthy();
    expect(res.body.events).toHaveLength(1);
    expect(res.body.auditLog).toHaveLength(1);
    expect(res.body.auditLog[0].eventType).toBe('gate_verify_dispatched');
  });

  it('rejects with 403 when the requester holds no matching grant', async () => {
    insertSession({
      session_id: 'requester-2',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    insertSession({
      session_id: 'target-2',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.now(),
    });
    const token = mintStageCredential('requester-2');

    const res = await supertest(buildApp())
      .get('/api/session-record-reads/target-2')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('capability_not_granted');
  });

  it('a grant for one target session id does not authorize reading a different session', async () => {
    insertSession({
      session_id: 'requester-3',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    insertSession({
      session_id: 'target-3',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.now(),
    });
    insertSession({
      session_id: 'other-target',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'done',
      started_at: Date.now(),
    });
    addGrantedCapability('requester-3', sessionRecordReadCapability('target-3'));
    const token = mintStageCredential('requester-3');

    const res = await supertest(buildApp())
      .get('/api/session-record-reads/other-target')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('rejects a request with no stage credential', async () => {
    const res = await supertest(buildApp()).get(
      '/api/session-record-reads/target-1',
    );
    expect(res.status).toBe(401);
  });

  it('404s when the granted target session id does not exist', async () => {
    insertSession({
      session_id: 'requester-4',
      task_id: null,
      task_url: null,
      project_context_url: null,
      status: 'running',
      started_at: Date.now(),
    });
    addGrantedCapability(
      'requester-4',
      sessionRecordReadCapability('nonexistent'),
    );
    const token = mintStageCredential('requester-4');

    const res = await supertest(buildApp())
      .get('/api/session-record-reads/nonexistent')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
