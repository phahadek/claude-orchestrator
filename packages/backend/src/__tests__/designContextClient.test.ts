import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchDesignContext } from '../../scripts/design-context-client.mjs';

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

function bundleWith(archSource: 'store' | 'notion') {
  return {
    task: {
      id: 't1',
      title: 'Task',
      status: 'Ready',
      type: '📐 Design',
      url: 'https://notion.so/t1',
    },
    markdown: '# Task',
    openQuestions: { items: [], source: 'none' },
    archSource,
    archUnits: [],
    unresolvedPageRefs: [],
    contextPages: [
      { id: 'ctx-1', title: '🗺️ Project Context', markdown: 'body' },
      { id: 'ctx-2', title: '🧩 Product Design Doc', markdown: 'body' },
    ],
    codeMapGrounding: {},
  };
}

describe('design-context-client.mjs — fetchDesignContext', () => {
  it('returns archSource: "store" for a store-adopted project, with contextPages carried', async () => {
    let receivedPath = '';
    let receivedAuth = '';
    const bundle = bundleWith('store');
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      receivedAuth = req.headers['authorization'] ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bundle));
    });

    const result = await fetchDesignContext({
      port,
      token: 'device-token-1',
      milestone: 'M12',
      task: 't1',
      project: 'proj-1',
    });

    expect(result.statusCode).toBe(200);
    expect(receivedPath).toBe(
      '/api/design-context?milestone=M12&task=t1&project=proj-1',
    );
    expect(receivedAuth).toBe('Bearer device-token-1');
    const parsed = JSON.parse(result.body);
    expect(parsed.archSource).toBe('store');
    expect(parsed.contextPages).toEqual(bundle.contextPages);
  });

  it('returns archSource: "notion" for a non-adopted project, with contextPages still carried', async () => {
    const bundle = bundleWith('notion');
    const port = await startFixtureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bundle));
    });

    const result = await fetchDesignContext({
      port,
      token: 'device-token-1',
      milestone: 'M12',
      task: 't1',
    });

    const parsed = JSON.parse(result.body);
    expect(parsed.archSource).toBe('notion');
    expect(parsed.contextPages).toEqual(bundle.contextPages);
  });

  it('surfaces a non-2xx status and the error body when the route fails', async () => {
    const port = await startFixtureServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'design-context load failed' }));
    });

    const result = await fetchDesignContext({
      port,
      token: 'device-token-1',
      milestone: 'M12',
      task: 't1',
    });

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({
      error: 'design-context load failed',
    });
  });

  it('omits the project query param when none is given', async () => {
    let receivedPath = '';
    const port = await startFixtureServer((req, res) => {
      receivedPath = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });

    await fetchDesignContext({
      port,
      token: 't',
      milestone: 'M12',
      task: 't1',
    });

    expect(receivedPath).toBe('/api/design-context?milestone=M12&task=t1');
  });
});
