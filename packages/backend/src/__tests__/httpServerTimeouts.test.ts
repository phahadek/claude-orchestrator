import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';
import express from 'express';
import {
  KEEP_ALIVE_ACTUAL_MS,
  KEEP_ALIVE_ADVERTISED_S,
  applyHttpServerTimeouts,
  advertiseKeepAlive,
} from '../httpServerTimeouts';

const servers: http.Server[] = [];

function start(
  keepAliveMs?: number,
  advertisedS?: number,
): Promise<http.Server> {
  const app = express();
  app.use(advertiseKeepAlive(advertisedS));
  app.get('/', (_req, res) => {
    res.json({ ok: true });
  });
  const server = http.createServer(app);
  applyHttpServerTimeouts(server, keepAliveMs);
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server)),
  );
}

function get(
  server: http.Server,
  agent?: http.Agent,
): Promise<http.IncomingMessage> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, agent }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

describe('httpServerTimeouts', () => {
  it('sets keepAliveTimeout and keeps headersTimeout <= requestTimeout', async () => {
    const server = await start();
    expect(server.keepAliveTimeout).toBe(310000);
    expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout);
  });

  it('sends exactly one Keep-Alive header equal to timeout=300', async () => {
    const server = await start();
    const res = await get(server, new http.Agent({ keepAlive: true }));
    const raw = res.rawHeaders.filter(
      (h, i) => i % 2 === 0 && /^keep-alive$/i.test(h),
    );
    expect(raw).toHaveLength(1);
    expect(res.headers['keep-alive']).toBe('timeout=300');
  });

  it('advertises at least 5 s below the actual timeout', () => {
    expect(KEEP_ALIVE_ADVERTISED_S * 1000).toBeLessThanOrEqual(
      KEEP_ALIVE_ACTUAL_MS - 5000,
    );
  });

  it('keeps a connection open past the advertised timeout but before the actual one', async () => {
    // scaled down: advertised 1 s, actual 3 s
    const server = await start(3000, 1);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const first = await get(server, agent);
    const socket1 = first.socket;
    await new Promise((r) => setTimeout(r, 1500));
    expect(socket1.destroyed).toBe(false);
    const second = await get(server, agent);
    expect(second.statusCode).toBe(200);
    expect(second.socket).toBe(socket1);
    agent.destroy();
  });

  it('server.ts applies the timeouts to the server it listens on', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server.ts'),
      'utf8',
    );
    expect(src).toMatch(
      /const server = http\.createServer\(app\);\s*applyHttpServerTimeouts\(server\);/,
    );
    expect(src).toMatch(/app\.use\(advertiseKeepAlive\(\)\)/);
    expect(src).toMatch(/^\s*server,\s*\n\s*port: PORT,/m);
  });
});
