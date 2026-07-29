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
  getSeedItemDetail: vi.fn(),
  listSeedItems: vi.fn(),
  listSeedMilestoneReadiness: vi.fn(),
  appendSeedItemEvent: vi.fn(),
  backfillSeedTask: vi.fn(),
}));

vi.mock('../../seed/seedService.js', () => seedServiceMock);

const milestoneResolverMock = vi.hoisted(() => ({
  resolveMilestoneForProject: vi.fn(
    (_project: string, milestone: string) => milestone,
  ),
  resolveMilestoneAnyProject: vi.fn((milestone: string) => milestone),
  UnknownMilestoneError: class UnknownMilestoneError extends Error {},
}));

vi.mock('../../projects/milestoneResolver.js', () => milestoneResolverMock);

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
  it('calls getSeedReadiness with the project and the resolved milestone', async () => {
    const readiness = { status: 'green', blocking: [] };
    seedServiceMock.getSeedReadiness.mockReturnValue(readiness);

    const res = await request(makeApp()).get(
      '/api/seed/readiness?project=p1&milestone=M12',
    );

    expect(
      milestoneResolverMock.resolveMilestoneForProject,
    ).toHaveBeenCalledWith('p1', 'M12');
    expect(seedServiceMock.getSeedReadiness).toHaveBeenCalledWith('p1', 'M12');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(readiness);
  });

  it('400s without a milestone, never calling the service', async () => {
    const res = await request(makeApp()).get('/api/seed/readiness?project=p1');
    expect(res.status).toBe(400);
    expect(seedServiceMock.getSeedReadiness).not.toHaveBeenCalled();
  });

  it('400s without a project, never calling the service', async () => {
    const res = await request(makeApp()).get(
      '/api/seed/readiness?milestone=M12',
    );
    expect(res.status).toBe(400);
    expect(seedServiceMock.getSeedReadiness).not.toHaveBeenCalled();
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
      '/api/seed/readiness?project=p1&milestone=9b1e...',
    );

    expect(res.status).toBe(400);
    expect(seedServiceMock.getSeedReadiness).not.toHaveBeenCalled();
  });
});

