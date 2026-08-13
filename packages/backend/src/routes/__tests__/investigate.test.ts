/**
 * Tests for POST /api/investigate/launch
 * (packages/backend/src/routes/investigate.ts) — the manual investigate
 * dispatch surface (operator-triggered, analog of POST /api/gate/verify-launch).
 *
 * AC: reportIds are forwarded to launchInvestigateBatch and the resulting
 * sessionId returned with a 202; a missing/empty reportIds[] 400s; a thrown
 * error (e.g. an unknown report id) surfaces as a 400.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const investigateDispatcherMock = vi.hoisted(() => ({
  launchInvestigateBatch: vi.fn(),
}));

vi.mock('../../investigation/investigateDispatcher.js', () => investigateDispatcherMock);

import { createInvestigateRouter } from '../investigate.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createInvestigateRouter({} as never));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/investigate/launch', () => {
  it('launches the given report ids and returns 202 with the sessionId', async () => {
    investigateDispatcherMock.launchInvestigateBatch.mockResolvedValue(
      'sess-1',
    );

    const res = await request(makeApp())
      .post('/api/investigate/launch')
      .send({ reportIds: ['r-1', 'r-2'] });

    expect(investigateDispatcherMock.launchInvestigateBatch).toHaveBeenCalledWith(
      {},
      ['r-1', 'r-2'],
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ sessionId: 'sess-1', reportIds: ['r-1', 'r-2'] });
  });

  it('400s on a missing reportIds[]', async () => {
    const res = await request(makeApp()).post('/api/investigate/launch').send({});
    expect(res.status).toBe(400);
    expect(
      investigateDispatcherMock.launchInvestigateBatch,
    ).not.toHaveBeenCalled();
  });

  it('400s on an empty reportIds[]', async () => {
    const res = await request(makeApp())
      .post('/api/investigate/launch')
      .send({ reportIds: [] });
    expect(res.status).toBe(400);
  });

  it('400s when launchInvestigateBatch throws (e.g. unknown report id)', async () => {
    investigateDispatcherMock.launchInvestigateBatch.mockRejectedValue(
      new Error('launchInvestigateBatch: unknown report r-9'),
    );

    const res = await request(makeApp())
      .post('/api/investigate/launch')
      .send({ reportIds: ['r-9'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown report r-9/);
  });
});
