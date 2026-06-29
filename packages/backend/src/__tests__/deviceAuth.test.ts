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
  getDeviceByToken: vi.fn(),
  updateDeviceLastSeen: vi.fn(),
  getActiveDeviceCount: vi.fn(),
}));

import { requireDeviceAuth } from '../auth/DeviceAuth.js';
import * as queries from '../db/queries';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requireDeviceAuth);
  app.get('/api/protected', (_req, res) => res.json({ ok: true }));
  app.get('/api/enrollment/bootstrap', (_req, res) =>
    res.json({ bootstrap: true }),
  );
  app.get('/api/enrollment/request', (_req, res) =>
    res.json({ request: true }),
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
  it('rejects /api/enrollment/approve without auth when devices are enrolled', async () => {
    vi.mocked(queries.getActiveDeviceCount).mockReturnValue(1);
    const res = await supertest(buildApp()).get('/api/enrollment/bootstrap');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'unauthorized' });
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

  it('returns 401 for revoked / unknown token', async () => {
    vi.mocked(queries.getDeviceByToken).mockReturnValue(null);
    const res = await supertest(buildApp())
      .get('/api/protected')
      .set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'invalid_token' });
  });
});
