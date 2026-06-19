import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import type { Request, Response } from 'express';

// ── resolveBindHost ──────────────────────────────────────────────────────────

vi.mock('../config/corporateMode.js', () => ({
  getCorporateMode: vi.fn(),
  _resetCorporateModeCache: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getCorporateMode } from '../config/corporateMode.js';
import { logger } from '../logger.js';
import { resolveBindHost } from '../bootSequence.js';

function makeCorporateMode(enabled: boolean) {
  return {
    enabled,
    envLocked: enabled,
    gates: {
      dockerMandatory: enabled,
      requireHumanApproval: enabled,
      requireZDR: enabled,
      validatePRBody: enabled,
      secretsViaSeam: enabled,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ORCHESTRATOR_BIND_HOST;
});

afterEach(() => {
  delete process.env.ORCHESTRATOR_BIND_HOST;
});

describe('resolveBindHost', () => {
  it('returns 127.0.0.1 when ORCHESTRATOR_BIND_HOST is unset', () => {
    vi.mocked(getCorporateMode).mockReturnValue(makeCorporateMode(false));
    expect(resolveBindHost()).toBe('127.0.0.1');
  });

  it('returns the env value when set to a non-loopback address', () => {
    process.env.ORCHESTRATOR_BIND_HOST = '192.168.1.100';
    vi.mocked(getCorporateMode).mockReturnValue(makeCorporateMode(false));
    expect(resolveBindHost()).toBe('192.168.1.100');
  });

  it('returns 0.0.0.0 when env is set to 0.0.0.0 in personal mode', () => {
    process.env.ORCHESTRATOR_BIND_HOST = '0.0.0.0';
    vi.mocked(getCorporateMode).mockReturnValue(makeCorporateMode(false));
    expect(resolveBindHost()).toBe('0.0.0.0');
  });

  it('returns 127.0.0.1 and logs a warning when corporate mode overrides a non-loopback env', () => {
    process.env.ORCHESTRATOR_BIND_HOST = '192.168.1.100';
    vi.mocked(getCorporateMode).mockReturnValue(makeCorporateMode(true));
    expect(resolveBindHost()).toBe('127.0.0.1');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('corporate mode'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('192.168.1.100'),
    );
  });

  it('does not warn when corporate mode and env is already loopback', () => {
    process.env.ORCHESTRATOR_BIND_HOST = '127.0.0.1';
    vi.mocked(getCorporateMode).mockReturnValue(makeCorporateMode(true));
    expect(resolveBindHost()).toBe('127.0.0.1');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not warn when corporate mode and env is unset', () => {
    vi.mocked(getCorporateMode).mockReturnValue(makeCorporateMode(true));
    expect(resolveBindHost()).toBe('127.0.0.1');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ── isLoopbackIp ─────────────────────────────────────────────────────────────

import { isLoopbackIp } from '../auth/DeviceAuth.js';

describe('isLoopbackIp', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.2'])(
    'returns true for loopback address %s',
    (addr) => {
      expect(isLoopbackIp(addr)).toBe(true);
    },
  );

  it.each(['192.168.1.1', '10.0.0.1', '0.0.0.0', '172.16.0.1', ''])(
    'returns false for non-loopback address %s',
    (addr) => {
      expect(isLoopbackIp(addr)).toBe(false);
    },
  );
});

// ── Bootstrap loopback gate (HTTP — requireDeviceAuth) ───────────────────────

vi.mock('../db/queries.js', () => ({
  getDeviceByToken: vi.fn(),
  updateDeviceLastSeen: vi.fn(),
  getActiveDeviceCount: vi.fn(),
}));

import { requireDeviceAuth } from '../auth/DeviceAuth.js';
import * as queries from '../db/queries.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requireDeviceAuth);
  app.get('/api/protected', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('requireDeviceAuth — bootstrap loopback gate', () => {
  it('passes a loopback connection during the bootstrap window (no devices enrolled)', async () => {
    vi.mocked(queries.getActiveDeviceCount).mockReturnValue(0);
    // supertest connects from loopback (::1 or ::ffff:127.0.0.1)
    const res = await supertest(buildApp()).get('/api/protected');
    expect(res.status).toBe(200);
  });

  it('rejects a non-loopback connection during the bootstrap window with 403', () => {
    vi.mocked(queries.getActiveDeviceCount).mockReturnValue(0);

    const req = {
      path: '/api/protected',
      headers: {},
      socket: { remoteAddress: '192.168.1.50' },
    } as unknown as Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;

    const next = vi.fn();

    requireDeviceAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'bootstrap_loopback_only' }),
    );
  });

  it('still rejects unauthenticated requests when devices are enrolled', async () => {
    vi.mocked(queries.getActiveDeviceCount).mockReturnValue(1);
    const res = await supertest(buildApp()).get('/api/protected');
    expect(res.status).toBe(401);
  });
});
