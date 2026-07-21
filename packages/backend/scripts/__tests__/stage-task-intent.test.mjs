import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL('../stage-task-intent.mjs', import.meta.url),
);

let server;
let lastRequestBody;

beforeEach(async () => {
  lastRequestBody = null;
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      lastRequestBody = JSON.parse(data);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
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
      ORCHESTRATOR_STAGE_TOKEN: 'test-token',
    },
  });
}

describe('stage-task-intent.mjs', () => {
  it('includes a top-level decisionProposal in the POST body when supplied', async () => {
    await runScript([
      'task.setStatus',
      '{"taskId":"t-1","status":"Done"}',
      'group-1',
      'because the task is complete',
    ]);

    expect(lastRequestBody).toEqual({
      kind: 'task.setStatus',
      payload: { taskId: 't-1', status: 'Done' },
      groupId: 'group-1',
      decisionProposal: 'because the task is complete',
    });
  });

  it('omits decisionProposal from the POST body when absent', async () => {
    await runScript(['task.setStatus', '{"taskId":"t-1","status":"Done"}']);

    expect(lastRequestBody).toEqual({
      kind: 'task.setStatus',
      payload: { taskId: 't-1', status: 'Done' },
    });
    expect(lastRequestBody).not.toHaveProperty('decisionProposal');
  });
});
