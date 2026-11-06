/**
 * Tests for GET /api/gate/trust-rate (packages/backend/src/routes/gateState.ts)
 * — the Milestone panel's single-request read batching db/queries.ts's
 * getFlowRejectionRate (once per flow) and getAutoGrantDisagreementRate
 * (once per auto-grant kind).
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queriesMock = vi.hoisted(() => ({
  getFlowRejectionRate: vi.fn(),
  getFlakeRecoveryMisclassificationRates: vi.fn(),
  getAutoGrantDisagreementRate: vi.fn(),
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

const TRUST_PRECISION_FLOWS = [
  'groom',
  'design',
  'ops',
  'investigate',
  'gate-verify',
];
const AUTO_GRANT_KINDS = ['gate.accrete', 'seed.stage'];

beforeEach(() => {
  vi.clearAllMocks();
  milestoneResolverMock.resolveMilestoneForProject.mockImplementation(
    (_project: string, milestone: string) => milestone,
  );
  queriesMock.getFlowRejectionRate.mockImplementation(
    (project: string, milestone: string, flow: string) => ({
      flow,
      project,
      milestone,
      total: 0,
      rejected: 0,
      rate: null,
    }),
  );
  queriesMock.getAutoGrantDisagreementRate.mockImplementation(
    (project: string, milestone: string, kind: string) => ({
      kind,
      project,
      milestone,
      total: 0,
      disagreed: 0,
      rate: null,
    }),
  );
});

describe('GET /api/gate/trust-rate', () => {
  it('resolves the milestone and returns every flow + auto-grant kind in one response', async () => {
    const res = await request(makeApp()).get(
      '/api/gate/trust-rate?project=proj-1&milestone=M12',
    );

    expect(
      milestoneResolverMock.resolveMilestoneForProject,
    ).toHaveBeenCalledWith('proj-1', 'M12');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.rates).sort()).toEqual(
      [...TRUST_PRECISION_FLOWS].sort(),
    );
    expect(Object.keys(res.body.autoGrantDisagreementRate).sort()).toEqual(
      [...AUTO_GRANT_KINDS].sort(),
    );
    expect(res.body.rates.groom).toMatchObject({
      flow: 'groom',
      project: 'proj-1',
      milestone: 'M12',
    });
    expect(res.body.autoGrantDisagreementRate['gate.accrete']).toMatchObject({
      kind: 'gate.accrete',
      project: 'proj-1',
      milestone: 'M12',
    });
  });

  it('calls getFlowRejectionRate exactly once per flow', async () => {
    await request(makeApp()).get(
      '/api/gate/trust-rate?project=proj-1&milestone=M12',
    );

    expect(queriesMock.getFlowRejectionRate).toHaveBeenCalledTimes(
      TRUST_PRECISION_FLOWS.length,
    );
    for (const flow of TRUST_PRECISION_FLOWS) {
      expect(queriesMock.getFlowRejectionRate).toHaveBeenCalledWith(
        'proj-1',
        'M12',
        flow,
      );
    }
  });

  it('calls getAutoGrantDisagreementRate exactly once per auto-grant kind, not once per flow', async () => {
    await request(makeApp()).get(
      '/api/gate/trust-rate?project=proj-1&milestone=M12',
    );

    expect(queriesMock.getAutoGrantDisagreementRate).toHaveBeenCalledTimes(
      AUTO_GRANT_KINDS.length,
    );
    for (const kind of AUTO_GRANT_KINDS) {
      expect(queriesMock.getAutoGrantDisagreementRate).toHaveBeenCalledWith(
        'proj-1',
        'M12',
        kind,
      );
    }
  });

  it('400s a missing query param', async () => {
    const res = await request(makeApp()).get(
      '/api/gate/trust-rate?project=proj-1',
    );
    expect(res.status).toBe(400);
    expect(queriesMock.getFlowRejectionRate).not.toHaveBeenCalled();
  });

  it('400s a non-canonical milestone, never calling the reads', async () => {
    milestoneResolverMock.resolveMilestoneForProject.mockImplementationOnce(
      () => {
        throw new milestoneResolverMock.UnknownMilestoneError(
          '"9b1e..." is not a known milestone for project "proj-1"',
        );
      },
    );

    const res = await request(makeApp()).get(
      '/api/gate/trust-rate?project=proj-1&milestone=9b1e...',
    );

    expect(res.status).toBe(400);
    expect(queriesMock.getFlowRejectionRate).not.toHaveBeenCalled();
    expect(queriesMock.getAutoGrantDisagreementRate).not.toHaveBeenCalled();
  });
});
