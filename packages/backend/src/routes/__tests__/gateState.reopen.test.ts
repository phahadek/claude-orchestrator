/**
 * Tests for POST /api/gate/items/:id/reopen
 * (packages/backend/src/routes/gateState.ts) — the operator-attributed
 * reopen route that pulls a resolved/terminal gate item back to open.
 *
 * AC: operator + reason are forwarded to the service and the updated item
 * returned; the service's no-op-reopen rejection surfaces as a 400 rather
 * than the route pre-validating state.
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

describe('POST /api/gate/items/:id/reopen', () => {
  it('reopens a resolved item and forwards operator + reason', async () => {
    const updated = { id: 'gi-1', state: 'open' };
    gateServiceMock.reopenGateItem.mockReturnValue(updated);

    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/reopen')
      .send({ operator: 'pedro', reason: 'dispositioned in error' });

    expect(gateServiceMock.reopenGateItem).toHaveBeenCalledWith(
      'gi-1',
      'pedro',
      'dispositioned in error',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
  });

  it('reopens with no body', async () => {
    const updated = { id: 'gi-1', state: 'open' };
    gateServiceMock.reopenGateItem.mockReturnValue(updated);

    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/reopen')
      .send({});

    expect(gateServiceMock.reopenGateItem).toHaveBeenCalledWith(
      'gi-1',
      undefined,
      undefined,
    );
    expect(res.status).toBe(200);
  });

  it('400s when the service rejects an already-open/runnable reopen', async () => {
    gateServiceMock.reopenGateItem.mockImplementation(() => {
      throw new Error(
        'gate_item gi-1: already open — reopen only applies to a resolved/terminal item',
      );
    });

    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/reopen')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already open/);
  });
});
