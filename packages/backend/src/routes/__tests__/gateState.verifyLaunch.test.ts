/**
 * Tests for POST /api/gate/verify-launch
 * (packages/backend/src/routes/gateState.ts) — the manual gate-verify
 * dispatch surface (operator-triggered verify-item/verify-batch, analog of
 * the Groom(N)/Ops(N) launch routes).
 *
 * AC: itemIds are forwarded to dispatchGateItemVerification and its
 * dispatched/skipped result returned with a 202; a missing/empty itemIds[]
 * 400s; a thrown error (e.g. no verifier configured) surfaces as a 400.
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
  reopenGateItem: vi.fn(),
  reclassifyGateItem: vi.fn(),
  backfillGateTask: vi.fn(),
}));

vi.mock('../../gate/gateService.js', () => gateServiceMock);

const gateReconcilerMock = vi.hoisted(() => ({
  dispatchGateItemVerification: vi.fn(),
}));

vi.mock('../../gate/gateReconciler.js', () => gateReconcilerMock);

vi.mock('../../projects/milestoneResolver.js', () => ({
  resolveMilestoneForProject: vi.fn(
    (_project: string, milestone: string) => milestone,
  ),
  resolveMilestoneAnyProject: vi.fn((milestone: string) => milestone),
  UnknownMilestoneError: class UnknownMilestoneError extends Error {},
}));

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

describe('POST /api/gate/verify-launch', () => {
  it('dispatches the given item ids and returns 202 with the result', async () => {
    const result = {
      dispatched: ['gi-1', 'gi-2'],
      skipped: [{ itemId: 'gi-3', reason: 'already in flight' }],
    };
    gateReconcilerMock.dispatchGateItemVerification.mockReturnValue(result);

    const res = await request(makeApp())
      .post('/api/gate/verify-launch')
      .send({ itemIds: ['gi-1', 'gi-2', 'gi-3'] });

    expect(
      gateReconcilerMock.dispatchGateItemVerification,
    ).toHaveBeenCalledWith(['gi-1', 'gi-2', 'gi-3']);
    expect(res.status).toBe(202);
    expect(res.body).toEqual(result);
  });

  it('400s on a missing itemIds[]', async () => {
    const res = await request(makeApp())
      .post('/api/gate/verify-launch')
      .send({});
    expect(res.status).toBe(400);
    expect(
      gateReconcilerMock.dispatchGateItemVerification,
    ).not.toHaveBeenCalled();
  });

  it('400s on an empty itemIds[]', async () => {
    const res = await request(makeApp())
      .post('/api/gate/verify-launch')
      .send({ itemIds: [] });
    expect(res.status).toBe(400);
  });

  it('400s when dispatchGateItemVerification throws (e.g. no verifier configured)', async () => {
    gateReconcilerMock.dispatchGateItemVerification.mockImplementation(() => {
      throw new Error('no gate verifier configured');
    });

    const res = await request(makeApp())
      .post('/api/gate/verify-launch')
      .send({ itemIds: ['gi-1'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no gate verifier configured/);
  });
});
