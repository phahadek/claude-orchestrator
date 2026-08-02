/**
 * Regression test for the setup-router mount order in server.ts.
 *
 * server.ts mounts setupRouter, then createSetupModeGuard(), then
 * requireDeviceAuth, in that order — so requireDeviceAuth never runs for a
 * request that matches inside setupRouter. That's only safe because
 * setupRouter now gates itself (via requireSetupAccess). This test builds
 * the exact same mount order and proves an unauthenticated, non-loopback
 * write to a setup endpoint is still rejected — if a future change swaps
 * setupRouter for something that doesn't self-gate, this test fails.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockedFunction,
} from 'vitest';
import express from 'express';
import supertest from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../db/queries.js', () => ({
  countProjects: vi.fn().mockReturnValue(1),
  getDeviceByToken: vi.fn().mockReturnValue(null),
  updateDeviceLastSeen: vi.fn(),
  getActiveDeviceCount: vi.fn().mockReturnValue(1),
}));

vi.mock('../config/dataDir.js', () => ({
  getDataDir: vi.fn(() => os.tmpdir()),
}));

import setupRouter, { createSetupModeGuard } from '../routes/setup.js';
import { requireDeviceAuth } from '../auth/DeviceAuth.js';
import { getActiveDeviceCount } from '../db/queries.js';
import { getDataDir } from '../config/dataDir.js';
import { DataDirConfigSource } from '../config/DataDirConfigSource.js';
import {
  _setConfigSourceForTesting,
  _resetAppConfigCache,
} from '../config/appConfig.js';

const mockedGetActiveDeviceCount = getActiveDeviceCount as MockedFunction<
  typeof getActiveDeviceCount
>;
const mockedGetDataDir = getDataDir as MockedFunction<typeof getDataDir>;

/** Mirrors server.ts's mount order for the setup-router / auth-boundary slice. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', setupRouter);
  app.use('/api', createSetupModeGuard());
  app.use('/api', requireDeviceAuth);
  app.get('/api/protected', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('server.ts mount order: setupRouter ahead of requireDeviceAuth', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-mountorder-'));
    mockedGetDataDir.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    _resetAppConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('rejects an unauthenticated write to /setup/save-credentials once setup is complete, despite mount order', async () => {
    const src = new DataDirConfigSource(tmpDir);
    src.write({
      github: { token: 'ghp-existing', repo: '' },
      setupComplete: true,
    });
    _setConfigSourceForTesting(src);
    mockedGetActiveDeviceCount.mockReturnValue(1);

    const res = await supertest(buildApp())
      .post('/api/setup/save-credentials')
      .send({ githubToken: 'ghp-attacker' });

    expect(res.status).toBe(401);
    const cfg = new DataDirConfigSource(tmpDir).read();
    expect(cfg.github.token).toBe('ghp-existing');
  });

  it('rejects an unauthenticated write to /setup/complete once setup is already complete', async () => {
    const src = new DataDirConfigSource(tmpDir);
    src.write({ setupComplete: true });
    _setConfigSourceForTesting(src);
    mockedGetActiveDeviceCount.mockReturnValue(1);

    const res = await supertest(buildApp()).post('/api/setup/complete');
    expect(res.status).toBe(401);
  });

  it('still allows a genuine first run to complete setup from loopback (supertest connects via loopback)', async () => {
    const src = new DataDirConfigSource(tmpDir);
    _setConfigSourceForTesting(src);
    mockedGetActiveDeviceCount.mockReturnValue(0);

    const res = await supertest(buildApp())
      .post('/api/setup/save-credentials')
      .send({ githubToken: 'ghp-fresh-install', notionApiKey: 'ntn-fresh' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('still 503s a non-setup route while setup is genuinely pending', async () => {
    const src = new DataDirConfigSource(tmpDir);
    _setConfigSourceForTesting(src);
    mockedGetActiveDeviceCount.mockReturnValue(0);

    const res = await supertest(buildApp()).get('/api/protected');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('setup_required');
  });

  it('allows the non-setup route once setup completes and a device is authenticated', async () => {
    const src = new DataDirConfigSource(tmpDir);
    src.write({
      github: { token: 'ghp-x', repo: '' },
      setupComplete: true,
    });
    _setConfigSourceForTesting(src);
    mockedGetActiveDeviceCount.mockReturnValue(0);

    // requireDeviceAuth's own bootstrap fallback (0 devices, loopback) is
    // the only path through it here — proves the setup guard defers cleanly.
    const res = await supertest(buildApp()).get('/api/protected');
    expect(res.status).toBe(200);
  });
});
