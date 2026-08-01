#!/usr/bin/env node
// Sanctioned session-side client for the device-authed abort route (see
// packages/backend/src/routes/taskAbort.ts). Retracts a mis-filed
// 🔲 Backlog task: flips it to ⏭️ Deferred with an implementation note, then
// kills the active groom-type session bound to it, if one exists. Restricted
// to tasks currently at Backlog — the backend rejects anything else with 400.
//
// Device-authed only, like gate-state-client.mjs / groom-flip-client.mjs —
// a dispatched session never holds a device token, so this only ever runs
// from an operator or RC (remote-control) session with
// $ORCHESTRATOR_DEVICE_TOKEN available.
//
// Usage:
//   node task-abort-client.mjs <projectId> <taskId> [note]
//
// Example:
//   node task-abort-client.mjs my-project notion-abc123 \
//     "Filed under the wrong milestone — refiling under M13."
//
// Env:
//   ORCHESTRATOR_BACKEND_HOST backend loopback host (default 127.0.0.1)
//   ORCHESTRATOR_BACKEND_PORT backend loopback port (default 3000; shared
//                             with the other sanctioned session clients)
//   ORCHESTRATOR_DEVICE_TOKEN device bearer token authorizing the request

import http from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * Issues the loopback POST /api/tasks/:id/abort request and resolves with
 * `{statusCode, body}`. Exported so tests can exercise it directly without
 * spawning a child process.
 */
export function requestTaskAbort({ host, port, token, taskId, payload }) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: host ?? '127.0.0.1',
        port: Number(port),
        path: `/api/tasks/${encodeURIComponent(taskId)}/abort`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 500, body: data });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const USAGE = 'usage: node task-abort-client.mjs <projectId> <taskId> [note]';

async function main() {
  function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }

  const [projectId, taskId, note] = process.argv.slice(2);
  if (!projectId || !taskId) {
    fail(USAGE);
    return;
  }

  const host = process.env.ORCHESTRATOR_BACKEND_HOST ?? '127.0.0.1';
  const port = process.env.ORCHESTRATOR_BACKEND_PORT ?? '3000';
  const token = process.env.ORCHESTRATOR_DEVICE_TOKEN;
  if (!token) {
    fail(
      'ORCHESTRATOR_DEVICE_TOKEN not set — this script must be run with a ' +
        'device credential available.',
    );
    return;
  }

  try {
    const payload = { projectId, ...(note ? { note } : {}) };
    const result = await requestTaskAbort({
      host,
      port,
      token,
      taskId,
      payload,
    });
    process.stdout.write(result.body + '\n');
    if (result.statusCode >= 400) process.exitCode = 1;
  } catch (err) {
    fail(`request failed: ${err.message}`);
  }
}

// Only run the CLI when this file is executed directly (`node
// task-abort-client.mjs ...`), not when imported by a test for the exported
// requestTaskAbort helper.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
