import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL('../investigate-load.mjs', import.meta.url),
);

let server;
after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

const SNAPSHOT = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  project: { id: 'p', name: 'P', projectDir: '/x' },
  deployed: { sha: null, shortSha: null, recordedAt: null },
  activeMilestone: null,
  deployHint: 'hint',
  health: {
    erroredSessions: [],
    recentPlanningSessions: [],
    recentDeploys: [],
    needsAttentionPRs: [],
    recentAuditEvents: [],
  },
};

async function start(status, body) {
  server = http.createServer((req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

function run(port) {
  return execFileAsync(
    'node',
    [
      scriptPath,
      '--project',
      'p',
      '--db',
      '/nonexistent/none.db',
      '--remote',
      '--json',
      '--no-board',
      '--no-verify-prs',
    ],
    {
      env: {
        ...process.env,
        ORCHESTRATOR_BACKEND_HOST: '127.0.0.1',
        ORCHESTRATOR_BACKEND_PORT: String(port),
        ORCHESTRATOR_DEVICE_TOKEN: 'tok',
      },
    },
  );
}

describe('investigate-load.mjs backend route', () => {
  it('returns source backend-route with the snapshot keys', async () => {
    const port = await start(200, SNAPSHOT);
    const { stdout } = await run(port);
    const out = JSON.parse(stdout);
    assert.equal(out.source, 'backend-route');
    for (const k of ['project', 'deployed', 'deployHint', 'health', 'board'])
      assert.ok(k in out, k);
    await new Promise((r) => server.close(r));
    server = undefined;
  });

  it('exits non-zero naming the URL and status on a non-200', async () => {
    const port = await start(500, { error: 'boom' });
    await assert.rejects(run(port), (e) => {
      assert.notEqual(e.code, 0);
      assert.match(e.stderr, /investigate-snapshot/);
      assert.match(e.stderr, /HTTP 500/);
      return true;
    });
  });
});
