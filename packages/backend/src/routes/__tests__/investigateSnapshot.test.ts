import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { insertProject } from '../../db/queries.js';
import { createInvestigateSnapshotRouter } from '../investigateSnapshot';

const PID = 'inv-snap-route-project';

function buildApp() {
  const app = express();
  app.use('/api', (req, res, next) => {
    if (req.headers.authorization !== 'Bearer good') {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });
  app.use('/api', createInvestigateSnapshotRouter());
  return app;
}

describe('GET /api/investigate-snapshot', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM projects').run();
    insertProject({
      id: PID,
      name: 'Route Project',
      project_dir: '/nonexistent/route',
      context_url: null,
      github_repo: null,
      task_source: 'notion',
    });
  });

  it('returns 200 with the snapshot shape', async () => {
    const res = await supertest(buildApp())
      .get(`/api/investigate-snapshot?project=${PID}`)
      .set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe(PID);
    expect(Object.keys(res.body.health).sort()).toEqual([
      'erroredSessions',
      'needsAttentionPRs',
      'recentAuditEvents',
      'recentDeploys',
      'recentPlanningSessions',
    ]);
  });

  it('returns 401 without a bearer', async () => {
    const res = await supertest(buildApp()).get(
      `/api/investigate-snapshot?project=${PID}`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 without project', async () => {
    const res = await supertest(buildApp())
      .get('/api/investigate-snapshot')
      .set('Authorization', 'Bearer good');
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown project', async () => {
    const res = await supertest(buildApp())
      .get('/api/investigate-snapshot?project=nope')
      .set('Authorization', 'Bearer good');
    expect(res.status).toBe(404);
  });
});
