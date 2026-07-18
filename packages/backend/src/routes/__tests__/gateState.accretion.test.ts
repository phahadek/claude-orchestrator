/**
 * Tests for the gate-accretion route (packages/backend/src/routes/gateState.ts).
 *
 * AC: POST /api/gate/accrete-contribution is the grooming write-surface for
 * accreteGateContribution — it resolves the source task's TaskBackend,
 * constructs a BackendTaskWriteCommands, and forwards the parsed body to
 * accreteGateContribution, returning its result verbatim.
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

const accreteGateContributionMock = vi.hoisted(() => vi.fn());
const getTaskBackendMock = vi.hoisted(() => vi.fn(() => ({ type: 'fake' })));

vi.mock('../../tasks/TaskBackend.js', () => ({
  getTaskBackend: getTaskBackendMock,
}));

vi.mock('../../tasks/TaskWriteCommands.js', () => ({
  BackendTaskWriteCommands: vi.fn().mockImplementation(() => ({
    accreteGateContribution: accreteGateContributionMock,
  })),
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
  getTaskBackendMock.mockReturnValue({ type: 'fake' });
});

describe('POST /api/gate/accrete-contribution', () => {
  it('resolves the backend and forwards to accreteGateContribution', async () => {
    const result = {
      itemIds: ['gi-1'],
      marker: {
        sourceTaskId: 't1',
        project: 'p1',
        milestone: 'M12',
        decision: 'items',
        accretedAt: '2026-07-17T00:00:00.000Z',
      },
    };
    accreteGateContributionMock.mockResolvedValue(result);

    const res = await request(makeApp())
      .post('/api/gate/accrete-contribution')
      .send({
        project: 'p1',
        taskId: 't1',
        title: 'Add retry',
        milestone: 'M12',
        classification: 'Read-Only',
        items: [{ text: 'Click through checkout once' }],
      });

    expect(getTaskBackendMock).toHaveBeenCalledWith('p1');
    expect(accreteGateContributionMock).toHaveBeenCalledWith(
      { id: 't1', title: 'Add retry', project: 'p1', milestone: 'M12' },
      [{ text: 'Click through checkout once' }],
      'Read-Only',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
  });

  it('accepts a bare "none" decision with no items', async () => {
    const result = {
      itemIds: [],
      marker: {
        sourceTaskId: 't2',
        project: 'p1',
        milestone: 'M12',
        decision: 'none',
        accretedAt: '2026-07-17T00:00:00.000Z',
      },
    };
    accreteGateContributionMock.mockResolvedValue(result);

    const res = await request(makeApp())
      .post('/api/gate/accrete-contribution')
      .send({
        project: 'p1',
        taskId: 't2',
        title: 'Docs fix',
        milestone: 'M12',
        classification: 'none',
      });

    expect(accreteGateContributionMock).toHaveBeenCalledWith(
      { id: 't2', title: 'Docs fix', project: 'p1', milestone: 'M12' },
      [],
      'none',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
  });

  it('400s without a classification, never calling accreteGateContribution', async () => {
    const res = await request(makeApp())
      .post('/api/gate/accrete-contribution')
      .send({
        project: 'p1',
        taskId: 't1',
        title: 'Add retry',
        milestone: 'M12',
      });

    expect(res.status).toBe(400);
    expect(accreteGateContributionMock).not.toHaveBeenCalled();
  });

  it('400s without a taskId, never calling accreteGateContribution', async () => {
    const res = await request(makeApp())
      .post('/api/gate/accrete-contribution')
      .send({
        project: 'p1',
        title: 'Add retry',
        milestone: 'M12',
        classification: 'none',
      });

    expect(res.status).toBe(400);
    expect(accreteGateContributionMock).not.toHaveBeenCalled();
  });

  it('400s when accreteGateContribution rejects (e.g. classification/items mismatch)', async () => {
    accreteGateContributionMock.mockRejectedValue(
      new Error(
        'at least one item is required unless classification is "none" or "n/a"',
      ),
    );

    const res = await request(makeApp())
      .post('/api/gate/accrete-contribution')
      .send({
        project: 'p1',
        taskId: 't1',
        title: 'Add retry',
        milestone: 'M12',
        classification: 'Read-Only',
      });

    expect(res.status).toBe(400);
  });

  it('400s a non-canonical milestone (e.g. a UUID), never calling accreteGateContribution', async () => {
    milestoneResolverMock.resolveMilestoneForProject.mockImplementationOnce(
      () => {
        throw new milestoneResolverMock.UnknownMilestoneError(
          '"9b1e..." is not a known milestone for project "p1"',
        );
      },
    );

    const res = await request(makeApp())
      .post('/api/gate/accrete-contribution')
      .send({
        project: 'p1',
        taskId: 't1',
        title: 'Add retry',
        milestone: '9b1e...',
        classification: 'none',
      });

    expect(res.status).toBe(400);
    expect(accreteGateContributionMock).not.toHaveBeenCalled();
  });
});
