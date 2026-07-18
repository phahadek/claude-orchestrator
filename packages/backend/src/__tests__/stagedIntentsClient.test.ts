import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createStagedIntent,
  applyStagedIntent,
  rejectStagedIntent,
  listStagedIntents,
} from '../../scripts/staged-intents-client.mjs';

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

describe('staged-intents-client.mjs', () => {
  it('creates a staged intent with the device-auth header', async () => {
    let receivedPath = '';
    let receivedMethod = '';
    let receivedAuth = '';
    let receivedBody = '';
    const port = await startFixtureServer(async (req, res) => {
      receivedPath = req.url ?? '';
      receivedMethod = req.method ?? '';
      receivedAuth = req.headers['authorization'] ?? '';
      receivedBody = await readBody(req);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'intent-1' }));
    });

    const result = await createStagedIntent({
      port,
      token: 'device-token-1',
      kind: 'task.setStatus',
      payload: { taskId: 't-1', status: 'Ready' },
      projectId: 'proj-1',
      groupId: 'grp-1',
    });

    expect(receivedMethod).toBe('POST');
    expect(receivedPath).toBe('/api/staged-intents');
    expect(receivedAuth).toBe('Bearer device-token-1');
    expect(JSON.parse(receivedBody)).toEqual({
      kind: 'task.setStatus',
      payload: { taskId: 't-1', status: 'Ready' },
      projectId: 'proj-1',
      groupId: 'grp-1',
    });
    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body)).toEqual({ id: 'intent-1' });
  });

  it('omits groupId when not given', async () => {
    let receivedBody = '';
    const port = await startFixtureServer(async (req, res) => {
      receivedBody = await readBody(req);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'intent-2' }));
    });

    await createStagedIntent({
      port,
      token: 't',
      kind: 'task.setDependsOn',
      payload: { taskId: 't-1', dependsOn: [] },
      projectId: 'proj-1',
    });

    expect(JSON.parse(receivedBody)).toEqual({
      kind: 'task.setDependsOn',
      payload: { taskId: 't-1', dependsOn: [] },
      projectId: 'proj-1',
    });
  });

  it('applies a staged intent with the device-auth header', async () => {
    let receivedPath = '';
    let receivedMethod = '';
    let receivedAuth = '';
    let receivedBody = '';
    const port = await startFixtureServer(async (req, res) => {
      receivedPath = req.url ?? '';
      receivedMethod = req.method ?? '';
      receivedAuth = req.headers['authorization'] ?? '';
      receivedBody = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    const result = await applyStagedIntent({
      port,
      token: 'device-token-1',
      intentId: 'intent-1',
    });

    expect(receivedMethod).toBe('POST');
    expect(receivedPath).toBe('/api/staged-intents/intent-1/apply');
    expect(receivedAuth).toBe('Bearer device-token-1');
    expect(JSON.parse(receivedBody)).toEqual({});
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  });

  it('passes override + reason when applying with an override', async () => {
    let receivedBody = '';
    const port = await startFixtureServer(async (req, res) => {
      receivedBody = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await applyStagedIntent({
      port,
      token: 't',
      intentId: 'intent-1',
      override: true,
      reason: 'operator override',
      actorType: 'human',
    });

    expect(JSON.parse(receivedBody)).toEqual({
      override: true,
      reason: 'operator override',
      actorType: 'human',
    });
  });

  it('rejects a staged intent', async () => {
    let receivedPath = '';
    let receivedMethod = '';
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      receivedMethod = req.method ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await rejectStagedIntent({ port, token: 't', intentId: 'intent-1' });

    expect(receivedMethod).toBe('POST');
    expect(receivedPath).toBe('/api/staged-intents/intent-1/reject');
  });

  it('lists staged intents scoped by projectId', async () => {
    let receivedPath = '';
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ intents: [] }));
    });

    await listStagedIntents({ port, token: 't', projectId: 'proj-1' });

    expect(receivedPath).toBe('/api/staged-intents?projectId=proj-1');
  });

  it('surfaces a non-2xx status and error body on failure', async () => {
    const port = await startFixtureServer((_req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'blocked' }));
    });

    const result = await applyStagedIntent({
      port,
      token: 't',
      intentId: 'intent-1',
    });

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ error: 'blocked' });
  });
});
