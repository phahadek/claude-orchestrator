/**
 * Tests for GET /api/gate/tier3-error-rate (packages/backend/src/routes/gateState.ts)
 * — the read on db/queries.ts's getTier3ClassifierErrorRates, decorated with
 * the configured window/threshold. Project-only contract: no milestone
 * involved, mirrors /gate/flake-recovery-rate's shape.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queriesMock = vi.hoisted(() => ({
  getFlowRejectionRate: vi.fn(),
  getFlakeRecoveryMisclassificationRates: vi.fn(),
  getTier3ClassifierErrorRates: vi.fn(),
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

const configMock = vi.hoisted(() => ({
  runtimeSettings: {
    tier3_error_rate_window_seconds: 604_800,
    tier3_error_rate_errored_threshold: 0.5,
    tier3_error_rate_usage_limited_threshold: 0.3,
  },
}));
vi.mock('../../config.js', () => configMock);

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

describe('GET /api/gate/tier3-error-rate', () => {
  it('requires a project query param', async () => {
    const res = await request(makeApp()).get('/api/gate/tier3-error-rate');

    expect(res.status).toBe(400);
    expect(queriesMock.getTier3ClassifierErrorRates).not.toHaveBeenCalled();
  });

  it('reads the configured window and per-kind thresholds, and flags chronic when the rate meets the threshold', async () => {
    queriesMock.getTier3ClassifierErrorRates.mockReturnValue([
      {
        project: 'proj-1',
        kind: 'errored',
        windowSeconds: 604_800,
        total: 4,
        matched: 3,
        rate: 0.75,
      },
      {
        project: 'proj-1',
        kind: 'usage_limited',
        windowSeconds: 604_800,
        total: 4,
        matched: 0,
        rate: 0,
      },
    ]);

    const res = await request(makeApp()).get(
      '/api/gate/tier3-error-rate?project=proj-1',
    );

    expect(queriesMock.getTier3ClassifierErrorRates).toHaveBeenCalledWith(
      'proj-1',
      604_800,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        project: 'proj-1',
        kind: 'errored',
        windowSeconds: 604_800,
        total: 4,
        matched: 3,
        rate: 0.75,
        threshold: 0.5,
        chronic: true,
      },
      {
        project: 'proj-1',
        kind: 'usage_limited',
        windowSeconds: 604_800,
        total: 4,
        matched: 0,
        rate: 0,
        threshold: 0.3,
        chronic: false,
      },
    ]);
  });

  it('reports chronic=false for the zero-total (null rate) case rather than treating it as a blocker', async () => {
    queriesMock.getTier3ClassifierErrorRates.mockReturnValue([
      {
        project: 'proj-1',
        kind: 'errored',
        windowSeconds: 604_800,
        total: 0,
        matched: 0,
        rate: null,
      },
      {
        project: 'proj-1',
        kind: 'usage_limited',
        windowSeconds: 604_800,
        total: 0,
        matched: 0,
        rate: null,
      },
    ]);

    const res = await request(makeApp()).get(
      '/api/gate/tier3-error-rate?project=proj-1',
    );

    expect(res.status).toBe(200);
    expect(
      res.body.every((r: { chronic: boolean }) => r.chronic === false),
    ).toBe(true);
  });
});
