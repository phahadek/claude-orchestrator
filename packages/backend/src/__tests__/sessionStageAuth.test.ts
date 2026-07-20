import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import {
  mintStageCredential,
  revokeStageCredential,
  requireSessionStageAuth,
  _resetStageCredentialsForTesting,
} from '../auth/SessionStageAuth';

/** Only the stage endpoint should ever be wired to requireSessionStageAuth. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/stage-only', requireSessionStageAuth, (_req, res) =>
    res.json({ ok: true }),
  );
  // A route representing everywhere else — never wired to session stage auth
  // in production, but used here to prove the credential is meaningless there.
  app.get('/api/elsewhere', (_req, res) => res.json({ ok: true, open: true }));
  return app;
}

describe('SessionStageAuth — requireSessionStageAuth middleware', () => {
  beforeEach(() => {
    _resetStageCredentialsForTesting();
  });

  it('accepts a valid session stage credential on the stage endpoint', async () => {
    const token = mintStageCredential('session-1');
    const res = await supertest(buildApp())
      .get('/api/stage-only')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects an absent credential on the stage endpoint', async () => {
    const res = await supertest(buildApp()).get('/api/stage-only');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('stage_credential_required');
  });

  it('rejects an invalid/unknown credential on the stage endpoint', async () => {
    const res = await supertest(buildApp())
      .get('/api/stage-only')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_stage_credential');
  });

  it('rejects a revoked credential on the stage endpoint', async () => {
    const token = mintStageCredential('session-2');
    revokeStageCredential('session-2');
    const res = await supertest(buildApp())
      .get('/api/stage-only')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('is only meaningful where wired: a valid session credential grants nothing on an endpoint the middleware is not mounted on', async () => {
    // /api/elsewhere is not gated by requireSessionStageAuth at all — this
    // documents that the credential's authority comes entirely from where
    // the middleware is (deliberately) wired, not from the token itself.
    const token = mintStageCredential('session-3');
    const res = await supertest(buildApp())
      .get('/api/elsewhere')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.open).toBe(true);
  });

  it('mintStageCredential is idempotent per session id', () => {
    const t1 = mintStageCredential('session-4');
    const t2 = mintStageCredential('session-4');
    expect(t1).toBe(t2);
  });

  it('rejects a valid credential from a non-loopback remote address', () => {
    const token = mintStageCredential('session-5');
    const req = {
      headers: { authorization: `Bearer ${token}` },
      socket: { remoteAddress: '10.0.0.5' },
    } as unknown as Parameters<typeof requireSessionStageAuth>[0];
    let statusCode: number | undefined;
    let body: unknown;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as Parameters<typeof requireSessionStageAuth>[1];
    let nextCalled = false;
    requireSessionStageAuth(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(403);
    expect((body as { code: string }).code).toBe('stage_loopback_only');
  });
});
