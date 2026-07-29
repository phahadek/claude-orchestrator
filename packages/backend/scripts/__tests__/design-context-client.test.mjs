import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL('../design-context-client.mjs', import.meta.url),
);

let server;

afterEach(async () => {
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

describe('design-context-client.mjs — CLI', () => {
  it('prints the bundle and exits 0 on success', async () => {
    const bundle = { archSource: 'store', contextPages: [{ id: 'c1' }] };
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bundle));
    });
    await new Promise((resolvePort) =>
      server.listen(0, '127.0.0.1', resolvePort),
    );
    const { port } = server.address();

    const { stdout } = await runScript(['--milestone', 'M12', '--task', 't1'], {
      ORCHESTRATOR_BACKEND_HOST: '127.0.0.1',
      ORCHESTRATOR_BACKEND_PORT: String(port),
      ORCHESTRATOR_DEVICE_TOKEN: 'test-token',
    });

    expect(JSON.parse(stdout)).toEqual(bundle);
  });

  it('fails loudly with no partial bundle when ORCHESTRATOR_DEVICE_TOKEN is absent', async () => {
    const env = { ...process.env };
    delete env.ORCHESTRATOR_DEVICE_TOKEN;

    await expect(
      execFileAsync(
        'node',
        [scriptPath, '--milestone', 'M12', '--task', 't1'],
        {
          env,
        },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
    });
  });

  it('fails loudly with no partial bundle when the route is unreachable', async () => {
    await expect(
      runScript(['--milestone', 'M12', '--task', 't1'], {
        ORCHESTRATOR_BACKEND_HOST: '127.0.0.1',
        ORCHESTRATOR_BACKEND_PORT: '1', // nothing listens on port 1
        ORCHESTRATOR_DEVICE_TOKEN: 'test-token',
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
    });
  });

  it('fails loudly with no partial bundle when the route responds with an error status', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'design-context load failed' }));
    });
    await new Promise((resolvePort) =>
      server.listen(0, '127.0.0.1', resolvePort),
    );
    const { port } = server.address();

    await expect(
      runScript(['--milestone', 'M12', '--task', 't1'], {
        ORCHESTRATOR_BACKEND_HOST: '127.0.0.1',
        ORCHESTRATOR_BACKEND_PORT: String(port),
        ORCHESTRATOR_DEVICE_TOKEN: 'test-token',
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
    });
  });
});
