import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockLoadOpsContext } = vi.hoisted(() => ({
  mockLoadOpsContext: vi.fn(),
}));

vi.mock('../ops/opsLoad.js', () => ({
  loadOpsContext: mockLoadOpsContext,
}));

import { createOpsContextRouter } from '../routes/opsContext.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createOpsContextRouter());
  return app;
}

beforeEach(() => {
  mockLoadOpsContext.mockReset();
});

describe('GET /api/ops-context', () => {
  it('returns 400 when milestone is missing', async () => {
    const res = await request(makeApp()).get('/api/ops-context');
    expect(res.status).toBe(400);
  });

  it('returns the ops context bundle', async () => {
    const bundle = {
      contextPages: [],
      boards: { target: { milestone: 'm1', board: 'b1', counts: {} }, neighbours: [] },
      worklist: {
        executable: [],
        dep_blocked: [],
        needs_grooming: [],
        closed_not_done: [],
        leftover_tooling: [],
        test_authoring: [],
        newly_unblocked: [],
      },
    };
    mockLoadOpsContext.mockResolvedValue(bundle);

    const res = await request(makeApp()).get(
      '/api/ops-context?milestone=m1&project=p1',
    );

    expect(res.status).toBe(200);
    expect(mockLoadOpsContext).toHaveBeenCalledWith('m1', { project: 'p1' });
    expect(res.body).toEqual(bundle);
  });

  it('returns 500 when the loader throws', async () => {
    mockLoadOpsContext.mockRejectedValue(new Error('unknown milestone'));
    const res = await request(makeApp()).get('/api/ops-context?milestone=m1');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('unknown milestone');
  });
});
