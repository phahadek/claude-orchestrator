/**
 * Tests for POST /api/gate/items/:id/reject
 * (packages/backend/src/routes/gateState.ts) — the consent gate's other
 * exit: records withheld consent on a Prod-Mutating item held at
 * pending-approval, as a mandatory-reason counterpart to approve.
 *
 * AC: reason is required (refused before reaching the service when absent),
 * operator + reason are forwarded to the service, and the service's own
 * guard rejections surface as a 400.
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
  rejectGateItem: vi.fn(),
  reopenGateItem: vi.fn(),
  reclassifyGateItem: vi.fn(),
  backfillGateTask: vi.fn(),
}));

vi.mock('../../gate/gateService.js', () => gateServiceMock);

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

describe('POST /api/gate/items/:id/reject', () => {
  it('rejects a pending-approval item and forwards operator + reason', async () => {
    const updated = { id: 'gi-1', state: 'fail' };
    gateServiceMock.rejectGateItem.mockReturnValue(updated);

    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/reject')
      .send({ operator: 'pedro', reason: 'not comfortable mutating prod yet' });

    expect(gateServiceMock.rejectGateItem).toHaveBeenCalledWith(
      'gi-1',
      'not comfortable mutating prod yet',
      'pedro',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
  });

  it('refuses with 400 and never calls the service when reason is missing', async () => {
    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/reject')
      .send({ operator: 'pedro' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason is required/);
    expect(gateServiceMock.rejectGateItem).not.toHaveBeenCalled();
  });

  it('refuses with 400 when reason is blank', async () => {
    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/reject')
      .send({ reason: '   ' });

    expect(res.status).toBe(400);
    expect(gateServiceMock.rejectGateItem).not.toHaveBeenCalled();
  });

  it('400s when the service rejects a non-pending-approval item', async () => {
    gateServiceMock.rejectGateItem.mockImplementation(() => {
      throw new Error('gate_item gi-1: not pending approval (state=open)');
    });

    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/reject')
      .send({ reason: 'no' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not pending approval/);
  });
});
