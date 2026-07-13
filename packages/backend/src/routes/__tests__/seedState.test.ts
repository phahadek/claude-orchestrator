/**
 * Tests for the seed-state route (packages/backend/src/routes/seedState.ts).
 *
 * AC: routes are thin wrappers over in-process seedService module functions —
 * each route calls the corresponding function directly (no re-implemented
 * business logic) and returns its result verbatim.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const seedServiceMock = vi.hoisted(() => ({
  getSeedReadiness: vi.fn(),
  nextApplyableSeedItems: vi.fn(),
  getSeedItem: vi.fn(),
  appendSeedItemEvent: vi.fn(),
}));

vi.mock('../../seed/seedService.js', () => seedServiceMock);

import { createSeedStateRouter } from '../seedState.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createSeedStateRouter());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/seed/readiness', () => {
  it('calls getSeedReadiness with the milestone and returns its result verbatim', async () => {
    const readiness = { status: 'green', blocking: [] };
    seedServiceMock.getSeedReadiness.mockReturnValue(readiness);

    const res = await request(makeApp()).get('/api/seed/readiness?milestone=M12');

    expect(seedServiceMock.getSeedReadiness).toHaveBeenCalledWith('M12');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(readiness);
  });

  it('400s without a milestone, never calling the service', async () => {
    const res = await request(makeApp()).get('/api/seed/readiness');
    expect(res.status).toBe(400);
    expect(seedServiceMock.getSeedReadiness).not.toHaveBeenCalled();
  });
});

describe('GET /api/seed/next', () => {
  it('calls nextApplyableSeedItems with milestone, deploySha, and limit', async () => {
    seedServiceMock.nextApplyableSeedItems.mockReturnValue([{ id: 'seed-1' }]);

    const res = await request(makeApp()).get(
      '/api/seed/next?milestone=M12&deploySha=sha1&limit=2',
    );

    expect(seedServiceMock.nextApplyableSeedItems).toHaveBeenCalledWith(
      'M12',
      'sha1',
      { limit: 2 },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'seed-1' }]);
  });
});

describe('GET /api/seed/items/:id', () => {
  it('calls getSeedItem with the id and returns its result verbatim', async () => {
    const item = { id: 'seed-1', state: 'pending' };
    seedServiceMock.getSeedItem.mockReturnValue(item);

    const res = await request(makeApp()).get('/api/seed/items/seed-1');

    expect(seedServiceMock.getSeedItem).toHaveBeenCalledWith('seed-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(item);
  });

  it('404s when getSeedItem returns undefined', async () => {
    seedServiceMock.getSeedItem.mockReturnValue(undefined);
    const res = await request(makeApp()).get('/api/seed/items/missing');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/seed/items/:id/events', () => {
  it('calls appendSeedItemEvent with the parsed body and returns its result', async () => {
    const updated = { id: 'seed-1', state: 'applied' };
    seedServiceMock.appendSeedItemEvent.mockReturnValue(updated);

    const res = await request(makeApp())
      .post('/api/seed/items/seed-1/events')
      .send({ outcome: 'applied', operator: 'pedro' });

    expect(seedServiceMock.appendSeedItemEvent).toHaveBeenCalledWith('seed-1', {
      outcome: 'applied',
      evidence: undefined,
      filedFollowon: undefined,
      operator: 'pedro',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
  });

  it('translates a thrown service error to a 400', async () => {
    seedServiceMock.appendSeedItemEvent.mockImplementation(() => {
      throw new Error('a blocked outcome must carry a filedFollowon');
    });

    const res = await request(makeApp())
      .post('/api/seed/items/seed-1/events')
      .send({ outcome: 'blocked' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/filedFollowon/);
  });
});
