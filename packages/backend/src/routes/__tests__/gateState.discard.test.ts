import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const gateServiceMock = vi.hoisted(() => ({
  appendGateItemEvent: vi.fn(),
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

function makeApp(routeSession?: unknown) {
  const app = express();
  app.use(express.json());
  if (routeSession !== undefined) {
    app.use((req, _res, next) => {
      (req as unknown as { routeSession: unknown }).routeSession =
        routeSession;
      next();
    });
  }
  app.use('/api', createGateStateRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/gate/items/:id/discard', () => {
  it('records a discarded event with the reason as evidence', async () => {
    const updated = { id: 'gi-1', state: 'discarded' };
    gateServiceMock.appendGateItemEvent.mockReturnValue(updated);

    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/discard')
      .send({ reason: 'invalid by construction', operator: 'pedro' });

    expect(gateServiceMock.appendGateItemEvent).toHaveBeenCalledWith('gi-1', {
      disposition: 'discarded',
      evidence: 'invalid by construction',
      operator: 'pedro',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
  });

  it('rejects a caller with a routeSession and leaves state unchanged', async () => {
    const res = await request(makeApp({ sessionId: 's1' }))
      .post('/api/gate/items/gi-1/discard')
      .send({ reason: 'x' });

    expect(res.status).toBe(403);
    expect(gateServiceMock.appendGateItemEvent).not.toHaveBeenCalled();
  });

  it.each([{}, { reason: '' }, { reason: '   ' }, { reason: 5 }])(
    '400s on missing/empty reason %j',
    async (body) => {
      const res = await request(makeApp())
        .post('/api/gate/items/gi-1/discard')
        .send(body);

      expect(res.status).toBe(400);
      expect(gateServiceMock.appendGateItemEvent).not.toHaveBeenCalled();
    },
  );

  it('still rejects discarded on /events with x-gate-session: 1', async () => {
    const res = await request(makeApp())
      .post('/api/gate/items/gi-1/events')
      .set('x-gate-session', '1')
      .send({ disposition: 'discarded', evidence: 'x' });

    expect(res.status).toBe(400);
    expect(gateServiceMock.appendGateItemEvent).not.toHaveBeenCalled();
  });
});
