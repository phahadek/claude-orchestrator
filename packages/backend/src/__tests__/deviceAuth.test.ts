import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import * as fs from 'fs';
import * as path from 'path';

// ── Schema migration test ────────────────────────────────────────────────────

describe('schema.ts — devices table migration', () => {
  it('creates devices table in runMigrations()', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    expect(source).toMatch(/CREATE TABLE IF NOT EXISTS devices/);
  });

  it('includes all required columns', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.ts'),
      'utf-8',
    );
    const block = source.slice(
      source.indexOf('CREATE TABLE IF NOT EXISTS devices'),
      source.indexOf('CREATE TABLE IF NOT EXISTS devices') + 500,
    );
    expect(block).toMatch(/id\s+TEXT\s+PRIMARY KEY/);
    expect(block).toMatch(/token\s+TEXT\s+NOT NULL UNIQUE/);
    expect(block).toMatch(/revoked\s+INTEGER\s+NOT NULL DEFAULT 0/);
    expect(block).toMatch(/enrolled_at\s+INTEGER\s+NOT NULL/);
  });
});

// ── DeviceAuth middleware tests ─────────────────────────────────────────────

vi.mock('../db/queries', () => ({
  getGrantedCapabilities: vi.fn(() => []),
  getDeviceByToken: vi.fn(),
  updateDeviceLastSeen: vi.fn(),
  getActiveDeviceCount: vi.fn(),
}));

import { requireDeviceAuth, requireRunnerAuth } from '../auth/DeviceAuth.js';
import {
  createPublicEnrollmentRouter,
  createGatedEnrollmentRouter,
} from '../auth/Enrollment.js';
import * as queries from '../db/queries';

/** App wired like the real server: public enrollment before auth, gated after. */
function buildFullApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/enrollment', createPublicEnrollmentRouter());
  app.use('/api', requireDeviceAuth);
  app.get('/api/protected', (_req, res) => res.json({ ok: true }));
  app.use('/api/enrollment', createGatedEnrollmentRouter());
  return app;
}

/** Minimal app with requireDeviceAuth as global middleware (no public bypass). */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requireDeviceAuth);
  app.get('/api/protected', (_req, res) => res.json({ ok: true }));
  app.post('/api/enrollment/approve', (_req, res) =>
    res.json({ approve: true }),
  );
  return app;
}

const mockDevice = {
  id: 'device-1',
  name: 'Test Device',
  user_agent: null,
  last_ip: null,
  last_seen: null,
  enrolled_at: Date.now(),
  token: 'valid-token-abc',
  revoked: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireDeviceAuth middleware', () => {
  it('rejects POST /api/enrollment/approve without auth when devices are enrolled', async () => {
    vi.mocked(queries.getActiveDeviceCount).mockReturnValue(1);
    const res = await supertest(buildApp())
      .post('/api/enrollment/approve')
      .send({ code: '123456' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'unauthorized' });
  });

  it('GET /api/enrollment/bootstrap returns 200 even with devices enrolled (public route)', async () => {
    vi.mocked(queries.getActiveDeviceCount).mockReturnValue(1);
    const res = await supertest(buildFullApp()).get(
      '/api/enrollment/needs-bootstrap',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsBootstrap: false });
  });

  it('returns 401 when no token and devices are enrolled', async () => {
    vi.mocked(queries.getActiveDeviceCount).mockReturnValue(1);
    const res = await supertest(buildApp()).get('/api/protected');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'unauthorized' });
  });

  it('passes request when no token and no devices enrolled (bootstrap)', async () => {
    vi.mocked(queries.getActiveDeviceCount).mockReturnValue(0);
    const res = await supertest(buildApp()).get('/api/protected');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('allows request with valid token and updates last_seen', async () => {
    vi.mocked(queries.getDeviceByToken).mockReturnValue(mockDevice as never);
    vi.mocked(queries.updateDeviceLastSeen).mockReturnValue(undefined);
    const res = await supertest(buildApp())
      .get('/api/protected')
      .set('Authorization', 'Bearer valid-token-abc');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(queries.updateDeviceLastSeen).toHaveBeenCalledWith(
      'device-1',
      expect.anything(),
      expect.any(Number),
    );
  });

  describe('last_seen throttling', () => {
    function authedGet(app: express.Express, ip?: string) {
      const req = supertest(app)
        .get('/api/protected')
        .set('Authorization', 'Bearer t');
      return ip ? req.set('X-Forwarded-For', ip) : req;
    }
    function useDevice(id: string, role = 'device') {
      vi.mocked(queries.getDeviceByToken).mockReturnValue({
        ...mockDevice,
        id,
        role,
      } as never);
    }
    function buildRunnerApp() {
      const app = express();
      app.use(requireRunnerAuth);
      app.get('/api/protected', (_req, res) => res.json({ ok: true }));
      return app;
    }

    it('writes once for repeated requests from the same device and IP within 60s', async () => {
      useDevice('throttle-same');
      const app = buildApp();
      await authedGet(app, '1.1.1.1');
      await authedGet(app, '1.1.1.1');
      expect(queries.updateDeviceLastSeen).toHaveBeenCalledTimes(1);
    });

    it('writes again when the IP changes within 60s', async () => {
      useDevice('throttle-ip');
      const app = buildApp();
      await authedGet(app, '1.1.1.1');
      await authedGet(app, '2.2.2.2');
      expect(queries.updateDeviceLastSeen).toHaveBeenCalledTimes(2);
    });

    it('writes again after 60s', async () => {
      useDevice('throttle-time');
      const app = buildApp();
      const base = Date.now();
      const spy = vi.spyOn(Date, 'now').mockReturnValue(base);
      try {
        await authedGet(app, '1.1.1.1');
        spy.mockReturnValue(base + 59_000);
        await authedGet(app, '1.1.1.1');
        expect(queries.updateDeviceLastSeen).toHaveBeenCalledTimes(1);
        spy.mockReturnValue(base + 60_000);
        await authedGet(app, '1.1.1.1');
        expect(queries.updateDeviceLastSeen).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('throttles the runner path the same way', async () => {
      useDevice('throttle-runner', 'runner');
      const app = buildRunnerApp();
      await supertest(app)
        .get('/api/protected')
        .set('Authorization', 'Bearer t');
      await supertest(app)
        .get('/api/protected')
        .set('Authorization', 'Bearer t');
      expect(queries.updateDeviceLastSeen).toHaveBeenCalledTimes(1);
    });

    it('throttles different devices independently', async () => {
      const app = buildApp();
      useDevice('throttle-a');
      await authedGet(app, '1.1.1.1');
      useDevice('throttle-b');
      await authedGet(app, '1.1.1.1');
      useDevice('throttle-a');
      await authedGet(app, '1.1.1.1');
      expect(queries.updateDeviceLastSeen).toHaveBeenCalledTimes(2);
    });
  });

  it('returns 401 for revoked / unknown token', async () => {
    vi.mocked(queries.getDeviceByToken).mockReturnValue(null);
    const res = await supertest(buildApp())
      .get('/api/protected')
      .set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'invalid_token' });
  });
});
