import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchGroomContext } from '../../scripts/groom-context-client.mjs';

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

describe('groom-context-client.mjs — fetchGroomContext', () => {
  it('loads the GroomLoadResult bundle from GET /api/groom-context', async () => {
    let receivedPath = '';
    let receivedAuth = '';
    const bundle = {
      contextPages: [{ id: 'ctx-1', title: 'Context', markdown: 'body' }],
      board: [],
      neighbourBoards: [],
      targetTasks: [],
      codeWorklist: { 'packages/backend': ['a.ts', 'b.ts'] },
      gitFreshness: {},
      dependencyCandidates: [],
    };
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      receivedAuth = req.headers['authorization'] ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bundle));
    });

    const result = await fetchGroomContext({
      port,
      token: 'device-token-1',
      milestone: 'M12',
      project: 'proj-1',
    });

    expect(result.statusCode).toBe(200);
    expect(receivedPath).toBe(
      '/api/groom-context?milestone=M12&project=proj-1',
    );
    expect(receivedAuth).toBe('Bearer device-token-1');
    expect(JSON.parse(result.body)).toEqual(bundle);
  });

  it('surfaces a non-2xx status and the error body when the route fails', async () => {
    const port = await startFixtureServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'groom-context load failed' }));
    });

    const result = await fetchGroomContext({
      port,
      token: 'device-token-1',
      milestone: 'M12',
    });

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({
      error: 'groom-context load failed',
    });
  });

  it('omits the project query param when none is given', async () => {
    let receivedPath = '';
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });

    await fetchGroomContext({ port, token: 't', milestone: 'M12' });

    expect(receivedPath).toBe('/api/groom-context?milestone=M12');
  });
});
