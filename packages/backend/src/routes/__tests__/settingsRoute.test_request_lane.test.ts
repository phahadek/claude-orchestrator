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
import { getGlobalTestRunLimit } from '../../orchestration/testRequestLane';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', settingsRouter);
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM settings').run();
});

describe('test-lane settings on /api/settings', () => {
  it('GET reports defaults when unset', async () => {
    const res = await supertest(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.test_request_max_concurrent).toBe('2');
    expect(res.body.test_request_memory_ceiling_mb).toBe('0');
    expect(res.body.test_request_per_run_memory_mb).toBe('1024');
  });

  it('PATCH test_request_max_concurrent persists and drives the lane limit', async () => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ test_request_max_concurrent: 4 });
    expect(res.status).toBe(200);
    expect(res.body.updated.test_request_max_concurrent).toBe(4);
    expect(res.body.current.test_request_max_concurrent).toBe('4');
    expect(typedGetSetting('test_request_max_concurrent')).toBe(4);
    expect(getGlobalTestRunLimit()).toBe(4);
  });

  it('memory ceiling caps the lane limit', async () => {
    const res = await supertest(buildApp()).patch('/').send({
      test_request_max_concurrent: 4,
      test_request_memory_ceiling_mb: 3072,
      test_request_per_run_memory_mb: 1024,
    });
    expect(res.status).toBe(200);
    expect(getGlobalTestRunLimit()).toBe(3);
  });

  it('PATCH test_request_max_concurrent: 0 returns 400 and persists nothing', async () => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ test_request_max_concurrent: 0 });
    expect(res.status).toBe(400);
    expect(typedGetSetting('test_request_max_concurrent')).toBe(2);
    expect(
      db
        .prepare('SELECT 1 FROM settings WHERE key = ?')
        .get('test_request_max_concurrent'),
    ).toBeUndefined();
  });
});