describe('GET /api/seed/next', () => {
  it('calls nextApplyableSeedItems with project, milestone, deploySha, and limit', async () => {
    seedServiceMock.nextApplyableSeedItems.mockReturnValue([{ id: 'seed-1' }]);

    const res = await request(makeApp()).get(
      '/api/seed/next?project=p1&milestone=M12&deploySha=sha1&limit=2',
    );

    expect(seedServiceMock.nextApplyableSeedItems).toHaveBeenCalledWith(
      'p1',
      'M12',
      'sha1',
      { limit: 2 },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'seed-1' }]);
  });

  it('400s without a project, never calling the service', async () => {
    const res = await request(makeApp()).get(
      '/api/seed/next?milestone=M12&deploySha=sha1',
    );
    expect(res.status).toBe(400);
    expect(seedServiceMock.nextApplyableSeedItems).not.toHaveBeenCalled();
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

describe('GET /api/seed/items', () => {
  it('calls listSeedItems with parsed filter/pagination params', async () => {
    const result = { items: [{ id: 'seed-1' }], total: 1, page: 1 };
    seedServiceMock.listSeedItems.mockReturnValue(result);

    const res = await request(makeApp()).get(
      '/api/seed/items?project=p1&milestone=M12&state=pending&page=2&limit=10',
    );

    expect(seedServiceMock.listSeedItems).toHaveBeenCalledWith({
      project: 'p1',
      milestone: 'M12',
      state: 'pending',
      page: 2,
      limit: 10,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
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
      '/api/seed/items?project=p1&milestone=9b1e...',
    );

    expect(
      milestoneResolverMock.resolveMilestoneForProject,
    ).toHaveBeenCalledWith('p1', '9b1e...');
    expect(res.status).toBe(400);
    expect(seedServiceMock.listSeedItems).not.toHaveBeenCalled();
  });
});

describe('GET /api/seed/milestones/readiness', () => {
  it('calls listSeedMilestoneReadiness with the project and returns its result verbatim', async () => {
    const readiness = [
      { project: 'p1', milestone: 'M12', status: 'green', blockingCount: 0 },
    ];
    seedServiceMock.listSeedMilestoneReadiness.mockReturnValue(readiness);

    const res = await request(makeApp()).get(
      '/api/seed/milestones/readiness?project=p1',
    );

    expect(seedServiceMock.listSeedMilestoneReadiness).toHaveBeenCalledWith({
      project: 'p1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(readiness);
  });
});

describe('GET /api/seed/items/:id/detail', () => {
  it('calls getSeedItemDetail with the id and returns its result verbatim', async () => {
    const detail = { item: { id: 'seed-1' }, sources: [], events: [] };
    seedServiceMock.getSeedItemDetail.mockReturnValue(detail);

    const res = await request(makeApp()).get('/api/seed/items/seed-1/detail');

    expect(seedServiceMock.getSeedItemDetail).toHaveBeenCalledWith('seed-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(detail);
  });

  it('404s when getSeedItemDetail returns undefined', async () => {
    seedServiceMock.getSeedItemDetail.mockReturnValue(undefined);
    const res = await request(makeApp()).get('/api/seed/items/missing/detail');
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

describe('POST /api/seed/backfill', () => {
  it('calls backfillSeedTask with the parsed body and returns its result', async () => {
    const result = { createdIds: ['a'], skippedIds: [], unresolvedSources: [] };
    seedServiceMock.backfillSeedTask.mockResolvedValue(result);

    const res = await request(makeApp())
      .post('/api/seed/backfill')
      .send({ project: 'p1', taskId: 'notion:seed-task', milestone: 'M12' });

    expect(seedServiceMock.backfillSeedTask).toHaveBeenCalledWith({
      project: 'p1',
      taskId: 'notion:seed-task',
      milestone: 'M12',
      candidates: undefined,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
  });

  it('400s without a taskId, never calling the service', async () => {
    const res = await request(makeApp())
      .post('/api/seed/backfill')
      .send({ project: 'p1', milestone: 'M12' });

    expect(res.status).toBe(400);
    expect(seedServiceMock.backfillSeedTask).not.toHaveBeenCalled();
  });

  it('404s when the service reports the task was not found', async () => {
    seedServiceMock.backfillSeedTask.mockRejectedValue(
      new Error('seed backfill: task notion:missing not found (404)'),
    );

    const res = await request(makeApp())
      .post('/api/seed/backfill')
      .send({ project: 'p1', taskId: 'notion:missing', milestone: 'M12' });

    expect(res.status).toBe(404);
  });

  it('409s when the service reports the task already started', async () => {
    seedServiceMock.backfillSeedTask.mockRejectedValue(
      new Error(
        'seed backfill: task notion:seed-task already started (status=🔄 In Progress)',
      ),
    );

    const res = await request(makeApp())
      .post('/api/seed/backfill')
      .send({ project: 'p1', taskId: 'notion:seed-task', milestone: 'M12' });

    expect(res.status).toBe(409);
  });

  it('400s a non-canonical milestone (e.g. a UUID), never calling the service', async () => {
    milestoneResolverMock.resolveMilestoneForProject.mockImplementationOnce(
      () => {
        throw new milestoneResolverMock.UnknownMilestoneError(
          '"9b1e..." is not a known milestone for project "p1"',
        );
      },
    );

    const res = await request(makeApp()).post('/api/seed/backfill').send({
      project: 'p1',
      taskId: 'notion:seed-task',
      milestone: '9b1e...',
    });

    expect(res.status).toBe(400);
    expect(seedServiceMock.backfillSeedTask).not.toHaveBeenCalled();
  });

  it('normalizes a canonical milestone id to its display name before calling the service', async () => {
    const result = { createdIds: ['a'], skippedIds: [], unresolvedSources: [] };
    seedServiceMock.backfillSeedTask.mockResolvedValue(result);
    milestoneResolverMock.resolveMilestoneForProject.mockImplementationOnce(
      () => 'M12',
    );

    const res = await request(makeApp()).post('/api/seed/backfill').send({
      project: 'p1',
      taskId: 'notion:seed-task',
      milestone: 'milestone-db-uuid',
    });

    expect(seedServiceMock.backfillSeedTask).toHaveBeenCalledWith({
      project: 'p1',
      taskId: 'notion:seed-task',
      milestone: 'M12',
      candidates: undefined,
    });
    expect(res.status).toBe(200);
  });
});
