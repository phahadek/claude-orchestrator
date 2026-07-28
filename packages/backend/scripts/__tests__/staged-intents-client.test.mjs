import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL('../staged-intents-client.mjs', import.meta.url),
);

let server;
let lastRequestPath;
let lastRequestMethod;
let lastRequestBody;
let lastAuthHeader;
let responseStatus;
let responseBody;

beforeEach(async () => {
  lastRequestPath = null;
  lastRequestMethod = null;
  lastRequestBody = null;
  lastAuthHeader = null;
  responseStatus = 200;
  responseBody = { id: 'intent-1', state: 'approved' };
  server = http.createServer((req, res) => {
    lastRequestPath = req.url;
    lastRequestMethod = req.method;
    lastAuthHeader = req.headers['authorization'];
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      lastRequestBody = raw ? JSON.parse(raw) : null;
      res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
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
      ORCHESTRATOR_DEVICE_TOKEN: 'test-token',
    },
  });
}

describe('staged-intents-client.mjs usage', () => {
  it('lists all six subcommands when invoked with no command', async () => {
    let stderr = '';
    try {
      await runScript([]);
    } catch (err) {
      stderr = err.stderr ?? '';
    }
    for (const subcommand of [
      'create',
      'apply',
      'reject',
      'list',
      'approve',
      'group-commit',
    ]) {
      expect(stderr).toContain(subcommand);
    }
  });
});

describe('staged-intents-client.mjs approve', () => {
  it('POSTs /:id/approve, bearing the device token', async () => {
    const { stdout } = await runScript(['approve', 'intent-1']);

    expect(lastRequestMethod).toBe('POST');
    expect(lastRequestPath).toBe('/api/staged-intents/intent-1/approve');
    expect(lastAuthHeader).toBe('Bearer test-token');
    expect(JSON.parse(stdout)).toEqual(responseBody);
  });

  it('fails fast without an intent id', async () => {
    await expect(runScript(['approve'])).rejects.toThrow();
  });
});

describe('staged-intents-client.mjs group-commit', () => {
  it('POSTs /group/:groupId/commit with no override by default', async () => {
    await runScript(['group-commit', 'grp-1']);

    expect(lastRequestMethod).toBe('POST');
    expect(lastRequestPath).toBe('/api/staged-intents/group/grp-1/commit');
    expect(lastRequestBody).toEqual({});
  });

  it('passes --override <reason> through as override + reason', async () => {
    await runScript(['group-commit', 'grp-1', '--override', 'design flip']);

    expect(lastRequestBody).toEqual({
      override: true,
      reason: 'design flip',
    });
  });

  it('passes --actorType through', async () => {
    await runScript(['group-commit', 'grp-1', '--actorType', 'session']);

    expect(lastRequestBody).toEqual({ actorType: 'session' });
  });

  it('fails fast without a group id', async () => {
    await expect(runScript(['group-commit'])).rejects.toThrow();
  });
});

describe('staged-intents-client.mjs existing subcommands', () => {
  it('create still POSTs /api/staged-intents', async () => {
    await runScript([
      'create',
      'task.setDependsOn',
      '{"taskId":"t-1","dependsOn":[]}',
      'proj-1',
      'grp-1',
    ]);

    expect(lastRequestMethod).toBe('POST');
    expect(lastRequestPath).toBe('/api/staged-intents');
    expect(lastRequestBody).toEqual({
      kind: 'task.setDependsOn',
      payload: { taskId: 't-1', dependsOn: [] },
      projectId: 'proj-1',
      groupId: 'grp-1',
    });
  });

  it('apply still POSTs /:id/apply', async () => {
    await runScript(['apply', 'intent-1']);

    expect(lastRequestMethod).toBe('POST');
    expect(lastRequestPath).toBe('/api/staged-intents/intent-1/apply');
  });

  it('list still GETs /api/staged-intents', async () => {
    await runScript(['list']);

    expect(lastRequestMethod).toBe('GET');
    expect(lastRequestPath).toBe('/api/staged-intents');
  });
});

describe('staged-intents-client.mjs reject', () => {
  it('POSTs /:id/reject with outcome and reason in the body', async () => {
    await runScript([
      'reject',
      'intent-1',
      '--outcome',
      'decline',
      '--reason',
      'not needed',
    ]);

    expect(lastRequestMethod).toBe('POST');
    expect(lastRequestPath).toBe('/api/staged-intents/intent-1/reject');
    expect(lastRequestBody).toEqual({
      outcome: 'decline',
      reason: 'not needed',
    });
  });

  it('refuses client-side when --outcome is not pushback or decline', async () => {
    await expect(
      runScript([
        'reject',
        'intent-1',
        '--outcome',
        'bogus',
        '--reason',
        'because',
      ]),
    ).rejects.toThrow();
    expect(lastRequestPath).toBeNull();
  });

  it('refuses client-side when --reason is missing', async () => {
    await expect(
      runScript(['reject', 'intent-1', '--outcome', 'pushback']),
    ).rejects.toThrow();
    expect(lastRequestPath).toBeNull();
  });

  it('refuses client-side when --reason is blank', async () => {
    await expect(
      runScript([
        'reject',
        'intent-1',
        '--outcome',
        'pushback',
        '--reason',
        '   ',
      ]),
    ).rejects.toThrow();
    expect(lastRequestPath).toBeNull();
  });
});
