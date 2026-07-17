/**
 * Tests for the gate-state backfill route (packages/backend/src/routes/gateState.ts).
 *
 * AC: POST /api/gate/backfill is a thin wrapper over gateService.backfillGateTask
 * — validates the request body, calls the service, and translates a thrown
 * not-found error to 404 / already-started error to 409.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gateServiceMock = vi.hoisted(() => ({
  getGateReadiness: vi.fn(),
  reconcileGateRunnability: vi.fn(),
  nextRunnableGateItems: vi.fn(),
  getGateItem: vi.fn(),
  getGateItemDetail: vi.fn(),
  listGateItems: vi.fn(),
  listMilestoneReadiness: vi.fn(),
  appendGateItemEvent: vi.fn(),
  approveGateItem: vi.fn(),
  backfillGateTask: vi.fn(),
}));

vi.mock('../../gate/gateService.js', () => gateServiceMock);

import { createGateStateRouter } from '../gateState.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createGateStateRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/gate/backfill', () => {
  it('calls backfillGateTask with the parsed body and returns its result', async () => {
    const result = { created: 1, skipped: 0, itemIds: ['a'] };
    gateServiceMock.backfillGateTask.mockResolvedValue(result);

    const res = await request(makeApp())
      .post('/api/gate/backfill')
      .send({ project: 'p1', taskId: 'notion:gate-task', milestone: 'M12' });

    expect(gateServiceMock.backfillGateTask).toHaveBeenCalledWith({
      project: 'p1',
      taskId: 'notion:gate-task',
      milestone: 'M12',
      milestoneBoardIds: undefined,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
  });

  it('400s without a taskId, never calling the service', async () => {
    const res = await request(makeApp())
      .post('/api/gate/backfill')
      .send({ project: 'p1', milestone: 'M12' });

    expect(res.status).toBe(400);
    expect(gateServiceMock.backfillGateTask).not.toHaveBeenCalled();
  });

  it('404s when the service reports the task was not found', async () => {
    gateServiceMock.backfillGateTask.mockRejectedValue(
      new Error('gate backfill: task notion:missing not found (404)'),
    );

    const res = await request(makeApp())
      .post('/api/gate/backfill')
      .send({ project: 'p1', taskId: 'notion:missing', milestone: 'M12' });

    expect(res.status).toBe(404);
  });

  it('409s when the service reports the task already started', async () => {
    gateServiceMock.backfillGateTask.mockRejectedValue(
      new Error(
        'gate backfill: task notion:gate-task already started (status=🔄 In Progress)',
      ),
    );

    const res = await request(makeApp())
      .post('/api/gate/backfill')
      .send({ project: 'p1', taskId: 'notion:gate-task', milestone: 'M12' });

    expect(res.status).toBe(409);
  });
});
