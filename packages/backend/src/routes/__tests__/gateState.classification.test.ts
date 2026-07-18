/**
 * Tests for POST /api/gate/items/:id/classification
 * (packages/backend/src/routes/gateState.ts) — the /gate skill's triage
 * route for reclassifying a needs-triage item.
 *
 * AC: a valid target (Read-Only/Prod-Mutating/Opportunistic) is applied and
 * the updated item returned; a bad target is rejected with a 400 and the
 * service surfaces the rejection rather than the route pre-validating it.
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

describe('POST /api/gate/items/:id/classification', () => {
  it('reclassifies a needs-triage item to a valid target', async () => {
    const updated = { id: 'gi-1', classification: 'Read-Only' };
    gateServiceMock.reclassifyGateItem.mockReturnValue(updated);

    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/classification')
      .send({ classification: 'Read-Only', operator: 'pedro' });

    expect(gateServiceMock.reclassifyGateItem).toHaveBeenCalledWith(
      'gi-1',
      'Read-Only',
      'pedro',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
  });

  it('rejects a missing classification without calling the service', async () => {
    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/classification')
      .send({});

    expect(res.status).toBe(400);
    expect(gateServiceMock.reclassifyGateItem).not.toHaveBeenCalled();
  });

  it('400s when the service rejects an invalid target', async () => {
    gateServiceMock.reclassifyGateItem.mockImplementation(() => {
      throw new Error('gate_item: invalid reclassification target bogus-tier');
    });

    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/classification')
      .send({ classification: 'bogus-tier' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid reclassification target/);
  });
});
