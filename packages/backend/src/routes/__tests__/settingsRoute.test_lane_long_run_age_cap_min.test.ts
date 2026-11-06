import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

vi.mock('../../audit/AuditLog', () => ({
  recordEvent: vi.fn(),
  getCapabilityDispositionEvents: () => [],
}));

vi.mock('../../db/db', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import settingsRouter from '../settings';
import { db } from '../../db/db';
import { typedGetSetting } from '../../config/settings';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', settingsRouter);
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM settings').run();
});

describe('test_lane_long_run_age_cap_min on /api/settings', () => {
  it('defaults to 10', async () => {
    expect(typedGetSetting('test_lane_long_run_age_cap_min')).toBe(10);
    const res = await supertest(buildApp()).get('/');
    expect(res.body.test_lane_long_run_age_cap_min).toBe('10');
  });

  it('PATCH persists a positive integer', async () => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ test_lane_long_run_age_cap_min: 15 });
    expect(res.status).toBe(200);
    expect(typedGetSetting('test_lane_long_run_age_cap_min')).toBe(15);
  });

  it.each([0, -1, 1.5, 'abc'])('PATCH rejects %s', async (bad) => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ test_lane_long_run_age_cap_min: bad });
    expect(res.status).toBe(400);
    expect(typedGetSetting('test_lane_long_run_age_cap_min')).toBe(10);
  });
});
