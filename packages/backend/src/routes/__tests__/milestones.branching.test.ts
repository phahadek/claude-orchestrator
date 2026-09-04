/**
 * Route tests for the per-milestone milestone_branching override write path
 * (PATCH /api/milestones/:milestoneId), hit through the real Express router.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { createMilestonesRouter } from '../milestones.js';
import { ProjectService } from '../../projects/ProjectService.js';
import { getMilestoneById } from '../../db/queries.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createMilestonesRouter());
  return app;
}

beforeAll(() => {
  if (!ProjectService.getById('proj-branching')) {
    ProjectService.create({
      id: 'proj-branching',
      name: 'Project Branching',
      projectDir: '/tmp/proj-branching',
    });
  }
  if (!ProjectService.getMilestone('ms-branching-1')) {
    ProjectService.createMilestone({
      id: 'ms-branching-1',
      projectId: 'proj-branching',
      name: 'Branching Milestone',
      canonicalShortId: 'M-branching',
    });
  }
});

describe('PATCH /api/milestones/:milestoneId', () => {
  it('sets an explicit two_tier override', async () => {
    const res = await request(makeApp())
      .patch('/api/milestones/ms-branching-1')
      .send({ milestoneBranching: 'two_tier' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      milestoneId: 'ms-branching-1',
      milestoneBranching: 'two_tier',
    });
    expect(getMilestoneById('ms-branching-1')?.milestone_branching).toBe(
      'two_tier',
    );
  });

  it('sets an explicit flat override', async () => {
    const res = await request(makeApp())
      .patch('/api/milestones/ms-branching-1')
      .send({ milestoneBranching: 'flat' });

    expect(res.status).toBe(200);
    expect(res.body.milestoneBranching).toBe('flat');
    expect(getMilestoneById('ms-branching-1')?.milestone_branching).toBe(
      'flat',
    );
  });

  it('clears the override back to null', async () => {
    const res = await request(makeApp())
      .patch('/api/milestones/ms-branching-1')
      .send({ milestoneBranching: null });

    expect(res.status).toBe(200);
    expect(res.body.milestoneBranching).toBeNull();
    expect(
      getMilestoneById('ms-branching-1')?.milestone_branching,
    ).toBeNull();
  });

  it('rejects an invalid value', async () => {
    const res = await request(makeApp())
      .patch('/api/milestones/ms-branching-1')
      .send({ milestoneBranching: 'bogus' });

    expect(res.status).toBe(400);
  });

  it('rejects a missing milestoneBranching field', async () => {
    const res = await request(makeApp())
      .patch('/api/milestones/ms-branching-1')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown milestone', async () => {
    const res = await request(makeApp())
      .patch('/api/milestones/does-not-exist')
      .send({ milestoneBranching: 'two_tier' });

    expect(res.status).toBe(404);
  });
});
