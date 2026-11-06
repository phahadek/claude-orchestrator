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
import {
  acquireAnalyzePermit,
  __resetAnalyzeSemaphoreForTest,
} from '../../github/analyzeSemaphore';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', settingsRouter);
  return app;
}

beforeEach(() => {
  db.prepare('DELETE FROM settings').run();
  __resetAnalyzeSemaphoreForTest();
});

describe('analyze_max_concurrent on /api/settings', () => {
  it('defaults to 2 when absent', async () => {
    expect(typedGetSetting('analyze_max_concurrent')).toBe(2);
    const res = await supertest(buildApp()).get('/');
    expect(res.body.analyze_max_concurrent).toBe('2');
  });

  it('PATCH persists a positive integer', async () => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ analyze_max_concurrent: 3 });
    expect(res.status).toBe(200);
    expect(typedGetSetting('analyze_max_concurrent')).toBe(3);
  });

  it.each([0, 1.5, 'abc'])('PATCH rejects %s', async (bad) => {
    const res = await supertest(buildApp())
      .patch('/')
      .send({ analyze_max_concurrent: bad });
    expect(res.status).toBe(400);
    expect(typedGetSetting('analyze_max_concurrent')).toBe(2);
  });

  it('resizing up admits parked waiters without leaking or double-spending permits', async () => {
    const app = buildApp();
    await supertest(app).patch('/').send({ analyze_max_concurrent: 1 });
    const releaseFirst = await acquireAnalyzePermit();

    let secondGranted = false;
    let thirdGranted = false;
    const second = acquireAnalyzePermit().then((r) => {
      secondGranted = true;
      return r;
    });
    const third = acquireAnalyzePermit().then((r) => {
      thirdGranted = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(secondGranted).toBe(false);
    expect(thirdGranted).toBe(false);

    await supertest(app).patch('/').send({ analyze_max_concurrent: 3 });
    const [releaseSecond, releaseThird] = await Promise.all([second, third]);
    expect(secondGranted && thirdGranted).toBe(true);

    // All 3 slots now held: a fourth must wait.
    let fourthGranted = false;
    const fourth = acquireAnalyzePermit().then((r) => {
      fourthGranted = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(fourthGranted).toBe(false);

    releaseFirst();
    const releaseFourth = await fourth;
    expect(fourthGranted).toBe(true);
    releaseSecond();
    releaseThird();
    releaseFourth();

    // Fully released: three immediate acquires succeed, a fourth waits.
    const held = await Promise.all([
      acquireAnalyzePermit(),
      acquireAnalyzePermit(),
      acquireAnalyzePermit(),
    ]);
    let extra = false;
    const extraP = acquireAnalyzePermit().then((r) => {
      extra = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(extra).toBe(false);
    held[0]();
    (await extraP)();
    held[1]();
    held[2]();
  });
});
