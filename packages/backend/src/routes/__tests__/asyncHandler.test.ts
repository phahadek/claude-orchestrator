import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { asyncHandler, asyncErrorBoundary } from '../asyncHandler';
import { db } from '../../db/db';

function buildApp() {
  const app = express();

  app.get(
    '/rejects',
    asyncHandler(async () => {
      throw new Error('boom from rejection');
    }),
  );

  app.get(
    '/throws-sync',
    asyncHandler(async (_req, _res) => {
      // Thrown before any await — still caught because the handler body
      // runs inside the Promise.resolve(fn(...)) wrapper.
      throw new Error('boom from sync throw');
    }),
  );

  app.get(
    '/typed-4xx',
    asyncHandler(async (_req, res) => {
      res.status(409).json({ error: 'conflict' });
      throw new Error('should not affect the response already sent');
    }),
  );

  app.use(asyncErrorBoundary);

  return app;
}

describe('asyncHandler + asyncErrorBoundary', () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM audit_log`).run();
  });

  it('returns 500 for a rejected async handler instead of hanging', async () => {
    const res = await request(buildApp()).get('/rejects');
    expect(res.status).toBe(500);
  });

  it('returns 500 for a synchronously thrown error, identically', async () => {
    const res = await request(buildApp()).get('/throws-sync');
    expect(res.status).toBe(500);
  });

  it('does not leak a stack trace or raw error message in the response body', async () => {
    const res = await request(buildApp()).get('/rejects');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('boom from rejection');
    expect(body).not.toContain('.ts:');
    expect(body).not.toContain('at ');
  });

  it('logs and records exactly one audit event for the failure', async () => {
    await request(buildApp()).get('/rejects');
    const rows = db
      .prepare(`SELECT * FROM audit_log WHERE event_type = 'process_fault'`)
      .all();
    expect(rows).toHaveLength(1);
  });

  it('leaves a handler that already sent a typed 4xx response unaffected', async () => {
    const res = await request(buildApp()).get('/typed-4xx');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'conflict' });
    const rows = db
      .prepare(`SELECT * FROM audit_log WHERE event_type = 'process_fault'`)
      .all();
    expect(rows).toHaveLength(0);
  });

  it('delegates to the default Express error handler when headers are already sent', () => {
    let calledNext = false;
    const fakeErr = new Error('late failure');
    const fakeRes = {
      headersSent: true,
      status: () => {
        throw new Error('must not attempt to write a second response');
      },
    } as unknown as express.Response;
    const next = (err?: unknown) => {
      calledNext = true;
      expect(err).toBe(fakeErr);
    };

    asyncErrorBoundary(
      fakeErr,
      {} as express.Request,
      fakeRes,
      next as express.NextFunction,
    );

    expect(calledNext).toBe(true);
  });
});
