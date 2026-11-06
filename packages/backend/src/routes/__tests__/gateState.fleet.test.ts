/**
 * Tests for GET /api/gate/fleet — the cross-project gate-verify fleet route
 * the dashboard uses to render every in-flight verify session across every
 * project.
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
  getGateVerifyFleetState: vi.fn(),
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

describe('GET /api/gate/fleet', () => {
  it('returns the fleet snapshot spanning multiple projects', async () => {
    const snapshot = {
      liveCount: 2,
      sessions: [
        {
          sessionId: 'sess-a',
          itemId: 'item-a',
          project: 'project-a',
          milestone: 'M12',
          text: 'Verify A',
          status: 'running',
          startedAt: 1000,
          elapsedMs: 500,
          remainingMs: 1_199_500,
          suspended: false,
        },
        {
          sessionId: 'sess-b',
          itemId: 'item-b',
          project: 'project-b',
          milestone: 'M8',
          text: 'Verify B',
          status: 'idle',
          startedAt: 2000,
          elapsedMs: 700,
          remainingMs: 1_199_300,
          suspended: true,
        },
      ],
      skippedForBudgetHistory: [],
    };
    gateServiceMock.getGateVerifyFleetState.mockReturnValue(snapshot);

    const res = await request(makeApp()).get('/api/gate/fleet');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(snapshot);
    expect(res.body.liveCount).toBe(res.body.sessions.length);
    const projects = new Set(
      res.body.sessions.map((s: { project: string }) => s.project),
    );
    expect(projects.size).toBeGreaterThan(1);
  });
});
