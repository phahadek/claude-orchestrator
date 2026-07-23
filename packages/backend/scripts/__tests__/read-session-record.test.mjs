import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL('../read-session-record.mjs', import.meta.url),
);

let server;
let lastRequestPath;
let lastAuthHeader;
let responseStatus;
let responseBody;

beforeEach(async () => {
  lastRequestPath = null;
  lastAuthHeader = null;
  responseStatus = 200;
  responseBody = {
    session: { session_id: 'target-1' },
    events: [],
    auditLog: [],
  };
  server = http.createServer((req, res) => {
    lastRequestPath = req.url;
    lastAuthHeader = req.headers['authorization'];
    res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function runScript(args) {
  const { port } = server.address();
  return execFileAsync('node', [scriptPath, ...args], {
    env: {
      ...process.env,
      ORCHESTRATOR_BACKEND_HOST: '127.0.0.1',
      ORCHESTRATOR_BACKEND_PORT: String(port),
      ORCHESTRATOR_STAGE_TOKEN: 'test-token',
    },
  });
}

describe('read-session-record.mjs', () => {
  it('GETs the loopback read endpoint for the named target session id, bearing the stage token', async () => {
    const { stdout } = await runScript(['target-1']);

    expect(lastRequestPath).toBe('/api/session-record-reads/target-1');
    expect(lastAuthHeader).toBe('Bearer test-token');
    expect(JSON.parse(stdout)).toEqual(responseBody);
  });

  it('exits non-zero when the backend responds 403 (capability not granted)', async () => {
    responseStatus = 403;
    responseBody = {
      error: 'capability not granted',
      code: 'capability_not_granted',
    };

    await expect(runScript(['target-1'])).rejects.toThrow();
  });

  it('fails fast without a target session id argument', async () => {
    await expect(runScript([])).rejects.toThrow();
  });
});
