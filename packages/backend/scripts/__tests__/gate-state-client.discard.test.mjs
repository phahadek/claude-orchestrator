import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { discardGateItem } from '../gate-state-client.mjs';

let server;

afterEach(async () => {
  if (server) {
    await new Promise((resolvePort) => server.close(resolvePort));
    server = undefined;
  }
});

describe('gate-state-client.mjs — discardGateItem', () => {
  it('POSTs reason and operator to the discard route', async () => {
    let seen;
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        seen = {
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          gateSession: req.headers['x-gate-session'],
          body: JSON.parse(data),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    const result = await discardGateItem({
      host: '127.0.0.1',
      port,
      token: 'tok',
      gateItemId: 'gi/1',
      reason: 'invalid by construction',
      operator: 'pedro',
    });

    expect(result.statusCode).toBe(200);
    expect(seen).toEqual({
      method: 'POST',
      url: '/api/gate/items/gi%2F1/discard',
      auth: 'Bearer tok',
      gateSession: undefined,
      body: { reason: 'invalid by construction', operator: 'pedro' },
    });
  });
});
