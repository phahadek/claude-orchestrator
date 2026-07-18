/**
 * Tests for the seed-accretion route (packages/backend/src/routes/seedState.ts).
 *
 * AC: POST /api/seed/accrete-contribution is the grooming write-surface for
 * stageSeedContribution — it resolves the source task's TaskBackend,
 * constructs a BackendTaskWriteCommands, and forwards the parsed body to
 * stageSeedContribution, returning its result verbatim.
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

const stageSeedContributionMock = vi.hoisted(() => vi.fn());
const getTaskBackendMock = vi.hoisted(() => vi.fn(() => ({ type: 'fake' })));

vi.mock('../../tasks/TaskBackend.js', () => ({
  getTaskBackend: getTaskBackendMock,
}));

vi.mock('../../tasks/TaskWriteCommands.js', () => ({
  BackendTaskWriteCommands: vi.fn().mockImplementation(() => ({
    stageSeedContribution: stageSeedContributionMock,
  })),
}));

const milestoneResolverMock = vi.hoisted(() => ({
  resolveMilestoneForProject: vi.fn((_project: string, milestone: string) => milestone),
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
  getTaskBackendMock.mockReturnValue({ type: 'fake' });
});

describe('POST /api/seed/accrete-contribution', () => {
  it('resolves the backend and forwards to stageSeedContribution', async () => {
    const result = {
      itemIds: ['si-1'],
      marker: {
        sourceTaskId: 't1',
        project: 'p1',
        milestone: 'M12',
        decision: 'seeds',
        accretedAt: '2026-07-17T00:00:00.000Z',
      },
    };
    stageSeedContributionMock.mockResolvedValue(result);

    const res = await request(makeApp())
      .post('/api/seed/accrete-contribution')
      .send({
        project: 'p1',
        taskId: 't1',
        title: 'Add retry',
        milestone: 'M12',
        decision: 'seeds',
        seeds: [{ spec: 'analyzer_configs row for retry-backoff' }],
      });

    expect(getTaskBackendMock).toHaveBeenCalledWith('p1');
    expect(stageSeedContributionMock).toHaveBeenCalledWith(
      { id: 't1', title: 'Add retry', project: 'p1', milestone: 'M12' },
      [{ spec: 'analyzer_configs row for retry-backoff' }],
      'seeds',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
  });

  it('accepts a bare "n/a" decision with no seeds', async () => {
    const result = {
      itemIds: [],
      marker: {
        sourceTaskId: 't2',
        project: 'p1',
        milestone: 'M12',
        decision: 'n/a',
        accretedAt: '2026-07-17T00:00:00.000Z',
      },
    };
    stageSeedContributionMock.mockResolvedValue(result);

    const res = await request(makeApp())
      .post('/api/seed/accrete-contribution')
      .send({
        project: 'p1',
        taskId: 't2',
        title: 'Design doc',
        milestone: 'M12',
        decision: 'n/a',
      });

    expect(stageSeedContributionMock).toHaveBeenCalledWith(
      { id: 't2', title: 'Design doc', project: 'p1', milestone: 'M12' },
      [],
      'n/a',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
  });

  it('400s without a decision, never calling stageSeedContribution', async () => {
    const res = await request(makeApp())
      .post('/api/seed/accrete-contribution')
      .send({
        project: 'p1',
        taskId: 't1',
        title: 'Add retry',
        milestone: 'M12',
      });

    expect(res.status).toBe(400);
    expect(stageSeedContributionMock).not.toHaveBeenCalled();
  });

  it('400s without a title, never calling stageSeedContribution', async () => {
    const res = await request(makeApp())
      .post('/api/seed/accrete-contribution')
      .send({
        project: 'p1',
        taskId: 't1',
        milestone: 'M12',
        decision: 'none',
      });

    expect(res.status).toBe(400);
    expect(stageSeedContributionMock).not.toHaveBeenCalled();
  });

  it('400s when stageSeedContribution rejects (e.g. decision/seeds mismatch)', async () => {
    stageSeedContributionMock.mockRejectedValue(
      new Error(
        'at least one seed is required unless decision is "none" or "n/a"',
      ),
    );

    const res = await request(makeApp())
      .post('/api/seed/accrete-contribution')
      .send({
        project: 'p1',
        taskId: 't1',
        title: 'Add retry',
        milestone: 'M12',
        decision: 'seeds',
      });

    expect(res.status).toBe(400);
  });

  it('400s a non-canonical milestone (e.g. a UUID), never calling stageSeedContribution', async () => {
    milestoneResolverMock.resolveMilestoneForProject.mockImplementationOnce(
      () => {
        throw new milestoneResolverMock.UnknownMilestoneError(
          '"9b1e..." is not a known milestone for project "p1"',
        );
      },
    );

    const res = await request(makeApp())
      .post('/api/seed/accrete-contribution')
      .send({
        project: 'p1',
        taskId: 't1',
        title: 'Add retry',
        milestone: '9b1e...',
        decision: 'n/a',
      });

    expect(res.status).toBe(400);
    expect(stageSeedContributionMock).not.toHaveBeenCalled();
  });
});
