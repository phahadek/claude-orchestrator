import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import {
  mintStageCredential,
  revokeStageCredential,
  requireSessionStageAuth,
  _resetStageCredentialsForTesting,
  _simulateProcessRestartForTesting,
} from '../auth/SessionStageAuth';
import {
  getLatestEventByType,
  queryAuditLogByProject,
} from '../audit/AuditLog';

/** Mirrors the orchestrator MCP endpoint's own wiring (requireSessionStageAuth ahead of the handler). */
function buildMcpApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/mcp', requireSessionStageAuth, (req, res) => {
    const { sessionId } = (
      req as express.Request & { stageSession: { sessionId: string } }
    ).stageSession;
    res.json({ ok: true, sessionId });
  });
  return app;
}

describe('MCP session lifetime — dispatched session credential survives backend restarts', () => {
  beforeEach(() => {
    _resetStageCredentialsForTesting();
  });

  it('a tool call succeeds after a simulated backend restart that previously produced an expired-session error', async () => {
    const token = mintStageCredential('session-restart');
    const app = buildMcpApp();

    // Sanity: works before any restart.
    const before = await supertest(app)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(before.status).toBe(200);

    // Simulate the backend process restarting: the in-memory credential map
    // is wiped exactly as it would be by a fresh process, but the on-disk
    // mirror (written by mintStageCredential) survives.
    _simulateProcessRestartForTesting();

    const after = await supertest(app)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ ok: true, sessionId: 'session-restart' });
  });

  it('transparently recovers an expired in-memory credential and lets the original call through, without surfacing a bare error', async () => {
    const token = mintStageCredential('session-transparent');
    _simulateProcessRestartForTesting();

    // A single request, right after the simulated restart, must succeed
    // outright — recovery happens inside validateStageCredential's own
    // self-heal reload, not via a second request the caller has to retry.
    const res = await supertest(buildMcpApp())
      .post('/api/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('recovery holds across a turn boundary and a resume (repeated minting stays idempotent through a restart)', async () => {
    const token1 = mintStageCredential('session-turns');

    // Turn boundary: the session's runner re-mints before every attempt
    // (see AgentSession.ts) — idempotent, same token, no restart involved.
    const token2 = mintStageCredential('session-turns');
    expect(token2).toBe(token1);

    // A resume after a backend restart: the in-memory map is gone, but
    // minting again must still return the same token the running session's
    // already-written mcp config file carries — a *different* token here
    // would desync the running process's config from the server's idea of
    // the credential.
    _simulateProcessRestartForTesting();
    const token3 = mintStageCredential('session-turns');
    expect(token3).toBe(token1);

    const res = await supertest(buildMcpApp())
      .post('/api/mcp')
      .set('Authorization', `Bearer ${token1}`)
      .send({});
    expect(res.status).toBe(200);
  });

  it('an unrecoverable credential rejection is recorded as a distinct signal, separate from an empty audit query result', async () => {
    const projectId = 'proj-mcp-lifetime-test';

    // Nothing recorded yet for this project — the baseline "empty" case.
    expect(queryAuditLogByProject(projectId).entries).toEqual([]);

    const res = await supertest(buildMcpApp())
      .post('/api/mcp')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_stage_credential');

    // The rejection itself is a durable, queryable signal distinct from an
    // empty result — a caller correlating against process_boot/deploy_run
    // timing can find it independent of any one project's audit trail.
    const recorded = getLatestEventByType('mcp_stage_credential_rejected');
    expect(recorded).toBeDefined();
    expect(recorded?.actor_type).toBe('system');

    // The unrelated project's audit log is still genuinely empty — a
    // transport failure never gets mistaken for "the record contains
    // nothing" and vice versa.
    expect(queryAuditLogByProject(projectId).entries).toEqual([]);
  });

  it('a revoked credential is rejected even after a simulated restart, and stays session-scoped', async () => {
    const tokenA = mintStageCredential('session-a');
    const tokenB = mintStageCredential('session-b');

    revokeStageCredential('session-a');
    _simulateProcessRestartForTesting();

    const app = buildMcpApp();
    const revokedRes = await supertest(app)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});
    expect(revokedRes.status).toBe(401);

    // The other session's credential is untouched — revocation and restart
    // recovery are both scoped per session, never shared across sessions.
    const liveRes = await supertest(app)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({});
    expect(liveRes.status).toBe(200);
    expect(liveRes.body.sessionId).toBe('session-b');
  });
});
