/**
 * Tests for the per-flow arm routes (packages/backend/src/routes/milestones.ts).
 *
 * AC: PUT upserts and writes a flow_arm_changed audit row with the previous
 * value; GET returns effective per-flow state with source.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { db } from '../../db/db.js';
import { createMilestonesRouter } from '../milestones.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createMilestonesRouter());
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM flow_arm').run();
  db.prepare('DELETE FROM audit_log').run();
});

describe('GET /api/milestones/:milestoneId/arm', () => {
  it('returns effective per-flow state with source, defaulting absent flows', async () => {
    const res = await request(makeApp()).get('/api/milestones/m1/arm');

    expect(res.status).toBe(200);
    expect(res.body.groom).toEqual({ armed: true, source: 'default' });
    expect(res.body.design).toEqual({ armed: false, source: 'default' });
    expect(res.body.ops).toEqual({ armed: false, source: 'default' });
    expect(res.body['gate-verify']).toEqual({ armed: true, source: 'default' });
  });
});

describe('PUT /api/milestones/:milestoneId/arm/:flow', () => {
  it('upserts the arm value and reflects it in a subsequent GET', async () => {
    const putRes = await request(makeApp())
      .put('/api/milestones/m1/arm/design')
      .send({ armed: true });

    expect(putRes.status).toBe(200);
    expect(putRes.body).toEqual({
      milestoneId: 'm1',
      flow: 'design',
      armed: true,
    });

    const getRes = await request(makeApp()).get('/api/milestones/m1/arm');
    expect(getRes.body.design).toEqual({ armed: true, source: 'row' });
  });

  it('writes a flow_arm_changed audit row carrying the previous value', async () => {
    await request(makeApp())
      .put('/api/milestones/m1/arm/groom')
      .send({ armed: false });

    const rows = db
      .prepare(`SELECT * FROM audit_log WHERE event_type = 'flow_arm_changed'`)
      .all() as Array<{ payload: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload);
    expect(payload).toEqual({
      milestone: 'm1',
      flow: 'groom',
      armed: false,
      previous: true,
    });
  });

  it('rejects an unknown flow', async () => {
    const res = await request(makeApp())
      .put('/api/milestones/m1/arm/nope')
      .send({ armed: true });
    expect(res.status).toBe(400);
  });

  it('rejects a non-boolean armed value', async () => {
    const res = await request(makeApp())
      .put('/api/milestones/m1/arm/groom')
      .send({ armed: 'yes' });
    expect(res.status).toBe(400);
  });
});
