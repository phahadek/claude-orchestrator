import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fetchGateReadiness,
  fetchNextRunnableGateItems,
  fetchGateItem,
  appendGateItemEvent,
  approveGateItem,
} from '../../scripts/gate-state-client.mjs';

let server: http.Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function startFixtureServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<number> {
  return new Promise((resolvePort) => {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolvePort((server!.address() as AddressInfo).port);
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

describe('gate-state-client.mjs', () => {
  it('fetches gate readiness for a milestone', async () => {
    let receivedPath = '';
    let receivedAuth = '';
    const readiness = { status: 'blocked', blocking: [] };
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      receivedAuth = req.headers['authorization'] ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readiness));
    });

    const result = await fetchGateReadiness({
      port,
      token: 'device-token-1',
      milestone: 'M12',
    });

    expect(result.statusCode).toBe(200);
    expect(receivedPath).toBe('/api/gate/readiness?milestone=M12');
    expect(receivedAuth).toBe('Bearer device-token-1');
    expect(JSON.parse(result.body)).toEqual(readiness);
  });

  it('pulls the next runnable tier scoped by classification and limit', async () => {
    let receivedPath = '';
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });

    await fetchNextRunnableGateItems({
      port,
      token: 't',
      milestone: 'M12',
      classification: 'Read-Only',
      limit: 5,
    });

    expect(receivedPath).toBe(
      '/api/gate/next?milestone=M12&classification=Read-Only&limit=5',
    );
  });

  it('omits classification and limit when not given', async () => {
    let receivedPath = '';
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });

    await fetchNextRunnableGateItems({ port, token: 't', milestone: 'M12' });

    expect(receivedPath).toBe('/api/gate/next?milestone=M12');
  });

  it('fetches a single gate item by id', async () => {
    let receivedPath = '';
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'gi-1' }));
    });

    const result = await fetchGateItem({ port, token: 't', gateItemId: 'gi-1' });

    expect(receivedPath).toBe('/api/gate/items/gi-1');
    expect(JSON.parse(result.body)).toEqual({ id: 'gi-1' });
  });

  it('posts a disposition event for a gate item', async () => {
    let receivedPath = '';
    let receivedMethod = '';
    let receivedBody = '';
    const port = await startFixtureServer(async (req, res) => {
      receivedPath = req.url ?? '';
      receivedMethod = req.method ?? '';
      receivedBody = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'gi-1', state: 'pass' }));
    });

    const result = await appendGateItemEvent({
      port,
      token: 't',
      gateItemId: 'gi-1',
      event: { disposition: 'pass', evidence: 'clicked through checkout' },
    });

    expect(receivedMethod).toBe('POST');
    expect(receivedPath).toBe('/api/gate/items/gi-1/events');
    expect(JSON.parse(receivedBody)).toEqual({
      disposition: 'pass',
      evidence: 'clicked through checkout',
    });
    expect(JSON.parse(result.body)).toEqual({ id: 'gi-1', state: 'pass' });
  });

  it('approves a Prod-Mutating gate item pending consent', async () => {
    let receivedPath = '';
    let receivedBody = '';
    const port = await startFixtureServer(async (req, res) => {
      receivedPath = req.url ?? '';
      receivedBody = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'gi-2', state: 'pass' }));
    });

    await approveGateItem({
      port,
      token: 't',
      gateItemId: 'gi-2',
      operator: 'pedro',
    });

    expect(receivedPath).toBe('/api/gate/items/gi-2/approve');
    expect(JSON.parse(receivedBody)).toEqual({ operator: 'pedro' });
  });

  it('surfaces a non-2xx status and error body on failure', async () => {
    const port = await startFixtureServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'gate item event failed' }));
    });

    const result = await appendGateItemEvent({
      port,
      token: 't',
      gateItemId: 'gi-1',
      event: { disposition: 'fail' },
    });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'gate item event failed',
    });
  });
});
