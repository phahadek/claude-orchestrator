import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/db.js', async () => {
  const { setupTestDb } = await import('../../../test/helpers/setupTestDb.js');
  return { db: setupTestDb() };
});

import { createAuthLapseRouter } from '../authLapse.js';
import {
  AuthLapseProbe,
  setAuthLapseProbe,
} from '../../orchestration/AuthLapseProbe.js';
import {
  clearAuthLapse,
  getAuthLapse,
  isAuthAdmitted,
} from '../../orchestration/authAdmission.js';
import { setCliAuthLapse } from '../../db/queries.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createAuthLapseRouter());
  return app;
}

const OK = {
  exitCode: 0,
  stdout: JSON.stringify({ type: 'result', result: 'ok' }),
};
const AUTH_FAIL = {
  exitCode: 1,
  stdout: JSON.stringify({
    type: 'result',
    is_error: true,
    result: 'Failed to authenticate',
  }),
};

function install(result: typeof OK) {
  const exec = vi.fn().mockResolvedValue(result);
  setAuthLapseProbe(new AuthLapseProbe({ exec, isActive: () => true }));
  return exec;
}

beforeEach(() => {
  clearAuthLapse();
});

describe('auth lapse state persistence', () => {
  it('is read from the DB, so a row written before "boot" gates admission', () => {
    expect(isAuthAdmitted().allowed).toBe(true);
    setCliAuthLapse(12345);
    expect(isAuthAdmitted()).toMatchObject({ allowed: false, since: 12345 });
    expect(getAuthLapse()).toEqual({ lapsed: true, since: 12345 });
  });
});

describe('auth lapse routes', () => {
  it('GET /api/auth-lapse reports the state', async () => {
    const res = await request(makeApp()).get('/api/auth-lapse');
    expect(res.body).toEqual({ lapsed: false });
    setCliAuthLapse(7);
    const res2 = await request(makeApp()).get('/api/auth-lapse');
    expect(res2.body).toEqual({ lapsed: true, since: 7 });
  });

  it('recheck runs a probe immediately and does not clear on failure', async () => {
    setCliAuthLapse(7);
    const exec = install(AUTH_FAIL);
    const res = await request(makeApp()).post('/api/auth-lapse/recheck');
    expect(res.status).toBe(200);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ outcome: 'auth_failure', lapsed: true });
    expect(getAuthLapse().lapsed).toBe(true);
  });

  it('recheck clears the state only on probe success', async () => {
    setCliAuthLapse(7);
    install(OK);
    const res = await request(makeApp()).post('/api/auth-lapse/recheck');
    expect(res.body).toMatchObject({ outcome: 'success', lapsed: false });
    expect(getAuthLapse().lapsed).toBe(false);
  });
});

describe('new-work-only gating', () => {
  it('SessionManager (respawnSession / sendOrResume) never consults the auth gate', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../session/SessionManager.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/authAdmission|isAuthAdmitted/);
  });
});
