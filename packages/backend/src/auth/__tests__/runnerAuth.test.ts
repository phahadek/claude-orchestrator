import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import https from 'https';
import net from 'net';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const devices = new Map<string, Record<string, unknown>>();

vi.mock('../../db/queries', () => ({
  getGrantedCapabilities: vi.fn(() => []),
  insertDevice: vi.fn((d: Record<string, unknown>) => {
    devices.set(d.token as string, { revoked: 0, role: 'operator', ...d });
  }),
  getDeviceById: vi.fn(),
  listDevices: vi.fn(() => []),
  updateDeviceName: vi.fn(),
  revokeDevice: vi.fn(),
  getActiveDeviceCount: vi.fn(() => devices.size),
  getDeviceByToken: vi.fn((t: string) => {
    const d = devices.get(t);
    return d && d.revoked === 0 ? d : null;
  }),
  updateDeviceLastSeen: vi.fn(),
}));

vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config', () => ({
  RUNNER_TLS_CERT_PATH: '',
  RUNNER_TLS_KEY_PATH: '',
  RUNNER_LISTENER_PORT: 0,
  RUNNER_LISTENER_HOST: '127.0.0.1',
}));

import { enrollRunner, bootstrapEnroll } from '../Enrollment';
import {
  requireDeviceAuth,
  requireRunnerAuth,
  validateWsToken,
} from '../DeviceAuth';
import { createRunnerApp } from '../../routes/runnerChannel';

function mainApp() {
  const app = express();
  app.use(requireDeviceAuth);
  app.get('/api/thing', (_req, res) => res.json({ ok: true }));
  return app;
}

let runnerToken: string;
let operatorToken: string;

beforeEach(() => {
  devices.clear();
  operatorToken = bootstrapEnroll('op', 'ua', '127.0.0.1')!.token;
  runnerToken = enrollRunner('runner-1', '10.0.0.5').token;
});

describe('runner device enrollment', () => {
  it('stores role runner', () => {
    expect(devices.get(runnerToken)?.role).toBe('runner');
    expect(devices.get(operatorToken)?.role).toBe('operator');
  });
});

describe('role separation', () => {
  it('runner token is rejected on non-runner routes', async () => {
    const res = await supertest(mainApp())
      .get('/api/thing')
      .set('Authorization', `Bearer ${runnerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('runner_token_not_permitted');
  });

  it('runner token is rejected on the main websocket', () => {
    expect(validateWsToken(runnerToken)).toBeNull();
    expect(validateWsToken(operatorToken)).not.toBeNull();
  });

  it('non-runner device token is rejected on runner routes', async () => {
    const res = await supertest(createRunnerApp())
      .get('/api/runner/poll')
      .set('Authorization', `Bearer ${operatorToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('runner_role_required');
  });

  it('rejects missing, unknown and revoked runner tokens', async () => {
    const app = createRunnerApp();
    expect((await supertest(app).get('/api/runner/poll')).status).toBe(401);
    expect(
      (
        await supertest(app)
          .get('/api/runner/poll')
          .set('Authorization', 'Bearer nope')
      ).status,
    ).toBe(401);
    devices.get(runnerToken)!.revoked = 1;
    expect(
      (
        await supertest(app)
          .get('/api/runner/poll')
          .set('Authorization', `Bearer ${runnerToken}`)
      ).status,
    ).toBe(401);
  });

  it('requireRunnerAuth has no bootstrap exception', async () => {
    devices.clear();
    const app = express();
    app.use(requireRunnerAuth);
    app.get('/x', (_req, res) => res.json({}));
    expect((await supertest(app).get('/x')).status).toBe(401);
  });
});

describe('runner listener', () => {
  it('serves only runner routes', async () => {
    const app = createRunnerApp();
    const auth = { Authorization: `Bearer ${runnerToken}` };
    expect(
      (await supertest(app).get('/api/sessions').set(auth)).status,
    ).toBe(404);
    expect(
      (await supertest(app).get('/api/enrollment/devices').set(auth)).status,
    ).toBe(404);
  });

  it('poll response (empty queue) carries no secret content', async () => {
    const res = await supertest(createRunnerApp())
      .get('/api/runner/poll')
      .set('Authorization', `Bearer ${runnerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ work: [] });
    expect(JSON.stringify(res.body)).not.toMatch(/\.env|SECRET|KEY|TOKEN/i);
  });

  it('plaintext connection to the TLS listener fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-tls-'));
    const keyPath = path.join(dir, 'k.pem');
    const certPath = path.join(dir, 'c.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=localhost',
    ], { stdio: 'ignore' });
    const server = https.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      createRunnerApp(),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as net.AddressInfo;
    try {
      const plain = await new Promise<string>((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(
            `GET /api/runner/poll HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${runnerToken}\r\n\r\n`,
          );
        });
        let data = '';
        sock.on('data', (c) => (data += c.toString('latin1')));
        sock.on('close', () => resolve(data));
        sock.on('error', () => resolve(data));
        setTimeout(() => {
          sock.destroy();
          resolve(data);
        }, 2000);
      });
      expect(plain).not.toMatch(/HTTP\/1\.1 200/);
      expect(plain).not.toMatch(/"work"/);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

afterAll(() => devices.clear());
