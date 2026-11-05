import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deferGateItem, appendGateItemEvent } from '../gate-state-client.mjs';

const CLIENT = fileURLToPath(new URL('../gate-state-client.mjs', import.meta.url));

let server;
let requests;

afterEach(async () => {
  if (server) {
    await new Promise((resolvePort) => server.close(resolvePort));
    server = undefined;
  }
});

async function startServer() {
  requests = [];
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        gateSession: req.headers['x-gate-session'],
        body: JSON.parse(data),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

function runCli(args, port) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLIENT, ...args],
      {
        env: {
          ...process.env,
          ORCHESTRATOR_DEVICE_TOKEN: 'tok',
          ORCHESTRATOR_BACKEND_HOST: '127.0.0.1',
          ORCHESTRATOR_BACKEND_PORT: String(port),
        },
      },
      (error, stdout, stderr) =>
        resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

describe('gate-state-client.mjs — deferGateItem', () => {
  it('POSTs a deferred event with evidence and operator, without X-Gate-Session', async () => {
    const port = await startServer();
    const result = await deferGateItem({
      host: '127.0.0.1',
      port,
      token: 'tok',
      gateItemId: 'gi/1',
      evidence: 'operator asked to defer',
      operator: 'pedro',
    });

    expect(result.statusCode).toBe(200);
    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/api/gate/items/gi%2F1/events',
        auth: 'Bearer tok',
        gateSession: undefined,
        body: {
          disposition: 'deferred',
          evidence: 'operator asked to defer',
          operator: 'pedro',
        },
      },
    ]);
  });

  it('omits operator when not given', async () => {
    const port = await startServer();
    await deferGateItem({
      host: '127.0.0.1',
      port,
      token: 'tok',
      gateItemId: 'gi-1',
      evidence: 'why',
    });
    expect(requests[0].body).toEqual({ disposition: 'deferred', evidence: 'why' });
  });

  it('CLI defer with missing or empty evidence exits non-zero and makes no request', async () => {
    const port = await startServer();
    const missing = await runCli(['defer', 'gi-1'], port);
    const empty = await runCli(['defer', 'gi-1', '  '], port);
    expect(missing.code).not.toBe(0);
    expect(empty.code).not.toBe(0);
    expect(missing.stderr).toContain('defer <gateItemId> <evidence>');
    expect(requests).toEqual([]);
  });

  it('CLI defer posts a deferred event', async () => {
    const port = await startServer();
    const out = await runCli(['defer', 'gi-1', 'because', 'pedro'], port);
    expect(out.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].gateSession).toBeUndefined();
    expect(requests[0].body).toEqual({
      disposition: 'deferred',
      evidence: 'because',
      operator: 'pedro',
    });
  });

  it('the event path still sends X-Gate-Session: 1', async () => {
    const port = await startServer();
    await appendGateItemEvent({
      host: '127.0.0.1',
      port,
      token: 'tok',
      gateItemId: 'gi-1',
      event: { disposition: 'pass', evidence: 'ok' },
    });
    expect(requests[0].gateSession).toBe('1');
  });
});
