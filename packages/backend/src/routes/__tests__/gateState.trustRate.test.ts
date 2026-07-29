/**
 * Tests for GET /api/gate/trust-rate (packages/backend/src/routes/gateState.ts)
 * — the Milestone panel's read on db/queries.ts's getFlowRejectionRate.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queriesMock = vi.hoisted(() => ({
  getFlowRejectionRate: vi.fn(),
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
  milestoneResolverMock.resolveMilestoneForProject.mockImplementation(
    (_project: string, milestone: string) => milestone,
  );
});

describe('GET /api/gate/trust-rate', () => {
  it('resolves the milestone and returns the per-flow rejection rate', async () => {
    queriesMock.getFlowRejectionRate.mockReturnValue({
      flow: 'groom',
      project: 'proj-1',
      milestone: 'M12',
      total: 4,
      rejected: 1,
      rate: 0.25,
    });

    const res = await request(makeApp()).get(
      '/api/gate/trust-rate?project=proj-1&milestone=M12&flow=groom',
    );

    expect(
      milestoneResolverMock.resolveMilestoneForProject,
    ).toHaveBeenCalledWith('proj-1', 'M12');
    expect(queriesMock.getFlowRejectionRate).toHaveBeenCalledWith(
      'proj-1',
      'M12',
      'groom',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      flow: 'groom',
      project: 'proj-1',
      milestone: 'M12',
      total: 4,
      rejected: 1,
      rate: 0.25,
    });
  });

  it('400s a missing query param', async () => {
    const res = await request(makeApp()).get(
      '/api/gate/trust-rate?project=proj-1&milestone=M12',
    );
    expect(res.status).toBe(400);
    expect(queriesMock.getFlowRejectionRate).not.toHaveBeenCalled();
  });

  it('400s an unknown flow', async () => {
    const res = await request(makeApp()).get(
      '/api/gate/trust-rate?project=proj-1&milestone=M12&flow=bogus',
    );
    expect(res.status).toBe(400);
    expect(queriesMock.getFlowRejectionRate).not.toHaveBeenCalled();
  });

  it('400s a non-canonical milestone, never calling the read', async () => {
    milestoneResolverMock.resolveMilestoneForProject.mockImplementationOnce(
      () => {
        throw new milestoneResolverMock.UnknownMilestoneError(
          '"9b1e..." is not a known milestone for project "proj-1"',
        );
      },
    );

    const res = await request(makeApp()).get(
      '/api/gate/trust-rate?project=proj-1&milestone=9b1e...&flow=gate-verify',
    );

    expect(res.status).toBe(400);
    expect(queriesMock.getFlowRejectionRate).not.toHaveBeenCalled();
  });
});
