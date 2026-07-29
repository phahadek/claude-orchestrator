/**
 * Tests for GET /api/gate/items/:id/verify-sessions — the gate-item ↔
 * verify-session linkage route the dashboard uses to render the item's
 * verify session in the Gate Readiness detail view.
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
  getVerifySessionsForGateItem: vi.fn(),
  listGateItems: vi.fn(),
  listMilestoneReadiness: vi.fn(),
  appendGateItemEvent: vi.fn(),
  approveGateItem: vi.fn(),
  backfillGateTask: vi.fn(),
}));

vi.mock('../../gate/gateService.js', () => gateServiceMock);

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

describe('GET /api/gate/items/:id/verify-sessions', () => {
  it('resolves the linkage for a gate item with a verify session', async () => {
    const sessions = [
      {
        itemId: 'item-1',
        sessionId: 'sess-1',
        sessionStatus: 'running',
        startedAt: 100,
        endedAt: null,
      },
    ];
    gateServiceMock.getVerifySessionsForGateItem.mockReturnValue(sessions);

    const res = await request(makeApp()).get(
      '/api/gate/items/item-1/verify-sessions',
    );

    expect(gateServiceMock.getVerifySessionsForGateItem).toHaveBeenCalledWith(
      'item-1',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sessions);
  });

  it('returns an empty array for an item with no verify session', async () => {
    gateServiceMock.getVerifySessionsForGateItem.mockReturnValue([]);

    const res = await request(makeApp()).get(
      '/api/gate/items/item-2/verify-sessions',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
