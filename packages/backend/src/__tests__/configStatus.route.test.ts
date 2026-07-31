import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const VALID_TOKEN = 'test-device-token';

vi.mock('../db/queries.js', () => ({
  getDeviceByToken: vi.fn((token: string) =>
    token === 'test-device-token'
      ? { id: 1, token: 'test-device-token', name: 'test-device' }
      : null,
  ),
  updateDeviceLastSeen: vi.fn(),
  getActiveDeviceCount: vi.fn().mockReturnValue(1),
}));

vi.mock('../config/dataDir.js', () => ({ getDataDir: vi.fn() }));

import { createConfigStatusRouter } from '../routes/configStatus.js';
import { requireDeviceAuth } from '../auth/DeviceAuth.js';
import { getDataDir } from '../config/dataDir.js';
import { DataDirConfigSource } from '../config/DataDirConfigSource.js';
import { _resetAppConfigCache } from '../config/appConfig.js';

/** Mirrors server.ts: requireDeviceAuth gates the route ahead of it. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', requireDeviceAuth);
  app.use('/api', createConfigStatusRouter());
  return app;
}

describe('GET /api/config/status', () => {
  let tmpDir: string;
  let prevXdgDataHome: string | undefined;
  const envKeys = ['NOTION_API_KEY', 'GITHUB_TOKEN', 'GITHUB_REPO'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    _resetAppConfigCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-configstatus-'));
    vi.mocked(getDataDir).mockReturnValue(tmpDir);
    // See config.appConfig.test.ts's ".env fallback merge" block: resolve()'s
    // own default DataDirConfigSource() call can bypass the mocked getDataDir
    // due to Vitest setupFile-ordering, so the real data dir must also point
    // at tmpDir via XDG_DATA_HOME to keep both paths in sync.
    prevXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpDir;
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    _resetAppConfigCache();
    if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgDataHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const k of envKeys) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
    vi.clearAllMocks();
  });

  it('rejects an unauthenticated request', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/config/status');
    expect(res.status).toBe(401);
  });

  it('rejects a request with an invalid device token', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/config/status')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('reports source and value for a non-secret field set in config.json', async () => {
    const src = new DataDirConfigSource();
    src.write({ server: { port: 4321 } });

    const app = buildApp();
    const res = await request(app)
      .get('/api/config/status')
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.fields['server.port']).toMatchObject({
      source: 'config.json',
      value: 4321,
    });
  });

  it('reports .env fallback source for a field empty in config.json but set in .env', async () => {
    process.env.GITHUB_REPO = 'env-owner/env-repo';
    const src = new DataDirConfigSource();
    src.write({ github: { repo: '' } });

    const app = buildApp();
    const res = await request(app)
      .get('/api/config/status')
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.fields['github.repo']).toMatchObject({
      source: 'env',
      value: 'env-owner/env-repo',
    });
  });

  it('redacts secret fields to presence and length only, never the raw value', async () => {
    const src = new DataDirConfigSource();
    src.write({ notion: { apiKey: 'ntn-super-secret-value' } });

    const app = buildApp();
    const res = await request(app)
      .get('/api/config/status')
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    const field = res.body.fields['notion.apiKey'];
    expect(field.value).toBeUndefined();
    expect(field.source).toBe('config.json');
    expect(field.present).toBe(true);
    expect(field.length).toBe('ntn-super-secret-value'.length);
    expect(JSON.stringify(res.body)).not.toContain('ntn-super-secret-value');
  });

  it('reports present=false, length=0, source=default for an unset secret field', async () => {
    const src = new DataDirConfigSource();
    src.write({});

    const app = buildApp();
    const res = await request(app)
      .get('/api/config/status')
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.fields['github.token']).toMatchObject({
      source: 'default',
      present: false,
      length: 0,
    });
  });
});
