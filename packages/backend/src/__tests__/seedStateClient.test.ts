import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fetchSeedReadiness,
  fetchNextApplyableSeedItems,
  fetchSeedItem,
  fetchSeedItemDetail,
  appendSeedItemEvent,
} from '../../scripts/seed-state-client.mjs';

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

describe('seed-state-client.mjs', () => {
  it('fetches seed readiness for a milestone', async () => {
    let receivedPath = '';
    let receivedAuth = '';
    const readiness = { status: 'blocked', blocking: [] };
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      receivedAuth = req.headers['authorization'] ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readiness));
    });

    const result = await fetchSeedReadiness({
      port,
      token: 'device-token-1',
      project: 'polimarket-analyser',
      milestone: 'M12',
    });

    expect(result.statusCode).toBe(200);
    expect(receivedPath).toBe(
      '/api/seed/readiness?project=polimarket-analyser&milestone=M12',
    );
    expect(receivedAuth).toBe('Bearer device-token-1');
    expect(JSON.parse(result.body)).toEqual(readiness);
  });

  it('pulls the next applyable batch scoped by deploySha and limit', async () => {
    let receivedPath = '';
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });

    await fetchNextApplyableSeedItems({
      port,
      token: 't',
      project: 'polimarket-analyser',
      milestone: 'M12',
      deploySha: 'abc123',
      limit: 1,
    });

    expect(receivedPath).toBe(
      '/api/seed/next?project=polimarket-analyser&milestone=M12&deploySha=abc123&limit=1',
    );
  });

  it('omits limit when not given', async () => {
    let receivedPath = '';
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });

    await fetchNextApplyableSeedItems({
      port,
      token: 't',
      project: 'polimarket-analyser',
      milestone: 'M12',
      deploySha: 'abc123',
    });

    expect(receivedPath).toBe(
      '/api/seed/next?project=polimarket-analyser&milestone=M12&deploySha=abc123',
    );
  });

  it('fetches a single seed item by id', async () => {
    let receivedPath = '';
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'si-1' }));
    });

    const result = await fetchSeedItem({
      port,
      token: 't',
      seedItemId: 'si-1',
    });

    expect(receivedPath).toBe('/api/seed/items/si-1');
    expect(JSON.parse(result.body)).toEqual({ id: 'si-1' });
  });

  it('fetches a seed item detail record', async () => {
    let receivedPath = '';
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'si-1', sources: [], events: [] }));
    });

    const result = await fetchSeedItemDetail({
      port,
      token: 't',
      seedItemId: 'si-1',
    });

    expect(receivedPath).toBe('/api/seed/items/si-1/detail');
    expect(JSON.parse(result.body)).toEqual({
      id: 'si-1',
      sources: [],
      events: [],
    });
  });

  it('posts an outcome event for a seed item', async () => {
    let receivedPath = '';
    let receivedMethod = '';
    let receivedBody = '';
    const port = await startFixtureServer(async (req, res) => {
      receivedPath = req.url ?? '';
      receivedMethod = req.method ?? '';
      receivedBody = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'si-1', state: 'confirmed' }));
    });

    const result = await appendSeedItemEvent({
      port,
      token: 't',
      seedItemId: 'si-1',
      event: { outcome: 'confirmed', evidence: 'row present, worker reloaded' },
    });

    expect(receivedMethod).toBe('POST');
    expect(receivedPath).toBe('/api/seed/items/si-1/events');
    expect(JSON.parse(receivedBody)).toEqual({
      outcome: 'confirmed',
      evidence: 'row present, worker reloaded',
    });
    expect(JSON.parse(result.body)).toEqual({ id: 'si-1', state: 'confirmed' });
  });

  it('surfaces a non-2xx status and error body on failure', async () => {
    const port = await startFixtureServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'seed_item si-1: a blocked outcome must carry a filedFollowon',
        }),
      );
    });

    const result = await appendSeedItemEvent({
      port,
      token: 't',
      seedItemId: 'si-1',
      event: { outcome: 'blocked' },
    });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({
      error: 'seed_item si-1: a blocked outcome must carry a filedFollowon',
    });
  });
});
