/** POST /test-request-runs/:id/cancel — device-authed operator cancel route. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockCancel } = vi.hoisted(() => ({ mockCancel: vi.fn() }));

vi.mock('../../orchestration/testRequestLane', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../orchestration/testRequestLane')
    >();
  return { ...actual, cancelTestRequestRun: mockCancel };
});

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db';
import { insertDevice } from '../../db/queries';
import { createStagedIntentsRouter } from '../stagedIntents';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createStagedIntentsRouter());
  return app;
}

const AUTH = { Authorization: 'Bearer tok-op-1' };

beforeEach(() => {
  mockCancel.mockReset();
  db.prepare('DELETE FROM devices').run();
  insertDevice({
    id: 'device-op-1',
    name: 'op',
    user_agent: null,
    last_ip: null,
    enrolled_at: Date.now(),
    token: 'tok-op-1',
  } as Parameters<typeof insertDevice>[0]);
});

describe('POST /test-request-runs/:id/cancel', () => {
  it('rejects a request without a device token (401)', async () => {
    const res = await supertest(makeApp()).post(
      '/api/test-request-runs/run-1/cancel',
    );
    expect(res.status).toBe(401);
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('returns 409 for an already-settled run', async () => {
    mockCancel.mockReturnValue('settled');
    const res = await supertest(makeApp())
      .post('/api/test-request-runs/run-1/cancel')
      .set(AUTH);
    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown run', async () => {
    mockCancel.mockReturnValue('not_found');
    const res = await supertest(makeApp())
      .post('/api/test-request-runs/run-1/cancel')
      .set(AUTH);
    expect(res.status).toBe(404);
  });

  it.each(['withdrawn', 'aborted', 'noop'])(
    'reports %s and passes the operator device as the actor',
    async (outcome) => {
      mockCancel.mockReturnValue(outcome);
      const res = await supertest(makeApp())
        .post('/api/test-request-runs/run-1/cancel')
        .set(AUTH);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ action: outcome });
      expect(mockCancel).toHaveBeenCalledWith('run-1', 'device-op-1');
    },
  );
});
