/**
 * Tests for the gate-state read routes (packages/backend/src/routes/gateState.ts)
 * that key off a milestone reference — readiness, next, and items.
 *
 * AC: a non-canonical milestone (a UUID, an unknown display name) is
 * rejected as a 400 rather than silently passed through to the service; a
 * canonical milestone id is normalized to its display name before the
 * service call.
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
  milestoneResolverMock.resolveMilestoneAnyProject.mockImplementation(
    (milestone: string) => milestone,
  );
});

describe('GET /api/gate/readiness', () => {
  it('calls getGateReadiness with the project and the resolved milestone', async () => {
    const readiness = { status: 'green', blocking: [] };
    gateServiceMock.getGateReadiness.mockReturnValue(readiness);

    const res = await request(makeApp()).get(
      '/api/gate/readiness?project=p1&milestone=M12',
    );

    expect(
      milestoneResolverMock.resolveMilestoneForProject,
    ).toHaveBeenCalledWith('p1', 'M12');
    expect(gateServiceMock.getGateReadiness).toHaveBeenCalledWith('p1', 'M12');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(readiness);
  });

  it('400s when project is omitted, never calling the service', async () => {
    const res = await request(makeApp()).get(
      '/api/gate/readiness?milestone=M12',
    );

    expect(res.status).toBe(400);
    expect(gateServiceMock.getGateReadiness).not.toHaveBeenCalled();
  });

  it('400s a non-canonical milestone (e.g. a UUID), never calling the service', async () => {
    milestoneResolverMock.resolveMilestoneForProject.mockImplementationOnce(
      () => {
        throw new milestoneResolverMock.UnknownMilestoneError(
          '"9b1e..." is not a known milestone for project "p1"',
        );
      },
    );

    const res = await request(makeApp()).get(
      '/api/gate/readiness?project=p1&milestone=9b1e...',
    );

    expect(res.status).toBe(400);
    expect(gateServiceMock.getGateReadiness).not.toHaveBeenCalled();
  });

  it('normalizes a canonical milestone id to its display name before calling the service', async () => {
    gateServiceMock.getGateReadiness.mockReturnValue({
      status: 'green',
      blocking: [],
    });
    milestoneResolverMock.resolveMilestoneForProject.mockImplementationOnce(
      () => 'M12',
    );

    const res = await request(makeApp()).get(
      '/api/gate/readiness?project=p1&milestone=milestone-db-uuid',
    );

    expect(gateServiceMock.getGateReadiness).toHaveBeenCalledWith('p1', 'M12');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/gate/next', () => {
  it('400s when project is omitted, never calling the service', async () => {
    const res = await request(makeApp()).get('/api/gate/next?milestone=M12');

    expect(res.status).toBe(400);
    expect(gateServiceMock.nextRunnableGateItems).not.toHaveBeenCalled();
  });

  it('400s a non-canonical milestone, never calling the service', async () => {
    milestoneResolverMock.resolveMilestoneForProject.mockImplementationOnce(
      () => {
        throw new milestoneResolverMock.UnknownMilestoneError(
          'unknown milestone',
        );
      },
    );

    const res = await request(makeApp()).get(
      '/api/gate/next?project=p1&milestone=9b1e...',
    );

    expect(res.status).toBe(400);
    expect(gateServiceMock.nextRunnableGateItems).not.toHaveBeenCalled();
  });
});

describe('GET /api/gate/items', () => {
  it('resolves the milestone against the given project when both are present', async () => {
    gateServiceMock.listGateItems.mockReturnValue({
      items: [],
      total: 0,
      page: 1,
    });

    const res = await request(makeApp()).get(
      '/api/gate/items?project=p1&milestone=M12',
    );

    expect(
      milestoneResolverMock.resolveMilestoneForProject,
    ).toHaveBeenCalledWith('p1', 'M12');
    expect(res.status).toBe(200);
  });

  it('400s a non-canonical milestone scoped to a project, never calling the service', async () => {
    milestoneResolverMock.resolveMilestoneForProject.mockImplementationOnce(
      () => {
        throw new milestoneResolverMock.UnknownMilestoneError(
          '"9b1e..." is not a known milestone for project "p1"',
        );
      },
    );

    const res = await request(makeApp()).get(
      '/api/gate/items?project=p1&milestone=9b1e...',
    );

    expect(res.status).toBe(400);
    expect(gateServiceMock.listGateItems).not.toHaveBeenCalled();
  });

  it('skips milestone resolution entirely when no milestone filter is given', async () => {
    gateServiceMock.listGateItems.mockReturnValue({
      items: [],
      total: 0,
      page: 1,
    });

    const res = await request(makeApp()).get('/api/gate/items?project=p1');

    expect(
      milestoneResolverMock.resolveMilestoneForProject,
    ).not.toHaveBeenCalled();
    expect(
      milestoneResolverMock.resolveMilestoneAnyProject,
    ).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});
