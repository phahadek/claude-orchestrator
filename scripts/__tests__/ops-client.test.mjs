import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL('../ops-client.mjs', import.meta.url),
);

let server;

after(async () => {
  if (server) {
    await new Promise((resolvePort) => server.close(resolvePort));
    server = undefined;
  }
});

function runScript(args, env) {
  return execFileAsync('node', [scriptPath, ...args], {
    env: { ...process.env, ...env },
  });
}

describe('ops-client.mjs — set-state output formatting', () => {
  it('prints the "<taskId> -> <state>" confirmation to stderr and the route JSON to stdout', async () => {
    const row = { taskId: 't1', state: 'resolved', disposition: null };
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(row));
    });
    await new Promise((resolvePort) =>
      server.listen(0, '127.0.0.1', resolvePort),
    );
    const { port } = server.address();

    const { stdout, stderr } = await runScript(
      ['set-state', '--task', 't1', '--state', 'resolved'],
      {
        ORCHESTRATOR_BACKEND_HOST: '127.0.0.1',
        ORCHESTRATOR_BACKEND_PORT: String(port),
        ORCHESTRATOR_DEVICE_TOKEN: 'test-token',
      },
    );

    assert.deepEqual(JSON.parse(stdout), row);
    assert.equal(stderr.trim(), 't1 -> resolved');
  });

  it('appends the disposition to the stderr confirmation when set', async () => {
    const row = { taskId: 't2', state: 'resolved', disposition: 'pass' };
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(row));
    });
    await new Promise((resolvePort) =>
      server.listen(0, '127.0.0.1', resolvePort),
    );
    const { port } = server.address();

    const { stdout, stderr } = await runScript(
      [
        'set-state',
        '--task',
        't2',
        '--state',
        'resolved',
        '--disposition',
        'pass',
      ],
      {
        ORCHESTRATOR_BACKEND_HOST: '127.0.0.1',
        ORCHESTRATOR_BACKEND_PORT: String(port),
        ORCHESTRATOR_DEVICE_TOKEN: 'test-token',
      },
    );

    assert.deepEqual(JSON.parse(stdout), row);
    assert.equal(stderr.trim(), 't2 -> resolved [pass]');
  });
});
