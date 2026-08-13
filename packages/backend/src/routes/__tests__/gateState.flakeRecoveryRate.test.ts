/**
 * Tests for GET /api/gate/flake-recovery-rate (packages/backend/src/routes/gateState.ts)
 * — the read on db/queries.ts's getFlakeRecoveryMisclassificationRates.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queriesMock = vi.hoisted(() => ({
  getFlowRejectionRate: vi.fn(),
  getFlakeRecoveryMisclassificationRates: vi.fn(),
}));
vi.mock('../../db/queries.js', () => queriesMock);

const gateServiceMock = vi.hoisted(() => ({
  getGateReadiness: vi.fn(),
  reconcileGateRunnability: vi.fn(),
  nextRunnableGateItems: vi.fn(),
  getGateItem: vi.fn(),
  getGateItemDetail: vi.fn(),
  getVerifySessionsForGateItem: vi.fn(),
  listGateItems: vi.fn(),
  listMilestoneReadiness: vi.fn(),
  appendGateItemEvent: vi.fn(),
  approveGateItem: vi.fn(),
  reopenGateItem: vi.fn(),
  reclassifyGateItem: vi.fn(),
  backfillGateTask: vi.fn(),
}));
vi.mock('../../gate/gateService.js', () => gateServiceMock);

vi.mock('../../gate/gateReconciler.js', () => ({
  dispatchGateItemVerification: vi.fn(),
}));

const milestoneResolverMock = vi.hoisted(() => ({
  resolveMilestoneForProject: vi.fn(
    (_project: string, milestone: string) => milestone,
  ),
  resolveMilestoneAnyProject: vi.fn((milestone: string) => milestone),
  UnknownMilestoneError: class UnknownMilestoneError extends Error {},
}));
vi.mock('../../projects/milestoneResolver.js', () => milestoneResolverMock);

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

describe('GET /api/gate/flake-recovery-rate', () => {
  it('returns the per-(project, gate) misclassification rate', async () => {
    queriesMock.getFlakeRecoveryMisclassificationRates.mockReturnValue([
      {
        project: 'proj-1',
        gate: 'ci',
        conclusive: 4,
        failed: 1,
        inconclusive: 1,
        rate: 0.25,
      },
    ]);

    const res = await request(makeApp()).get(
      '/api/gate/flake-recovery-rate?project=proj-1',
    );

    expect(
      queriesMock.getFlakeRecoveryMisclassificationRates,
    ).toHaveBeenCalledWith('proj-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        project: 'proj-1',
        gate: 'ci',
        conclusive: 4,
        failed: 1,
        inconclusive: 1,
        rate: 0.25,
      },
    ]);
  });

  it('omits the project filter when no query param is given', async () => {
    queriesMock.getFlakeRecoveryMisclassificationRates.mockReturnValue([]);

    const res = await request(makeApp()).get('/api/gate/flake-recovery-rate');

    expect(
      queriesMock.getFlakeRecoveryMisclassificationRates,
    ).toHaveBeenCalledWith(undefined);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns an empty array cleanly for the zero-data case', async () => {
    queriesMock.getFlakeRecoveryMisclassificationRates.mockReturnValue([]);

    const res = await request(makeApp()).get('/api/gate/flake-recovery-rate');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
