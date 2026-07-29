/**
 * Tests for POST /api/gate/items/:id/events
 * (packages/backend/src/routes/gateState.ts) — disposition is optional (a
 * dispositionless event is a pure log entry) and, when present, must be a
 * string; the closed-vocabulary rejection itself lives in gateService and
 * surfaces here as a 400 rather than the route pre-validating the enum.
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

describe('POST /api/gate/items/:id/events', () => {
  it('forwards a disposition event and returns the updated item', async () => {
    const updated = { id: 'gi-1', state: 'pass' };
    gateServiceMock.appendGateItemEvent.mockReturnValue(updated);

    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/events')
      .send({ disposition: 'pass', evidence: 'clicked through checkout' });

    expect(gateServiceMock.appendGateItemEvent).toHaveBeenCalledWith('gi-1', {
      disposition: 'pass',
      evidence: 'clicked through checkout',
      filedFollowon: undefined,
      deploySha: undefined,
      operator: undefined,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
  });

  it('accepts an event with no disposition as a pure log entry', async () => {
    const updated = { id: 'gi-1', state: 'open' };
    gateServiceMock.appendGateItemEvent.mockReturnValue(updated);

    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/events')
      .send({ evidence: 'attempted, still investigating' });

    expect(gateServiceMock.appendGateItemEvent).toHaveBeenCalledWith('gi-1', {
      disposition: undefined,
      evidence: 'attempted, still investigating',
      filedFollowon: undefined,
      deploySha: undefined,
      operator: undefined,
    });
    expect(res.status).toBe(200);
  });

  it('400s without calling the service when disposition is present but not a string', async () => {
    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/events')
      .send({ disposition: 42 });

    expect(res.status).toBe(400);
    expect(gateServiceMock.appendGateItemEvent).not.toHaveBeenCalled();
  });

  it('400s when the service rejects a disposition outside the closed vocabulary', async () => {
    gateServiceMock.appendGateItemEvent.mockImplementation(() => {
      throw new Error(
        "gate_item_event: invalid disposition 'blocked-unexercised-by-value' — must be one of pass, fail, deferred, discarded, noted, or omitted for a log-only event",
      );
    });

    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/events')
      .send({ disposition: 'blocked-unexercised-by-value' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid disposition/);
  });

  it('400s when the service rejects a discarded event with no evidence', async () => {
    gateServiceMock.appendGateItemEvent.mockImplementation(() => {
      throw new Error(
        "gate_item_event: 'discarded' requires an evidence/reason",
      );
    });

    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/events')
      .send({ disposition: 'discarded' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/requires an evidence/);
  });
});
