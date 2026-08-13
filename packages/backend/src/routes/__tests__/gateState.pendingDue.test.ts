/**
 * Tests for GET /api/gate/pending-due (packages/backend/src/routes/gateState.ts)
 * — the non-arm-gated read route for backoff-elapsed `pending` items. This
 * is the operator/gate-reachable route back for a parked item once its
 * next_attempt_at has passed, distinct from nextRunnableGateItems (state
 * 'runnable' only) and independent of the (milestone, 'gate-verify') arm
 * that gates auto-run's own pull of the same set.
 *
 * AC: forwards project/milestone/limit to gateService.nextPendingGateItems
 * and returns its result; project/milestone are required (400 otherwise);
 * an unknown milestone 400s; the route is purely a read — it never touches
 * gateReconciler's dispatch surface, so it cannot cause processItem to run
 * for a disarmed milestone.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gateServiceMock = vi.hoisted(() => ({
  getGateReadiness: vi.fn(),
  reconcileGateRunnability: vi.fn(),
  nextRunnableGateItems: vi.fn(),
  nextPendingGateItems: vi.fn(),
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

vi.mock('../../projects/milestoneResolver.js', () => {
  class UnknownMilestoneError extends Error {}
  return {
    resolveMilestoneForProject: vi.fn((project: string, milestone: string) => {
      if (milestone === 'bogus') {
        throw new UnknownMilestoneError(`unknown milestone: ${milestone}`);
      }
      return milestone;
    }),
    resolveMilestoneAnyProject: vi.fn((milestone: string) => milestone),
    UnknownMilestoneError,
  };
});

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

describe('GET /api/gate/pending-due', () => {
  it('returns the backoff-elapsed pending items from gateService, excluding not-yet-elapsed ones', async () => {
    const due = {
      id: 'gi-due',
      state: 'pending',
      nextAttemptAt: '2020-01-01T00:00:00Z',
    };
    gateServiceMock.nextPendingGateItems.mockReturnValue([due]);

    const res = await request(makeApp()).get(
      '/api/gate/pending-due?project=proj-1&milestone=M12&limit=5',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([due]);
    expect(gateServiceMock.nextPendingGateItems).toHaveBeenCalledWith(
      'proj-1',
      'M12',
      { limit: 5 },
    );
  });

  it('requires project', async () => {
    const res = await request(makeApp()).get(
      '/api/gate/pending-due?milestone=M12',
    );
    expect(res.status).toBe(400);
    expect(gateServiceMock.nextPendingGateItems).not.toHaveBeenCalled();
  });

  it('requires milestone', async () => {
    const res = await request(makeApp()).get(
      '/api/gate/pending-due?project=proj-1',
    );
    expect(res.status).toBe(400);
    expect(gateServiceMock.nextPendingGateItems).not.toHaveBeenCalled();
  });

  it('400s on an unknown milestone', async () => {
    const res = await request(makeApp()).get(
      '/api/gate/pending-due?project=proj-1&milestone=bogus',
    );
    expect(res.status).toBe(400);
  });

  it('never touches the verify-dispatch surface — a disarmed gate-verify still suppresses unattended dispatch', async () => {
    gateServiceMock.nextPendingGateItems.mockReturnValue([
      { id: 'gi-due', state: 'pending' },
    ]);

    await request(makeApp()).get(
      '/api/gate/pending-due?project=proj-1&milestone=M12',
    );

    expect(
      gateReconcilerMock.dispatchGateItemVerification,
    ).not.toHaveBeenCalled();
  });
});
